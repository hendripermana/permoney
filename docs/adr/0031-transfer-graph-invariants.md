# ADR-0031 — Transfer graph database invariants

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-30     |
| **Accepted**      | 2026-05-30     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

A `Transfer` is one money movement represented as two `Transaction` rows — an outflow leg and an inflow leg — plus a `Transfer` row that links them. Prior M2 work locked several pieces of this graph:

- **PER-104 / ADR-0010** — the two legs of a `Transfer` must belong to the same `familyId` (constraint trigger `enforce_transfer_leg_pair_tenant_invariant`).
- **PER-20 / ADR-0012** — a `Transfer` row cannot be hard-deleted in isolation from its legs (`onDelete: Restrict`), and a soft-delete sets `deletedAt` symmetrically on both legs and the `Transfer` row.
- **PER-16** — amount sign, currency, status, and kind domains on `Transaction`.

Four shape invariants of the transfer graph are still unenforced at the database layer. Direct SQL — a future bank-sync mapper, an AI enrichment job, a manual admin query, or a buggy server function — can still create malformed transfer graphs that the application-layer code would never produce:

1. **Type-shape.** A `Transfer` can reference `Transaction` rows whose `type` is `expense` or `income`. A transfer leg that is not typed `transfer` is a malformed graph: the ledger says "this is a transfer" on the `Transfer` row but "this is an expense" on the leg.
2. **Inverse pairing.** A `Transaction` with `type = 'transfer'` can exist with **no** `Transfer` row referencing it — an orphan transfer leg. This breaks the audit story ("money moved, but where is the other half?") and would corrupt future bank-sync ingestion and reporting that assume every transfer leg resolves to a movement.
3. **Self-reference.** A `Transfer` can have `outflowTransactionId = inflowTransactionId`. A transfer from a transaction to itself is nonsensical.
4. **Account complementarity.** A `Transfer` can have both legs on the same `accountId`. Money "moving" from an account to itself is a no-op or a bug, not a transfer.

A finance ledger cannot accept "the app remembers to build the graph correctly" as the only correctness mechanism. ADR-0010 explicitly anticipated this work: _"The trigger pattern is reusable for PER-103 (transfer graph DB invariants)."_ PER-103 closes the four gaps using the proven PER-104 constraint-trigger pattern.

## Decision

**Enforce the four invariants at the database layer, using a table-level `CHECK` for the in-row case and constraint triggers for the cross-row cases. The inverse-pairing trigger is `DEFERRABLE INITIALLY DEFERRED` because the application builds the graph across several statements inside one transaction.**

### 1. Self-reference — table-level `CHECK` (in-row)

```sql
ALTER TABLE "Transfer"
  ADD CONSTRAINT "transfer_no_self_reference"
  CHECK ("outflowTransactionId" <> "inflowTransactionId");
```

Both columns live on the `Transfer` row itself, so no trigger is needed. The cheapest correct mechanism.

### 2. Type-shape — constraint trigger on `Transfer` (`INITIALLY IMMEDIATE`)

`enforce_transfer_type_shape_invariant` fires `AFTER INSERT OR UPDATE OF "outflowTransactionId", "inflowTransactionId" ON "Transfer"`. It reads both referenced `Transaction` rows and raises `check_violation` unless both have `type = 'transfer'`.

Immediate is correct here: when a `Transfer` row is written, both legs already exist (the FK requires it), so the type can be read at write time. There is no deferral window.

### 3. Account complementarity — constraint trigger on `Transfer` (`INITIALLY IMMEDIATE`)

`enforce_transfer_account_distinct_invariant` fires on the same `Transfer` write and raises `check_violation` when `outflow.accountId = inflow.accountId`. Cross-table join to `Transaction`, immediate for the same reason as type-shape.

### 4. Inverse pairing — constraint trigger on `Transaction` (`DEFERRABLE INITIALLY DEFERRED`)

`enforce_transfer_typed_transaction_paired_invariant` fires `AFTER INSERT OR UPDATE OF type ON "Transaction"`. For any row with `type = 'transfer'`, exactly one `Transfer` row must reference it (as `outflowTransactionId` **or** `inflowTransactionId`). Otherwise it raises `check_violation`.

**This trigger must be deferred.** The application creates a transfer across several statements inside one `$transaction`:

