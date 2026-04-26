# ADR-0003 — Production database: Turso (libSQL) over Postgres, with explicit revisit triggers

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-04-26     |
| **Accepted**      | 2026-04-26     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

The Apr 2026 deep-audit (`/home/ubuntu/.windsurf/plans/deep-audit-3bf464.md`) flagged P0-B "Production DB story is undefined." The original audit recommendation was _"migrate to managed Postgres (Neon/Supabase)"_, on the prior that "MAANG-grade always means Postgres."

A closer reading of the existing infrastructure investment changed that recommendation:

```@/home/ubuntu/permoney/.env.example:14-25
# Database (REQUIRED)
# -----------------------------------------------------------------------------
# LibSQL / SQLite connection string consumed by both:
#   1. Prisma CLI (migrations, generate)
#   2. Runtime (`@prisma/adapter-libsql` in src/server/db.server.ts)
#
# Local development (embedded SQLite file):
DATABASE_URL="file:./prisma/dev.db"
#
# Production (Turso edge replica):
# DATABASE_URL="libsql://<your-db>-<your-org>.turso.io"
# DATABASE_AUTH_TOKEN="<turso-jwt-token>"
```

`@prisma/adapter-libsql` is already wired in `src/server/db.server.ts`. The Prisma schema's `migration_lock.toml` declares `provider = "sqlite"`. The audit's Postgres pivot would have required: (a) a second migration history, (b) a runtime adapter selector with two production code paths, (c) a one-time `dev.db → prod` migration script, and (d) ongoing dual-driver maintenance — all to gain features the personal-finance product profile does not need today.

This ADR makes the implicit Turso decision explicit, documents _why_ it is correct for this product, lists the **concrete signals** that would force a Postgres revisit, and ships the index work the audit was actually asking for.

## Decision

**Production database = Turso (managed libSQL edge replicas), accessed via `@prisma/adapter-libsql`.**

Dev unchanged: `DATABASE_URL="file:./prisma/dev.db"` (embedded SQLite file). Prod uses `DATABASE_URL="libsql://…"` + `DATABASE_AUTH_TOKEN`. The runtime adapter handles both URL schemes; no second code path.

In support of this decision we also ship:

1. **Strategic indexes** on the heavy query columns (`Transaction`, `Account`, `Category`, `Merchant`, `SplitEntry`, `SmartRule`). Prisma with the SQLite/libSQL provider does **not** auto-index foreign-key columns; every query was doing full table scans. See migration `20260426220000_add_query_indexes`.
2. **Hardened `db.server.ts`** that validates `DATABASE_AUTH_TOKEN` is present whenever the URL scheme is `libsql://` (remote prod), and emits a clear error early if not. The defense-in-depth comments from the existing file are preserved verbatim.
3. **`.env.example` revisions** that make the prod path copy-pasteable and call out the Turso CLI commands needed to provision a database.

### Why Turso is right for this product

The audit's Postgres argument leaned on three claims; each fails on inspection:

| Audit claim                                                           | Reality for this product                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "SQLite single-writer = `database is locked` at ~50 concurrent users" | Turso (libSQL fork) implements WAL2 + per-connection writers. The single-writer concern was for **embedded SQLite over a network FS**. A managed libSQL service multiplexes writes per connection internally. For a per-family ledger (write rate ≈ user actions, ~bursty 1-10 writes/s peak), this is non-binding. |
| "BigInt stored as TEXT in SQLite, native int8 in Postgres"            | libSQL stores `BigInt` as native `INTEGER` (64-bit signed). Range: ±9.2 × 10¹⁸. At satoshi precision (10⁸ minor units/BTC), that's ±92 billion BTC of headroom. Money values cannot overflow this in any plausible product future. See ADR-0001.                                                                    |
| "Postgres feature set wins long-term"                                 | True for analytic workloads (LATERAL joins, `pg_trgm`, partitioning). False for OLTP personal-finance where the heaviest query is "list 10k transactions ordered by date." Index quality matters more than dialect at this scale.                                                                                   |

What we _gain_ by staying on libSQL:

- **Dev-prod parity.** Identical SQL dialect, identical Prisma migration files, identical `BigInt` semantics. Onboarding stays one command (`vp dev`).
- **Edge replication.** Turso's tier-0 architecture replicates to read regions; latency for a Jakarta user reading a Singapore-replicated DB is 30-50ms vs ~200ms for any US-east managed Postgres.
- **Operational surface.** One vendor, one connection string, one SDK. No connection pooler (PgBouncer / Supavisor / Neon proxy) to babysit.
- **PITR via Turso.** Managed branching + point-in-time restore is included; we do not roll our own.
- **Cost.** Turso's free tier (500 DBs, 9GB total, 1B row reads/month) covers the projected first 6 months of users at zero spend. Neon's free tier autosuspends after 5 minutes of idle, which would land cold-starts in front of every page-load for low-traffic users.

### When this decision must be revisited

This ADR commits the project to libSQL **only as long as the following thresholds hold**. If any one trips, open ADR-0XXX with the new constraints:

1. **Single-DB write QPS sustained > 200/s for >5 minutes.** Indicates a user pattern (e.g. spreadsheet-style bulk import) the single-writer can't absorb. Mitigation before pivoting: shard per-family (each family = its own Turso DB).
2. **Cross-tenant analytic query needed.** If product roadmap adds "anonymized aggregate insights across all families" (e.g., spending benchmarks), libSQL's lack of LATERAL joins, materialised views, and `pg_trgm` becomes binding. Postgres would then be the right tool — possibly a _separate_ analytic warehouse, not a primary swap.
3. **Schema demands JSONB-style indexed JSON queries.** libSQL has `json_*` functions but no GIN/expression-indexed JSON. If we add a feature like "search receipts by OCR'd line items," that's a Postgres + `tsvector` job.
4. **Compliance certification (SOC 2, ISO 27001) requires a vendor with that attestation.** Turso is moving in this direction but is younger than Neon/Supabase; if a future enterprise customer demands it before Turso has it, we move.
5. **Turso pricing reaches a point where managed Postgres is cheaper for our volume.** Re-evaluate annually.

