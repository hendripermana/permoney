# ADR-0003 — Production database = managed Postgres (Postgres 16+), with Docker Compose for dev parity

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-04-26     |
| **Accepted**      | 2026-04-26     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

The Apr 2026 deep-audit (`/home/ubuntu/.windsurf/plans/deep-audit-3bf464.md`) flagged P0-B "Production DB story is undefined." The project shipped with `provider = "sqlite"` and `@prisma/adapter-libsql`, which works but ties production scaling and feature evolution to whatever the libSQL ecosystem ships next. The audit's original recommendation was managed Postgres; an earlier draft of this ADR briefly pivoted to Turso before being reverted at the user's direction. This is the second-and-final pass.

The decision in this ADR is therefore not "should we pivot to Postgres" but "what is the right shape of the Postgres adoption."

## Decision

**Production database = managed Postgres (Postgres 16+).** The same engine runs in development via Docker Compose, so dev and prod execute the same SQL dialect, the same `BIGINT` semantics, and the same migration history — there is exactly one migration tree, one driver, one schema provider.

Concrete shape:

1. **Driver:** `@prisma/adapter-pg@7.8.0` (matches Prisma 7 baseline). The browser-side `pg` package is the canonical Postgres client; it is used directly by the adapter under the hood.
2. **Schema:** `provider = "postgresql"` in `prisma/schema.prisma`. Per Prisma 7 rules, the `url` is **not** declared in the schema — Prisma reads it from `prisma.config.ts` for migrations and from `process.env.DATABASE_URL` at runtime via the adapter.
3. **Local dev:** `docker-compose.yml` runs `postgres:16-alpine` on host port `5433` (not `5432`, to coexist with any system-installed Postgres). Bring up with `vp run db:up`; bring down with `vp run db:down`; wipe data with `vp run db:nuke`. Connection string: `postgres://permoney:permoney@localhost:5433/permoney`.
4. **Production:** any managed Postgres (Neon / Supabase / RDS / Fly Postgres) — picked at deploy time via `DATABASE_URL`. TLS mandatory: append `?sslmode=require` (or `?sslmode=verify-full` with a CA bundle).
5. **Boot-time validator** in `src/server/db.server.ts` rejects any URL whose scheme isn't `postgres://` / `postgresql://`, naming the actual offender (e.g. legacy `file:` or `libsql:` URLs from earlier setups). This is the same fail-fast pattern documented in ADR-0002 — wrong configuration crashes immediately with an actionable message rather than producing an opaque error on the first query.

### What changed mechanically

- Added: `@prisma/adapter-pg`, `pg`, `@types/pg`, `docker-compose.yml`.
- Removed: `@prisma/adapter-libsql`, `@libsql/client`, `prisma/dev.db`, the SQLite migration history under `prisma/migrations/`.
- Rewritten: `src/server/db.server.ts` (adapter swap + Postgres-only URL validator, defense-in-depth comments preserved verbatim), `prisma/seed.ts` (adapter swap, log line translated to English).
- New migration: `prisma/migrations/20260426151339_init/migration.sql` is a fresh Postgres-native init that includes the schema **plus** all 10 strategic indexes from the audit (formerly carried in a separate SQLite migration that was deleted).

### Why managed Postgres is right for this product