```
outflowTx = tx.transaction.create({ type: 'transfer', ... })   -- unpaired here
inflowTx  = tx.transaction.create({ type: 'transfer', ... })   -- both unpaired here
tx.transfer.create({ outflowTransactionId, inflowTransactionId }) -- now paired
```

Between the `Transaction` creates and the `Transfer` create, two transfer-typed `Transaction` rows exist with no `Transfer` row. An `INITIALLY IMMEDIATE` trigger would raise a false positive at the first `Transaction.create`. `DEFERRABLE INITIALLY DEFERRED` makes the check run once, at `COMMIT`, by which point the `Transfer` row exists and the invariant holds.

This behaviour was verified empirically against the real schema before authoring the migration: the happy path commits cleanly, an orphan transfer-typed `Transaction` raises `check_violation` at `COMMIT`, and a `Transfer` pointing at an `expense` leg is rejected immediately on the `Transfer` insert.

### Pattern A vs Pattern B per invariant

ADR-0010 defines Pattern A (composite FK) and Pattern B (constraint trigger). None of the four PER-103 invariants fit Pattern A:

- Self-reference compares two columns on the same row — a `CHECK`, simpler than either pattern.
- Type-shape and account-distinct require reading a column (`type`, `accountId`) from the referenced `Transaction` rows — not expressible as a composite FK, which can only equate key tuples. Pattern B.
- Inverse pairing is a cardinality assertion ("exactly one `Transfer` references this `Transaction`") that no FK can express. Pattern B, deferred.

### SQLSTATE helper reuse

All three trigger functions raise through the existing `_per104_raise_check_violation(message)` helper from the PER-104 migration (`CREATE OR REPLACE`, idempotent, generic). No duplicated SQLSTATE strings. `check_violation` (23514) maps to Prisma `P2004`, which the integration suite already accepts.

### Strict-pairing decision

**Every `type = 'transfer'` Transaction must be attached to exactly one `Transfer` row. No transitional exception.** This is the ticket's explicit open question; it is locked strict for these reasons:

- **Every code path already pairs.** `createTransactionForFamily` and `updateTransactionForFamily` (reversal-and-replace) create both legs and the `Transfer` row in the same `$transaction`. There is no server path that leaves a transfer-typed `Transaction` unpaired at `COMMIT`.
- **The seed creates no transfers.** After PER-110, `prisma/seed/app-tenant.ts` creates accounts, categories, and merchants — no transfers.
- **No staging model exists yet.** Bank-sync ingestion (`RawImportedTransaction`) is PER-118 (M8, post-v1.0). Raw, not-yet-paired provider rows must live in a dedicated staging model — **not** as unpaired transfer-typed `Transaction` rows in the canonical ledger. Loosening the `Transaction` invariant to accommodate a future staging need would weaken the ledger today for a model that does not exist. The strict invariant is the correct default; PER-118 owns the escape route when it lands.

This mirrors AGENTS.md: _"Raw Bank Data Is Not Canonical Ledger Data … Only normalized, deduplicated, idempotent, tenant-validated, user-confirmed or rule-confirmed rows may become canonical Transaction records."_ An unpaired transfer leg is not a canonical record.

### Interaction with PER-20 soft-delete

`deleteTransactionForFamily` soft-deletes a transfer by setting `deletedAt` on both legs **and** the `Transfer` row in the same transaction. The `Transfer` row still **exists** (only `deletedAt` is set), so the inverse-pairing trigger — which checks for the existence of a referencing `Transfer` row regardless of `deletedAt` — still sees the pair. Soft-delete does not trip orphan detection. The type-shape and account-distinct triggers do not fire on a soft-delete because `deletedAt` is not one of their watched columns. An adversarial test asserts a soft-deleted transfer survives all triggers.

### Migration order

1. Fail-loud drift guard (mirror PER-104/PER-20): count the five gap classes; abort with a clear message if any pre-existing row violates an invariant. The development database was audited clean (all five counts zero); the guard defends CI and production.
2. `transfer_no_self_reference` CHECK.
3. Three PL/pgSQL trigger functions.
4. Three constraint triggers: two `INITIALLY IMMEDIATE` on `Transfer`, one `DEFERRABLE INITIALLY DEFERRED` on `Transaction`.

## Consequences

### Positive

