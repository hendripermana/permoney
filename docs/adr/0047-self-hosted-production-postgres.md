# ADR-0047 — Production Postgres = self-hosted (VM Docker), amending ADR-0003's VPS rejection

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-07-18     |
| **Accepted**      | 2026-07-18     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

ADR-0003 locked Postgres as the storage engine and, in its "Alternatives considered" section, explicitly rejected self-hosted Postgres on a VPS:

> **D. Self-hosted Postgres on a VPS** — Rejected. Adds backups / replication / version upgrades / monitoring as our ops responsibility. Managed Postgres at small scale is genuinely cheaper than the engineering hours we'd burn doing it ourselves.

PER-192 (production deployment, `permana.icu`) surfaced a fact ADR-0003 didn't have in April 2026: the deployment target is not a fresh VPS provisioned for this decision — it's an Oracle Cloud VM (4 vCPU / 24GB RAM / 200GB disk) the creator already owns, already operates, and already runs a second full production app on (Sure, at `finance.permana.icu`, five weeks uptime at the time of this ADR). The marginal ops cost of one more self-hosted Postgres instance on a box already being administered is materially different from ADR-0003's framing of "engineering hours we'd burn doing it ourselves" as a cost paid from zero.

The deciding factor is deployment shape, not a reversal of ADR-0003's general reasoning: this is a **single-tenant** deployment (the creator's family only; PER-192 explicitly excludes public multi-user signup). ADR-0003's case for managed Postgres — concurrent writers, multi-tenant SaaS roadmap, analytics at scale, compliance attestations for enterprise customers — is real, but it is a case for where Permoney is headed, not where this specific deployment needs to be today.

## Decision

**Production Postgres for `permana.icu` is self-hosted via Docker Compose on the same Oracle VM that runs Sure**, with the ops-burden objections ADR-0003 raised answered directly rather than waived:

1. **Version pin = the version the integration-test harness already runs against.** `docker-compose.yml` (dev) and `tests/integration/support/database.ts` both run `postgres:16-alpine`. Production pins **Postgres 16** (full `postgres:16` image, not `-alpine`, for complete `pg_dump`/`pg_restore`/locale tooling). No dev/prod version drift — ADR-0003 §"Dev/prod parity" still holds.
2. **Full isolation from Sure and from the existing dev Postgres**, all three of which now live on one VM: separate Docker Compose project, separate network, separate named volume. **No host port is published** for the production database (unlike the dev Postgres on `:5433` and Sure's on `:5435`, both host-published today) — it is reachable only from the app container over the internal Compose network. This is a stricter posture than either existing instance on the box.
3. **Non-superuser, non-bypassrls runtime role**, provisioned with the exact grant shape `tests/integration/support/database.ts`'s `createRuntimeRole` already proves out in CI: `CREATE ROLE ... LOGIN PASSWORD`, `GRANT CONNECT`/`USAGE`, `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` on tenant tables, `AuditLog` UPDATE/DELETE/TRUNCATE explicitly revoked, verified via the same `rolsuper = false AND rolbypassrls = false` assertion the test harness runs before trusting a role. RLS is the tenant fence; this ADR does not weaken that in any way for the self-hosted case.
4. **`prisma migrate deploy` on release**, run by a role that is either `CREATEROLE` (to satisfy the `permoney_system_maintainer` migration, per `.env.example`'s documented contract) or pre-granted membership in that role.
5. **Backups are not hand-waved.** ADR-0003 Alternative D named backups as an unaccounted cost; this ADR closes that gap explicitly: automated daily `pg_dump`, off-box retention (Cloudflare R2, distinct credentials from any prior leaked/legacy token), and — non-negotiable — an actually-executed test restore before this ADR is considered satisfied, not just a written runbook procedure. See `docs/runbook-production.md`.
6. **Version upgrades and monitoring remain the creator's responsibility**, same as they already are for Sure's self-hosted Postgres 18 on the same box. No new operational skill is required — it's the same skill already being exercised.

### Explicit reversal triggers

This decision is scoped to the current deployment shape. Revert to managed Postgres (Neon/Supabase, per ADR-0003 §4) when **any** of the following becomes true:

- Permoney gains a second real tenant/operator beyond the creator's family — the "single-tenant, one-person-ops" premise this ADR relies on no longer holds.
- A multi-region or HA requirement emerges that a single VM cannot satisfy.
- The Oracle VM's capacity or reliability becomes a bottleneck for either app running on it (Sure or Permoney).
- The creator's ongoing time cost of self-hosted DB ops (patching, monitoring, backup verification) measurably exceeds the cost delta of a managed provider — i.e., ADR-0003's original cost argument starts being true in practice, not just in theory.

When any trigger fires, migration back to managed Postgres is a `pg_dump | psql` operation (ADR-0003 §"Vendor lock-in" already established this has no lock-in cost beyond standard SQL).

## Consequences

### Positive

- Zero new vendor relationship, zero new billing surface, zero new network-egress dependency for a single-tenant deployment.
- Dev/prod/integration-test version parity is exact (Postgres 16 everywhere), stronger than ADR-0003's "16+" range.
- Reuses infrastructure and operational muscle memory already proven for five-plus weeks on Sure's self-hosted Postgres 18 on the same box.
- Backups get a concretely tested restore procedure as a hard requirement of this ADR, not a future TODO — arguably stronger backup discipline than defaulting to "the managed provider handles it."

### Negative / costs

- Version upgrades, monitoring, and disaster recovery are the creator's responsibility, exactly as ADR-0003 warned. Accepted explicitly, not silently.
- No automatic read replica, point-in-time recovery, or multi-region failover that a managed provider would provide out of the box. For a single-family deployment this is judged acceptable; it is one of the named reversal triggers above.
- Single VM is a single point of failure for both Sure and Permoney simultaneously. Mitigated by daily off-box backups (R2) with tested restore, not by infrastructure redundancy.

### Neutral

- ADR-0003's general-case reasoning (managed Postgres for a multi-tenant SaaS trajectory) is unchanged and remains the target architecture if/when the reversal triggers fire. This ADR does not touch `provider = "postgresql"`, the `@prisma/adapter-pg` driver, or the migration tree — only _where_ the Postgres 16 instance backing production runs.

## Alternatives considered

### A. Managed Postgres (Neon/Supabase), per ADR-0003 as originally written

Rejected for _this_ deployment specifically. Onboarding a new managed-provider account, billing relationship, and network-egress dependency is a fixed cost that doesn't amortize over a single-tenant deployment the way it would over a multi-tenant SaaS. ADR-0003's reasoning remains correct for that future shape — see reversal triggers above for when to revisit.

### B. Self-hosted Postgres sharing Sure's existing Postgres 18 instance/container

Rejected. Violates tenant/service isolation for no benefit — Sure and Permoney are different applications with different schemas, different migration histories, and different failure domains. A shared instance means a Permoney migration mistake or connection-pool exhaustion can take down Sure, which PER-192 explicitly requires to stay undisturbed during the transition.