| Factor                   | Outcome                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Concurrent writes**    | Postgres MVCC absorbs thousands of concurrent writers. SQLite/libSQL is single-writer per database; for a multi-tenant SaaS-shaped roadmap, this is the binding constraint, not BigInt range or query throughput.                                                                           |
| **BigInt money columns** | Native `int8` (8-byte signed). Range ±9.2 × 10¹⁸. Fully native arithmetic with `+`/`*`/`SUM()`. ADR-0001's bigint minor-unit decision survives intact.                                                                                                                                      |
| **Future analytics**     | LATERAL joins, window functions, materialised views, partitioning, `pg_trgm` for fuzzy search, `tsvector` for full-text, JSONB with GIN indexing. Personal-finance roadmap items like "merchant fuzzy match," "OCR'd receipt search," "year-over-year trends" are all in-scope on Postgres. |
| **Ecosystem**            | 30+ years of tooling: `pgbouncer`/`pgcat`, `pg_dump`/`pg_restore`, `pgwatch`, `auto_explain`, every observability vendor's first-class integration. The "MAANG-grade ops surface" exists and is mature.                                                                                     |
| **Compliance**           | Neon, Supabase, AWS RDS all carry SOC 2 Type II + ISO 27001 + HIPAA-eligible variants. If a future enterprise customer demands an attestation, we point at the provider's existing certificates.                                                                                            |
| **Dev/prod parity**      | Same dialect, same `BIGINT` storage semantics, same index plans. `docker compose up` is one command. What passes locally passes in prod.                                                                                                                                                    |
| **Vendor lock-in**       | Postgres is open-source with multiple managed providers. Migrating between providers is a `pg_dump                                                                                                                                                                                          | psql` command. There is no lock-in beyond the SQL standard itself. |

The two costs of this decision, named honestly:

1. **Docker is required for local dev.** A trade we accept; Docker is table-stakes for any team. The `docker-compose.yml` is 60 lines including comments.
2. **Read latency from a single-region Postgres is higher than Turso edge replicas.** Mitigated by (a) Neon/Supabase regions in Singapore matching Turso's, (b) read replicas on managed providers, (c) the read path being short — most pages need a single round trip. Empirically, a Singapore Neon read from Jakarta is ~30-50ms p50, identical order of magnitude to Turso.

### Why dev parity matters here specifically

Permoney is a financial ledger; ADR-0001 already proved that money arithmetic precision drives correctness. Running SQLite in dev and Postgres in prod would introduce a parity gap at the **storage layer** — which is exactly where ADR-0001 said precision must be airtight. A `BIGINT` semantic difference, an index plan difference, or a migration-dialect discrepancy could let a "works on my machine" balance bug cross into prod silently. Dev=prod parity in storage is the cheapest insurance against that class of bug.

## Consequences

### Positive

- One migration tree, one driver, one schema provider. The mental model is small.
- Boot-time URL validation prevents a deploy with an unset or wrong-scheme `DATABASE_URL` from limping through to a runtime error — failures land at process start with the env-var name and a copy-pasteable fix.
- All 10 strategic indexes from the audit P0-B fix are preserved in the new Postgres init migration.
- `BigInt` columns are now native `int8`, eliminating any SQLite-specific quirks.
- Future Postgres-only features (LATERAL, GIN-indexed JSONB, partitioning) are unlocked without a second migration.

### Negative / costs

- Docker becomes a hard dev dependency. Previously a contributor could `vp dev` against an embedded `dev.db`; now they must `vp run db:up` first. The `db:up`/`db:down`/`db:nuke` scripts make this scriptable; CI documentation will assume Postgres availability.
- The seed script connects directly via its own `PrismaPg` instance instead of going through `src/server/db.server.ts`. This is intentional — scripts run outside the TanStack Start runtime — but it means the boot-time URL validator and the SECURITY BREACH trap in `db.server.ts` don't apply to seed runs. Mitigated by the seed's own `if (!dbUrl) throw` guard.
- The previous SQLite migration history (3 migrations) is deleted from the repo. Pre-ADR-0003 dev environments cannot be replayed forward; everyone needs to re-`db:up` and re-seed. We accept this because there is no production data yet.

### Neutral

- The audit's P0-B is closed.

## Implementation

### File-by-file impact