None of these are true today.

## Consequences

### Positive

- One database, one driver, one schema. The mental model is small.
- Indexes added in this ADR speed up every existing query (no plan needed) — the heaviest query (`getTransactionsFn`) goes from full-scan to seek on the new `(deletedAt, date DESC)` covering index.
- The runtime adapter validates `DATABASE_AUTH_TOKEN` at startup when URL scheme = `libsql://`; a misconfigured prod env crashes immediately at boot with a clear message instead of failing on first query.
- ADR-0001's `BigInt` minor-unit decision is reaffirmed — libSQL stores it natively.

### Negative / costs

- We are explicitly **not** future-proofing for "infinite analytical scale." If we end up wanting Postgres analytics, that is a separate ADR + separate database (probably as an OLAP sink fed by CDC from libSQL, not a swap).
- Turso ecosystem is younger than Postgres'. Tooling surface (e.g., Datadog integrations, ORMs other than Prisma) is smaller. Mitigated by Prisma being our only ORM and Turso's metrics being exported via OpenTelemetry compatible endpoints.
- Migration history files are SQLite-specific. If the ADR ever flips, we regenerate from the schema (`prisma migrate diff`) — the _schema_ is portable; only the migration SQL is dialect-specific.

### Neutral

- Audit's P0-B is now closed. The "production DB story" is documented, the indexes are present, the env hardening is wired.

## Implementation

### Schema changes — strategic indexes

Indexes added (see migration `20260426220000_add_query_indexes` for SQL):

| Model         | Index                    | Query motivation                                                                                               |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `Transaction` | `(deletedAt, date DESC)` | Main list query in `getTransactionsFn` (`WHERE deletedAt IS NULL ORDER BY date DESC`). Covers most page loads. |
| `Transaction` | `(accountId, date DESC)` | Per-account history (account-detail drill-down planned post-ADR-0004).                                         |
| `Transaction` | `(userId)`               | Current dev "borrow user" pattern; will be replaced by `(familyId, ...)` in ADR-0004.                          |
| `Transaction` | `(categoryId)`           | Category aggregation reports.                                                                                  |
| `Transaction` | `(merchantId)`           | Merchant-frequency reports.                                                                                    |
| `Account`     | `(familyId)`             | Tenant-scoped fetch (ADR-0004 dependency, but cheap to add now).                                               |
| `Category`    | `(familyId)`             | Same as above.                                                                                                 |
| `Merchant`    | `(familyId)`             | Same as above.                                                                                                 |
| `SplitEntry`  | `(transactionId)`        | Hydrating split children for a transaction list.                                                               |
| `SmartRule`   | `(familyId)`             | Tenant-scoped rule evaluation.                                                                                 |

Note: Prisma's SQLite/libSQL provider does **not** auto-create indexes on foreign-key columns (unlike its Postgres provider), so the FK-column entries above are not redundant.

### `db.server.ts` hardening

The remote `libsql://` scheme requires a JWT (`DATABASE_AUTH_TOKEN`). The hardened factory:

1. Detects the URL scheme.
2. If `libsql://` (or `https://`/`wss://` Turso variants), requires `DATABASE_AUTH_TOKEN`; throws a clear error early if missing.
3. If `file:` (embedded), passes the URL through unchanged — no token expected.

The existing four-layer defense (file-suffix fence, lazy proxy, `typeof window` trap, `@__PURE__`) is preserved verbatim; the only addition is the URL-scheme-aware adapter construction.

### `.env.example`

Adds a clearer split between dev and prod sections, documents the Turso CLI commands (`turso db create`, `turso db tokens create`), and notes that `DATABASE_AUTH_TOKEN` is required for `libsql://` URLs but ignored for `file:` URLs.

## Verification

- `vp run check` — fmt + lint + typecheck + no-use-effect guard, all green.
- `vp test run` — 154 / 154 pass (no test changes needed; pure infra ADR).
- `vp build` — production bundle generated.
- `prisma migrate dev` — idempotent on existing dev DB; new indexes appear in `dev.db`.
- Adversarial: setting `DATABASE_URL=libsql://example.turso.io` without `DATABASE_AUTH_TOKEN` and starting the app — must crash at boot with the documented error.

## Alternatives considered

### A. Migrate to managed Postgres (Neon / Supabase)

The original audit recommendation. Rejected for the reasons above — it solves problems we don't have at a cost we don't need to pay. The "Postgres for analytics later" path stays open as a separate, additive decision (CDC sink, not swap).

### B. Self-hosted Postgres on a Hetzner/DO VPS

Cheap, but adds a full ops dimension (backups, version upgrades, replication, monitoring). Antithetical to the "small ops surface" win we already have with Turso.

### C. Stick with embedded SQLite in production via a single VPS

Works for a side-project but eliminates the edge-replication and managed-PITR wins of Turso. Also requires us to operate the database file ourselves. Rejected.

### D. Keep the schema provider = "sqlite" but use `@prisma/adapter-pg` against a Postgres URL

Prisma 7 driver adapters technically allow this, but the schema provider controls migration-SQL generation, so existing migrations would not apply against Postgres unmodified. The dual-history complexity isn't worth it for a hypothetical pivot.
