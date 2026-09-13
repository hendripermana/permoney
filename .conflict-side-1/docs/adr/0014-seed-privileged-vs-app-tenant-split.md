# ADR-0014 — Seed split: privileged system-data phase vs app-tenant phase

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-30     |
| **Accepted**      | 2026-05-30     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

`prisma/seed.ts` was a single `prisma.$transaction` that mixed two role concerns under one connection while `app.family_id` was set to a demo family:

1. **Privileged maintenance** — `INSERT` of global system categories (`isSystem = true`, `familyId IS NULL`). Reference data shared by every tenant.
2. **Tenant fixture** — a demo `Family / User / Account / Merchant` and tenant-owned `Category` rows for local development.

After ADR-0009 (PER-102) split `Category` RLS into per-action policies, added the `category_system_familyid_consistency` CHECK, and ran `FORCE ROW LEVEL SECURITY`, the system-category inserts can only satisfy a write policy that demands `familyId = app.family_id AND isSystem = false`. A row with `isSystem = true, familyId = NULL` cannot satisfy that predicate regardless of GUC. The seed kept working in dev for one reason only: the local `permoney` role is `rolsuper = t, rolbypassrls = t`, so RLS is bypassed implicitly.

ADR-0009 § Consequences flagged this explicitly: _"Seed paths that create system categories must run as a role with `BYPASSRLS` … A non-`BYPASSRLS` runner will fail to seed system rows. Tracked as a separate ticket."_ That ticket is PER-110.

The risk is systemic, not cosmetic. A managed-Postgres production deploy (Neon, Supabase, RDS) runs migrations and data bootstrap under a role that does **not** have `BYPASSRLS`. The current seed silently succeeds in dev and silently fails the moment it runs against a hardened role. Every later M2 constraint (PER-104, PER-20, PER-18) thickens the same latent debt. The seed is also the closest existing model of a privileged write path, so the mechanism chosen here is the template every future privileged bootstrap path (admin tooling, reference-data migrations, bank-sync category mappers) must follow.

The decision must answer one hard question precisely: **how does a `NOBYPASSRLS` role legitimately write `isSystem = true` rows without re-opening the PER-102 hole that lets app traffic do the same?**

### Empirical investigation of the mechanism

The ticket proposed a `set_config('app.bypass_rls', 'true', true)` GUC convention. This was tested against local Postgres 16.13 before any code was written and **rejected as insecure**:

- A dotted custom GUC such as `app.bypass_rls` is a Postgres _placeholder_ parameter. `REVOKE SET ON PARAMETER "app.bypass_rls" FROM PUBLIC` does **not** stop a `NOBYPASSRLS` app role from running `SET app.bypass_rls = 'on'` or `set_config('app.bypass_rls', 'on', true)`. The app role sets it freely.
- An RLS maintenance policy gated on `current_setting('app.bypass_rls')` would therefore let any app-role code path flip the GUC and insert or mutate global system categories — exactly the cross-tenant reference-data attack PER-102 closed. A GUC is forgeable by the role it is meant to gate.

The same probe confirmed the chosen mechanism works under `NOBYPASSRLS`: a role that is a **member of a dedicated group role** carrying a role-targeted RLS policy can write system rows, while a non-member app role cannot. Role membership is enforced by Postgres and cannot be assumed by a role that was not granted it. Unlike a GUC, role identity is not forgeable from inside a query.

## Decision

**Split the seed into two phases with distinct Postgres role identities, and grant system-category write capability through a role-targeted RLS maintenance policy on a `NOLOGIN` group role — never through `BYPASSRLS` and never through a forgeable GUC.**

### 1. Role-targeted maintenance policy (migration `20260530140000_category_system_maintenance_role`)

```sql
-- Idempotent group role. NOLOGIN: it is a privilege holder, not a login identity.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permoney_system_maintainer') THEN
    CREATE ROLE permoney_system_maintainer NOLOGIN;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "Category" TO permoney_system_maintainer;

-- Permissive, role-targeted policy: members may write ONLY well-formed system rows.
CREATE POLICY category_system_maintenance ON "Category"
  FOR ALL
  TO permoney_system_maintainer
  USING ("isSystem" = true AND "familyId" IS NULL)
  WITH CHECK ("isSystem" = true AND "familyId" IS NULL);

-- The role that runs this migration becomes a member, so a single privileged
-- deploy role can both migrate and seed. The app runtime role is never granted
-- membership.
GRANT permoney_system_maintainer TO CURRENT_USER;
```

`category_system_maintenance` is **permissive** and scoped `TO permoney_system_maintainer`. RLS permissive policies are OR-ed, so a maintainer member gets the union of the base tenant policies (ADR-0009) plus this one. The net effect:

- A maintainer member may write rows where `isSystem = true AND familyId IS NULL` (this policy), and is still subject to the `category_system_familyid_consistency` CHECK, so it cannot create malformed system rows.
- The app runtime role is **not** a member, so this policy never applies to it. The PER-102 INSERT/UPDATE/DELETE policies remain its only write path — tenant non-system rows only. The hole stays closed.
- `FORCE ROW LEVEL SECURITY` from PER-102 is unchanged; the maintenance policy is how a non-owner, `NOBYPASSRLS` role legitimately writes system rows under FORCE.

The `WITH CHECK` clause keeps maintenance system-only: a maintainer cannot use this policy to write tenant rows. (A maintainer that also set `app.family_id` could write a tenant row via the inherited base policy, but the seed's privileged phase never sets that GUC and only writes system rows. The maintainer role is a trusted bootstrap identity, not app traffic.)

### 2. Two-phase seed

```
prisma/seed.ts              # orchestrator: phase 1 → phase 2
prisma/seed/system-data.ts  # privileged phase  (raw pg.Client)
prisma/seed/app-tenant.ts   # app-tenant phase  (Prisma adapter)
```

**Phase 1 — privileged system data.** A raw `pg.Client` connects via `PERMONEY_SEED_PRIVILEGED_DATABASE_URL` (falling back to `DATABASE_URL` in dev). It upserts the two system categories with **deterministic primary keys** so the operation is idempotent:

```sql
INSERT INTO "Category" (id, name, type, color, icon, "isSystem", "familyId")
VALUES ($1, $2, $3, $4, $5, true, NULL)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, ...
```

Deterministic IDs (`system-category-food-drink`, `system-category-salary`) are the idempotency key. The previous seed used `cuid()`, which produced a fresh row every run — the source of the duplicate system categories observed in the drifted dev DB. Phase 1 writes **no** tenant data.

**Phase 2 — app-tenant fixture.** The Prisma `@prisma/adapter-pg` client connects via `DATABASE_URL` as the runtime app role and runs inside `prisma.$transaction`, setting `app.family_id` with `set_config(..., true)` exactly as a production server function does. It creates the demo `Family / User / Account / Merchant` and tenant-owned `Category` rows. No `BYPASSRLS`, no privileged escape hatch, no system-row writes. This phase is the contract a real authenticated mutation obeys.

The orchestrator runs phase 1 then phase 2 sequentially. `vp run db:seed` stays one command for developer experience.

### 3. Deployment contracts

**Local dev.** `permoney` is superuser, so phase 1 succeeds whether or not the migration ran; the `GRANT ... TO CURRENT_USER` line still makes the dev role a member so dev exercises the same policy path conceptually. `PERMONEY_SEED_PRIVILEGED_DATABASE_URL` is unset; both phases fall back to `DATABASE_URL`. `vp run db:seed` works on a fresh `vp run db:migrate` database.

**CI integration harness.** Unchanged in mechanism. The harness applies migrations through the admin (superuser in CI) connection and creates a separate `NOBYPASSRLS` `<db>_app` role for Prisma. The new `category_system_maintenance` policy and group role are created by the migration like any other DDL. Existing privileged seeding in `category-rls.integration.ts` uses the admin connection (superuser, bypasses RLS) and is untouched. The new `seed-split.integration.ts` proves the stricter path: a dedicated `NOBYPASSRLS` role that is a member of `permoney_system_maintainer` runs phase 1 successfully, and a non-member app role is rejected.

**Managed-Postgres production.** The deploy operator must satisfy two requirements, both documented in `.env.example`:

1. The role that runs `prisma migrate deploy` either has `CREATEROLE` (so the migration can create `permoney_system_maintainer`) **or** the platform pre-creates `permoney_system_maintainer` and grants it to the migration runner before deploy. The migration's `IF NOT EXISTS` guard makes the pre-created case a no-op.
2. The role behind `PERMONEY_SEED_PRIVILEGED_DATABASE_URL` is a member of `permoney_system_maintainer`. If migrations and seed run under the same privileged role, `GRANT ... TO CURRENT_USER` already satisfies this and `PERMONEY_SEED_PRIVILEGED_DATABASE_URL` can be left unset (falls back to `DATABASE_URL`). The app runtime role behind the production `DATABASE_URL` must **not** be a member.

No `ALTER ROLE ... BYPASSRLS` is ever required. That is the whole point: the production seed path runs under a `NOBYPASSRLS` role.

### 4. Idempotency and audit

Re-running the seed is safe. Phase 1 `ON CONFLICT` keeps exactly one row per system category and cannot violate the CHECK constraint (the values are well-formed by construction). Phase 2 reuses the existing demo `Family` by fixed id and clears its tenant rows inside the same transaction before recreating them, so a re-run does not accumulate duplicates. The demo seed is a dev fixture, not a production mutation path; it does not write `AuditLog` rows, consistent with the prior seed. Production tenant data is created by guided onboarding (`onboarding-service.ts`), which already writes audit rows — the seed deliberately does not duplicate that path.

## Consequences

### Positive

- The seed no longer depends on `BYPASSRLS`. A managed-Postgres production deploy under a `NOBYPASSRLS` role succeeds without manual role surgery. The latent production failure ADR-0009 flagged is retired.
- System-category write capability is expressed as **Postgres role membership**, not a forgeable GUC. The PER-102 isolation boundary holds: app traffic still cannot create, mutate, or delete reference data.
- The two phases have distinct, named role identities. The privileged path and the tenant path can no longer be conflated by accident in a single transaction.
- Deterministic system-category IDs make the privileged phase truly idempotent and fix the duplicate-row drift the `cuid()` seed produced.
- The mechanism is the reusable template for every future privileged bootstrap path: grant the group role, write through the maintenance policy, never reach for `BYPASSRLS`.
- Real-Postgres integration tests prove the contract: a `NOBYPASSRLS` member runs the privileged phase; a non-member app role is rejected; re-runs do not duplicate; the phases write disjoint row classes.

### Negative

- Production deploy now has an explicit role-provisioning prerequisite (`CREATEROLE` on the migration runner, or a pre-provisioned group role). This is documented but is one more operational contract for the platform operator to honor. It is the irreducible cost of not using `BYPASSRLS`.
- A new env var (`PERMONEY_SEED_PRIVILEGED_DATABASE_URL`) exists, though it is optional and falls back to `DATABASE_URL`.
- The seed is now three files instead of one. The orchestrator indirection is the price of separating the two role concerns cleanly.

### Alternatives considered

1. **`set_config('app.bypass_rls', 'true')` GUC + RLS policy gated on it** (the ticket's initial suggestion). **Rejected — insecure.** Empirically verified: a dotted custom GUC is a placeholder parameter, and `REVOKE SET ON PARAMETER ... FROM PUBLIC` does not prevent a `NOBYPASSRLS` app role from setting it. The app role could flip the GUC and write system rows, re-opening the PER-102 hole. A GUC is forgeable by the role it is meant to gate; role membership is not.
2. **Keep one phase, `ALTER ROLE permoney BYPASSRLS` in production.** Rejected. Requires `BYPASSRLS` on a role that also serves app traffic (or a manual role swap at deploy time), which is exactly the fragility PER-110 exists to remove. Managed providers discourage or forbid `BYPASSRLS` on application roles.
3. **Seed system categories via raw SQL inside a Prisma migration (`migrate deploy` does the data write).** Rejected as the primary mechanism. Reference data that may evolve (new system categories, renamed categories) does not belong frozen in migration history; mixing data seeding into schema migrations couples two lifecycles and makes idempotent updates awkward. The migration owns the _role and policy_ (schema-level), while the seed owns the _data_ (idempotent upsert). That said, the role-targeted policy makes a future data-migration path safe if one is ever wanted.
4. **Move system categories to a separate, non-RLS table.** Rejected here for the same reason as ADR-0009 § Alternatives: far larger blast radius (FK from `Transaction.categoryId`, smart-rule outputs, audit shape). Deferred to ADR-0008 (M2.5 core domain). The role-targeted policy delivers the isolation today without rewriting the ledger.
5. **Grant the app role `permoney_system_maintainer` membership.** Rejected — it would defeat the entire purpose by handing app traffic the system-write capability. Only the privileged seed/migration identity is ever a member.

## References

- PER-110 (M2 — Split `prisma/seed.ts` into privileged system-data path vs app-tenant path)
- ADR-0009 (Category RLS write-policy split) — § Consequences names this seed dependency as the follow-up ticket
- ADR-0006 (Idempotency + AuditLog) — same defense-in-depth posture
- ADR-0011 (App-level tenant reference validation) — the app-tenant phase obeys the same reference contract
- `prisma/migrations/20260530140000_category_system_maintenance_role/migration.sql`
- `prisma/seed.ts`, `prisma/seed/system-data.ts`, `prisma/seed/app-tenant.ts`
- `tests/integration/seed-split.integration.ts`
- Postgres docs: [Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) (policy `TO role`), [`CREATE ROLE`](https://www.postgresql.org/docs/16/sql-createrole.html), [`GRANT`](https://www.postgresql.org/docs/16/sql-grant.html), [`ALTER DEFAULT PRIVILEGES` / parameter privileges](https://www.postgresql.org/docs/16/sql-grant.html#SQL-GRANT-DESCRIPTION-PARAMETERS).