| File                                     | Change                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`                     | New. `postgres:16-alpine`, port `5433`, named volume, `pg_isready` healthcheck.                                                                                 |
| `prisma/schema.prisma`                   | `provider = "postgresql"`. `url` removed (Prisma 7 deprecates it in schema).                                                                                    |
| `prisma/migrations/`                     | All SQLite migrations deleted. Single new `20260426151339_init` generated against live Postgres. Includes all schema + the 10 indexes from the prior audit fix. |
| `prisma/migrations/migration_lock.toml`  | Now declares `provider = "postgresql"`.                                                                                                                         |
| `prisma/seed.ts`                         | Adapter swap (`PrismaLibSql` → `PrismaPg`). Indonesian comment translated.                                                                                      |
| `src/server/db.server.ts`                | Adapter swap. New `validatePostgresUrl()` helper rejects non-`postgres://` URLs at boot with actionable errors. Defense-in-depth comments preserved verbatim.   |
| `prisma/dev.db`, `prisma/dev.db-journal` | Deleted (no longer applicable).                                                                                                                                 |
| `package.json` `dependencies`            | `+ @prisma/adapter-pg`, `+ pg`. `- @prisma/adapter-libsql`, `- @libsql/client`.                                                                                 |
| `package.json` `devDependencies`         | `+ @types/pg`.                                                                                                                                                  |
| `package.json` `scripts`                 | New: `db:up`, `db:down`, `db:nuke`. Existing `db:*` scripts unchanged.                                                                                          |
| `.env`                                   | Default `DATABASE_URL=postgres://permoney:permoney@localhost:5433/permoney`.                                                                                    |
| `.env.example`                           | Rewritten Postgres prod section with Neon + Supabase example URLs, TLS guidance.                                                                                |

### How to run locally

```bash
vp run db:up          # docker compose up -d postgres
vp exec prisma migrate dev    # apply migrations to the local DB
vp run db:seed                # populate Family / User / Account fixtures
vp dev                # http://localhost:3006
```

`vp run db:nuke` (= `docker compose down -v`) wipes the volume — useful when iterating on migration SQL.

### Production deployment playbook

1. Provision the database. For Neon:
   ```bash
   neonctl projects create --name permoney-prod
   neonctl connection-string --pooled  # → postgres://...sslmode=require
   ```
2. Set deploy-environment secrets:
   ```
   DATABASE_URL=postgres://...?sslmode=require
   ```
3. Apply migrations as part of the deploy pipeline:
   ```bash
   vp exec prisma migrate deploy
   ```
4. Smoke-test by hitting any read endpoint; the URL validator runs at first DB access (lazy proxy) and fails fast if misconfigured.

## Verification

- `vp run check` — fmt + lint + typecheck + no-use-effect guard, all green.
- `vp test run` — 154 / 154 pass.
- `vp build` — production bundle generated.
- `prisma migrate dev --name init` — migration applied cleanly to live Postgres 16 in Docker.
- `prisma db seed` — completed: 1 Family, 1 User, 3 Accounts in Postgres.
- `psql -c "SELECT count(*) FROM \"Account\""` — returned 3, confirming end-to-end roundtrip through the Postgres adapter.
- Adversarial: setting `DATABASE_URL=file:./prisma/dev.db` and importing `db.server.ts` crashes immediately with the documented Postgres-required error.

## Alternatives considered

### A. Stay on SQLite (libSQL) via Turso for production

Briefly explored in an earlier draft of this ADR. Rejected because:

- Single-writer per database is a real cap for any multi-tenant SaaS evolution.
- libSQL lacks the analytic operators (LATERAL, GIN-indexed JSONB) that personal-finance products commonly grow into.
- Turso ecosystem maturity is younger; SOC 2 / ISO 27001 attestations not yet at parity with Neon/Supabase.
- The dev-prod parity argument cuts BOTH ways: if dev becomes Postgres anyway (as recommended for storage parity), keeping libSQL in prod buys nothing.

### B. SQLite in dev, Postgres in prod

Rejected. Two migration trees, two drivers, dialect-specific quirks (BigInt encoding, index plans, transaction isolation defaults) leak into application code as conditional branches. Defeats the "one mental model" win that motivated leaving SQLite in the first place.

### C. Postgres natively installed on the developer's machine

Rejected. Docker Compose is a 60-line file; native install is OS-specific (apt/brew/choco/pacman) and contributors arriving on a fresh laptop have to learn each. Compose is uniform.

### D. Self-hosted Postgres on a VPS

Rejected. Adds backups / replication / version upgrades / monitoring as our ops responsibility. Managed Postgres at small scale is genuinely cheaper than the engineering hours we'd burn doing it ourselves.