- The four malformed-transfer-graph vectors fail at the database regardless of write path: server functions, raw `$executeRaw`, future bank-sync/AI mappers, manual SQL.
- The inverse-pairing invariant turns "orphan transfer leg" from a latent silent corruption into an impossible state, protecting future reporting and bank-sync ingestion.
- The deferred trigger composes cleanly with the existing multi-statement transfer create and reversal-and-replace flows — verified empirically, not assumed.
- Reuses the PER-104 helper and trigger conventions, so the transfer graph and tenant-FK invariants read as one coherent body of database law.
- Real-Postgres adversarial tests prove every invariant with RED-then-GREEN reproducibility.

### Negative

- Every `Transaction` insert/update that touches `type` now runs a deferred check at `COMMIT` (one indexed lookup against `Transfer`); every `Transfer` write runs two immediate cross-table reads. At human-scale ledger write rates this is invisible. A future high-throughput bulk-import path should be re-measured, but the lookups hit unique indexes.
- Three more trigger objects widen the schema surface future agents must understand. ADR-0031 is the canonical reference, alongside ADR-0010.
- Prisma `migrate diff` does not generate triggers or this `CHECK`; they are hand-written migration concerns. Changing the transfer model in future requires updating the triggers by hand.
- The deferred trigger reports its violation at `COMMIT`, not at the offending statement, which can make ad-hoc debugging of a raw-SQL session slightly less direct. The error message names the offending Transaction id to compensate.

### Alternatives considered

1. **All triggers `INITIALLY IMMEDIATE`.** Rejected for inverse pairing: it false-positives during the legitimate multi-statement transfer create, where two transfer-typed `Transaction` rows briefly exist before the `Transfer` row. Verified to fail in the empirical probe. Immediate is kept for the two `Transfer`-side triggers, where no deferral window exists.
2. **Loosen the `Transaction` pairing invariant for import staging.** Rejected. No staging model exists yet (PER-118, M8). Weakening a canonical-ledger invariant today for a future, not-yet-designed model is exactly the "good enough" shortcut the long-horizon standard forbids. Staging rows belong in `RawImportedTransaction`, not in unpaired transfer-typed `Transaction` rows.
3. **Enforce pairing in application code only.** Rejected. PER-94 app-level validation is the user-facing layer; the database must be the authority. A raw-SQL path or a future mapper that bypasses the server functions would otherwise create orphan legs.
4. **A `Transfer.familyId` denormalized column + composite FK (Pattern A) for type-shape.** Rejected. A composite FK can only equate key tuples; it cannot assert `Transaction.type = 'transfer'`. Pattern A does not apply to any of these invariants.
5. **Enforce account complementarity with a `CHECK`.** Impossible: `accountId` lives on the referenced `Transaction` rows, not on `Transfer`. Requires the cross-table read of a trigger.
6. **Use a partial unique index to enforce "one Transfer per leg".** The existing `@unique` on `outflowTransactionId` and `inflowTransactionId` already prevents two Transfers from sharing a leg. It does **not** enforce the inverse — that a transfer-typed `Transaction` _has_ a Transfer. The deferred trigger is the only mechanism that expresses the existence/cardinality assertion.

## References

- PER-103 (M2-21 — Transfer graph DB invariants: no orphan transfer legs or incomplete pairs)
- ADR-0010 (Tenant composite FK invariants) — constraint-trigger pattern, `_per104_raise_check_violation` helper, anticipated PER-103
- ADR-0012 (Transfer soft-delete symmetry) — `Transfer.deletedAt`, soft-delete interaction
- PER-118 (M8 — Provider Integration Contract, `RawImportedTransaction` staging) — future escape route for unpaired raw rows
- PER-93 (reversal redesign), PER-95 (bulk parity) — explicitly out of scope
- `prisma/migrations/20260601000000_transfer_graph_invariants/migration.sql`
- `tests/integration/transfer-graph-invariants.integration.ts`
- Postgres docs: [`CREATE TRIGGER` (constraint triggers, `DEFERRABLE`)](https://www.postgresql.org/docs/16/sql-createtrigger.html), [`SET CONSTRAINTS`](https://www.postgresql.org/docs/16/sql-set-constraints.html), [`CHECK` constraints](https://www.postgresql.org/docs/16/ddl-constraints.html).
