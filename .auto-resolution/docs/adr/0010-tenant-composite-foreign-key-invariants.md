# ADR-0010 — Tenant composite foreign-key invariants

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-27     |
| **Accepted**      | 2026-05-27     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

Permoney's tenant-isolation story has three layers:

1. **Application code** — every server function reads `ctx.session.user.familyId` and filters every query by it (PER-92, M1).
2. **Postgres Row-Level Security** — `app.family_id` GUC, transaction-scoped, enforced by per-table policies (M1.5, hardened for `Category` in PER-102 / ADR-0009).
3. **Foreign keys** — referenced rows must exist.

Layer 3 is the gap PER-104 closes. A standard FK proves a row exists; it does not prove it belongs to the same family. A direct SQL path, a future bank-sync mapper, an AI enrichment job, or a buggy server function could write a row with `Transaction.familyId = familyA` while `Transaction.accountId` points to an Account owned by `familyB`. RLS on `Transaction` alone does not catch this — the read by `familyA` returns a row that secretly references `familyB` data.

The audit (against the development database before migration) confirmed there are zero pre-existing cross-tenant references on every path that this ADR governs. The fix is therefore a forward-looking schema invariant, paired with a fail-loud data-repair guard so future environments cannot quietly accumulate drift.

A finance ledger cannot accept "the app remembers to filter" as the only correctness mechanism. The database is the long-horizon authority; the schema must reject cross-tenant graphs the way it rejects type errors.

## Decision

**Two patterns, applied based on whether the referenced table has a non-nullable `familyId`.**

### Pattern A — Composite foreign keys

For tenant-owned tables where `familyId` is `NOT NULL` on every row, add a composite `UNIQUE (id, familyId)` and reference it via composite FK from every consumer.

| Source                              | New foreign key                                          |
| ----------------------------------- | -------------------------------------------------------- |
| `Transaction.accountId, familyId`   | `→ Account(id, familyId)` ON DELETE RESTRICT             |
| `Transaction.toAccountId, familyId` | `→ Account(id, familyId)` ON DELETE RESTRICT (nullable)  |
| `Transaction.merchantId, familyId`  | `→ Merchant(id, familyId)` ON DELETE RESTRICT (nullable) |
| `SmartRule.merchantId, familyId`    | `→ Merchant(id, familyId)` ON DELETE RESTRICT (nullable) |

Postgres `MATCH SIMPLE` (the default) handles the nullable cases correctly: when the source `*Id` column is `NULL`, the FK is not checked. When it is present, both columns are compared, and a cross-tenant `(refId, otherFamilyId)` row cannot satisfy the target's composite uniqueness.

The composite UNIQUE on the referenced table is logically redundant with the existing primary key on `id`, but it is necessary because Postgres requires the FK target columns to match a unique constraint as a set, not just contain a unique subset.

### Pattern B — Constraint triggers

Pattern A does not work for four cases. Each gets a dedicated `CREATE CONSTRAINT TRIGGER` that fires `AFTER INSERT OR UPDATE` and raises `RAISE EXCEPTION ... USING ERRCODE = '23514'` (check-violation) when the cross-tenant invariant is violated.

#### B.1 Category exception — `Transaction`, `SplitEntry`, `SmartRule`, `Category.parentId`

`Category.familyId` is nullable for system rows (`isSystem = true AND familyId IS NULL`, locked in PER-102 / ADR-0009). A composite FK `(categoryId, familyId) → Category(id, familyId)` would fail to match the system case because `familyId` on the source side is non-null while the target's `familyId` is `NULL`, and `(id, NULL)` does not equal `(id, otherFamily)` under SQL three-valued logic.

The trigger encodes the explicit predicate "the referenced category is either a system row OR belongs to the same family":

```
allowed := (cat.isSystem = TRUE AND cat.familyId IS NULL)
           OR (cat.familyId IS NOT DISTINCT FROM source.familyId)
```

For `SplitEntry`, the source family is resolved from the parent transaction. For `Category.parentId`, the parent must be either a system category or live in the child's family.

#### B.2 SplitEntry has no own `familyId`

`SplitEntry` rows are scoped through the parent `Transaction`. A composite FK on SplitEntry would need to project `familyId` into the row, which would either denormalize the schema or require generated columns that complicate inserts. The trigger approach defers tenant resolution to the join through `Transaction.familyId`.

#### B.3 Transfer leg pair must share a family

`Transfer` references two `Transaction` rows (outflow + inflow). They must belong to the same family. A composite FK cannot express "both legs share a family" without a redundant `Transfer.familyId` column. The trigger validates `tout.familyId = tin.familyId` and raises if they differ. The existing `ON DELETE CASCADE` from Transaction stays — soft-delete and onDelete redesign is PER-20's scope, deliberately out of PER-104.

#### B.4 User actor must belong to the transaction's family

`Transaction.userId → User(id)` — `User.familyId` is nullable until guided onboarding completes (ADR-0004 § Onboarding Contract). At the moment a `Transaction` row exists, the actor must already be onboarded and belong to the same family. The trigger validates `User.familyId IS NOT NULL AND User.familyId = Transaction.familyId`. Authentication middleware should prevent unonboarded users from reaching the mutation path; this is the database backstop that makes the contract a hard rule.

### Trigger implementation rules

