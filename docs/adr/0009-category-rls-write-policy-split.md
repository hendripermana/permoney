# ADR-0009 — Category RLS write-policy split: app-role read-only over system categories

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-27     |
| **Accepted**      | 2026-05-27     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

Permoney's `Category` table holds two logically distinct row classes:

- **System categories** — global reference data shared across every tenant. `isSystem = true`, `familyId IS NULL`. Curated by privileged paths (migrations, seeds, future admin tools).
- **Tenant categories** — owned by a single family. `isSystem = false`, `familyId = <familyId>`. Created and edited by app traffic on behalf of authenticated users.

The original RLS migration (`20260510061500_enable_rls`) used a single `FOR ALL` policy with the predicate `familyId = current_setting('app.family_id')::text OR isSystem = true` for both `USING` and `WITH CHECK`. This was correct for SELECT (every tenant can read system + own tenant rows) but **unsafe for writes**:

| Attack via app role                                  | Why it slipped through          |
| ---------------------------------------------------- | ------------------------------- |
| `INSERT (isSystem=true, familyId=NULL)`              | `WITH CHECK` `OR isSystem=true` |
| `UPDATE tenant row → (isSystem=true, familyId=NULL)` | Both clauses satisfied          |
| `UPDATE seeded system row`                           | `USING` matches `isSystem=true` |
| `DELETE seeded system row`                           | `USING` matches `isSystem=true` |

A mis-coded server function or any privileged code path that ran as the app role could create or mutate global metadata visible to every tenant. This is a tenant-isolation and reference-data integrity gap, surfaced during the PER-16 review.

The decision must cover three layers: how the per-action RLS predicates split, how privileged paths are still allowed to maintain system categories, and how the schema layer guards against drift introduced by privileged paths themselves.

## Decision

**Split `Category` RLS into four per-action policies, lock app-role writes to tenant-owned non-system rows, and enforce the `(isSystem, familyId)` shape with a CHECK constraint at the schema layer.**

The runtime app role (created per integration test and provisioned by the production platform) never has `BYPASSRLS`. System-category curation flows through a privileged path that does — Postgres superuser in dev, dedicated migration role in production deploys.

### 1. SELECT policy

```sql
CREATE POLICY category_tenant_select ON "Category"
  FOR SELECT
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    OR ("isSystem" = true AND "familyId" IS NULL)
  );
```

System categories remain globally readable, including before any tenant context is established (`app.family_id` GUC unset → `current_setting(..., true)` returns `NULL`, the first disjunct is `NULL`, the second is `TRUE` for system rows). Tenant rows are gated to the matching family.

### 2. INSERT, UPDATE, DELETE policies

App-role writes are confined to tenant-owned non-system rows in both directions:

```sql
CREATE POLICY category_tenant_insert ON "Category"
  FOR INSERT
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  );

CREATE POLICY category_tenant_update ON "Category"
  FOR UPDATE
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  );

CREATE POLICY category_tenant_delete ON "Category"
  FOR DELETE
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  );
```

The split closes every attack in the table above:

- INSERT cannot create `isSystem=true` rows, regardless of GUC.
- UPDATE cannot escalate a tenant row into a system row (`WITH CHECK` rejects `isSystem=true`) and cannot mutate a system row at all (`USING` rejects `isSystem=true`).
- DELETE cannot remove system rows.

`ALTER TABLE "Category" FORCE ROW LEVEL SECURITY` keeps these policies in effect for the table owner too. Privileged maintenance must come through a `BYPASSRLS` role explicitly.

### 3. Schema-layer CHECK constraint

```sql
ALTER TABLE "Category"
  ADD CONSTRAINT category_system_familyid_consistency
  CHECK (
    ("isSystem" = true AND "familyId" IS NULL)
    OR ("isSystem" = false AND "familyId" IS NOT NULL)
  );
```

RLS only constrains the app role. The CHECK protects the same invariant against any privileged path that might produce malformed rows: seed scripts, future bank-sync mappers, AI enrichment workers, manual admin SQL, or a future agent that runs maintenance with elevated privileges. It also locks in the assumption baked into the SELECT policy (`AND "familyId" IS NULL`): every system row really has a `NULL` family.

The migration includes a fail-loud data repair pass that aborts if any pre-existing invariant-violating row is referenced by a `Transaction` or `SplitEntry`, then deletes orphaned violators before adding the constraint.

## Consequences

### Positive

- App-role traffic cannot create, mutate, or delete reference data shared across tenants.
- The `(isSystem, familyId)` invariant becomes a hard schema rule, not a convention. Every consumer of `Category` (server functions, smart-rule engine, future import-staging mappers) can rely on it.
- The pattern — split per-action RLS + matching CHECK — is the template for PER-103 (transfer graph DB invariants) and any future table that mixes global reference data with tenant-owned data.
- `vp run test:integration` proves the invariant via real-Postgres adversarial tests:
  - 4 app-role attacks (INSERT system, escalate tenant→system, UPDATE system row, DELETE system row) and 1 mirror downgrade (UPDATE system→tenant) all rejected.
  - SELECT reads system rows pre-tenant context; tenant rows are not visible without GUC.
  - CHECK constraint rejects malformed rows even via privileged INSERT.
- RED-then-GREEN evidence is reproducible: removing the migration directory makes the 4 adversarial tests fail with `promise resolved instead of rejecting`, restoring it brings the suite to 57/57.

### Negative

- Seed paths that create system categories must run as a role with `BYPASSRLS`. In dev this is the local `permoney` superuser; in production this is the dedicated migration runner. A non-`BYPASSRLS` runner will fail to seed system rows. Tracked as a separate ticket (split `prisma/seed.ts` into a privileged system-data path versus an app-tenant path).
- Tooling that previously treated `FOR ALL` as a single grant must now reason about four separate policies. Future RLS edits should follow the same per-action pattern instead of regressing to `FOR ALL`.
- Adding a CHECK constraint requires existing data to satisfy the invariant or be repaired in the same migration. The repair pass guards against silent ledger destruction (aborts on referenced violators), but a deployment with referenced bad data needs manual reconciliation before the migration can finish.

### Alternatives considered

1. **Keep `FOR ALL` and rely on application-layer Zod schemas** — rejected. Tenant isolation cannot live in app code alone; the M1.5 long-horizon standard explicitly forbids "good enough today" shortcuts in tenant boundaries.
2. **Move system categories to a separate table** — possible but far larger blast radius (server functions, FK relations from `Transaction.categoryId`, smart-rule outputs, audit log shape). Defer until ADR-0008 (Core Domain Model in M2.5) decides whether reference data deserves its own namespace; the split-policy approach gets the same isolation today without rewriting the ledger.
3. **CHECK constraint without RLS split** — closes privileged-path drift but does not block the four app-role attacks. RLS split alone leaves the schema invariant unguarded against privileged paths. Both layers are needed; doing one without the other is incomplete.

## References

- PER-102 (M2-20 — RLS hardening: system categories read-only for app traffic)
- ADR-0006 (Idempotency keys and audit-log architecture) — same defense-in-depth posture: app code must not be the only correctness mechanism.
- `prisma/migrations/20260527120000_harden_category_system_rls/migration.sql`
- `tests/integration/category-rls.integration.ts`
- Postgres docs: [Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html), [`FORCE ROW LEVEL SECURITY`](https://www.postgresql.org/docs/16/sql-altertable.html), [`BYPASSRLS`](https://www.postgresql.org/docs/16/sql-createrole.html).