1. **`CREATE CONSTRAINT TRIGGER` over plain triggers.** Constraint triggers participate in the transaction in the standard way and produce an `integrity_constraint_violation` error code, which Prisma translates cleanly. They can also be made `DEFERRABLE` if a future bulk path needs to insert parent + child in a non-trivial order, although PER-104 keeps them `INITIALLY IMMEDIATE`.
2. **`AFTER INSERT OR UPDATE`** with explicit `OF` column lists where appropriate, so updates that don't touch the relevant columns are not re-validated.
3. **Single helper function per invariant**, called from every relevant trigger. The function reads from the referenced table directly. No row-level cache; one extra index lookup per write is acceptable for ledger throughput.
4. **`RAISE EXCEPTION ... USING ERRCODE = '23514'`** with a deterministic message that includes the offending IDs. Prisma maps `23514` to `Prisma.PrismaClientKnownRequestError` with code `P2004`, which integration tests already accept (the existing PER-102 RLS-violation regex covers this code).
5. **`DROP FUNCTION ... CASCADE` on rollback** is intentionally avoided. The migration owns its triggers explicitly; future changes drop the trigger first, then the function.

## Consequences

### Positive

- The four cross-tenant attack vectors fail at the database layer regardless of the request path: app server functions, raw SQL through `prisma.$executeRaw`, future bank-sync/AI mappers, manual admin SQL, all rejected.
- The composite UNIQUE on `Account` and `Merchant` lets future references (loan-payment links, recurring transfers, anything we add) reuse the same composite-FK pattern without re-deriving the tenant invariant.
- The trigger pattern is reusable for PER-103 (transfer graph DB invariants) and any future model that mixes "global reference data" with "tenant-owned" semantics.
- App-level validation in PER-94 can produce richer user-facing errors with confidence that the database catches anything PER-94 misses. PER-94 is the user-facing layer; PER-104 is the law.
- The integration test suite gains real-Postgres adversarial coverage for every cross-tenant path before any related work in M2 closes.

### Negative

- Every `INSERT`/`UPDATE` to `Transaction`, `SplitEntry`, `SmartRule`, `Category`, and `Transfer` runs at least one extra index lookup (the constraint-trigger function reads the referenced row). The cost is a single B-tree probe; for a financial ledger that handles human-scale write rates this is invisible. If a future bulk-import path moves into millions of rows per minute, the trigger is still cheap (the probe hits the unique index), but the design should be revisited under load.
- Migration adds five constraint triggers and one PL/pgSQL function. This widens the surface area of objects future agents must understand. ADR-0010 is the canonical reference.
- Changing how a transaction references categories or accounts in the future requires updating both the schema and the matching trigger or composite FK. Prisma's `migrate diff` does not generate triggers, so trigger maintenance is a hand-written migration concern.

### Alternatives considered

1. **Application-only validation (PER-94 alone).** Rejected. The long-horizon engineering standard explicitly forbids "good enough today" shortcuts in tenant boundaries. PER-94's user-facing validation is necessary but not sufficient; the database must be authoritative.
2. **Move system categories to a separate table.** Possible and cleaner long-term, but a much larger blast radius (server functions, FK relations from `Transaction.categoryId`, audit-log shape, smart rules). Deferred to ADR-0008 / M2.5 (Core Domain Model). The trigger approach achieves the same isolation today without rewriting the ledger.
3. **Generated `familyId` column on `SplitEntry` propagated by trigger.** Possible, but it converts SplitEntry into a denormalized table whose `familyId` can drift from the parent under bulk-import edge cases. The constraint-trigger approach keeps the parent as the single source of truth.
4. **`DEFERRABLE INITIALLY DEFERRED` constraint triggers.** Considered for future bulk-import flows that may insert parent + child in non-trivial order. Set to `INITIALLY IMMEDIATE` for PER-104 because every current path inserts parent → child sequentially. Switching to `DEFERRED` later is a small migration and does not invalidate this ADR.

### Test surface

Real-Postgres integration coverage in `tests/integration/cross-tenant-fk.integration.ts` proves every invariant:

- Direct SQL `INSERT INTO "Transaction" (familyId=A, accountId=<B's account>)` rejected.
- Same for `toAccountId`, `merchantId`.
- `Transaction.categoryId` rejected when pointing to family B's tenant category; allowed when pointing to a system category.
- `SplitEntry` cross-tenant `categoryId`/`merchantId` rejected through the parent's family.
- `SmartRule` cross-tenant `merchantId`/`categoryId` rejected; system category allowed.
- `Transfer` rejected when the two legs belong to different families.
- `Transaction.userId` rejected when User belongs to a different family or is not yet onboarded.
- `Category.parentId` rejected when the parent is a tenant category from a different family; allowed when the parent is a system row.
- Same-family references and bulk paths still succeed.

Each adversarial test must fail against the pre-PER-104 schema (RED) and pass after the migration (GREEN), with the RED-then-GREEN reproducibility log preserved in the PR.

## References

- PER-104 (M2-22 — DB-level tenant composite foreign-key invariants)
- PER-92, PER-94, PER-102 (related app-level + RLS layers)
- ADR-0006 (idempotency + audit), ADR-0009 (Category RLS write-policy split)
- Postgres docs: [Foreign Key constraints](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-FK), [Constraint triggers](https://www.postgresql.org/docs/16/sql-createtrigger.html), [`MATCH SIMPLE` semantics](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-FK-MATCH).
