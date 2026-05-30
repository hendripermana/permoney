# ADR-0032 — Idempotent update/delete semantics: soft-delete + new-row supersession

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-31     |
| **Accepted**      | 2026-05-31     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

PER-93 closes the remaining M2 gap in ledger mutation idempotency. PER-17 /
ADR-0006 made create-style transaction writes replay-safe. PER-20 / ADR-0012
made user-facing delete a soft-delete and made transfer soft-delete symmetric.
PER-18 / ADR-0013 put every scoped mutation behind Serializable retry and
version-checked balance updates. PER-103 / ADR-0031 made transfer graph shape a
database invariant.

`updateTransactionForFamily` is the outlier. It still uses an internal
reversal-and-replace pattern:

1. reverse the old balance effect;
2. hard-delete the old `Transfer` row when present;
3. hard-delete the old `Transaction` row(s);
4. create replacement rows using the same primary transaction id;
5. apply the new balance effect;
6. audit the before/after graph.

This kept URL continuity but now conflicts with the stronger M2 standard:
ledger history must not be erased as the correctness mechanism. With
`Transfer` FKs now `ON DELETE RESTRICT`, the handler also carries an explicit
interim hard-delete dependency that PER-93 is meant to remove.

Delete has a different gap. The current handler is balance-safe because
`deletedAt IS NOT NULL` returns no-op, but it is not yet ADR-0006 idempotency:
there is no endpoint-scoped key, no payload comparison, and no replay record
that lets a network retry return the original response without re-reading and
re-interpreting mutable ledger state.

## Decision

**Replace update hard-delete reversal with soft-delete + new-row supersession,
and make update/delete replay through endpoint-scoped `IdempotencyRecord`
rows.**

### 1. Update creates a new canonical row id

Updating a transaction is represented as:

1. read the active old graph under `scopedTenantTransaction`;
2. reject if the target row is already soft-deleted;
3. soft-delete the old canonical row(s);
4. create replacement row(s) with new primary ids;
5. apply the aggregate account delta exactly once per touched account;
6. write audit rows for the old soft-delete and new create graph in the same
   transaction;
7. store an idempotency replay record whose response contains the new outflow
   transaction id.

The replacement row does **not** reuse the old primary id. The old id remains a
historical ledger id. UI continuity is explicit through supersession links:

```prisma
model Transaction {
  supersededBy String? @unique
  supersedes   String? @unique
}
```

`supersededBy` points from an old, soft-deleted row to its immediate successor.
`supersedes` points from the successor back to the row it replaced. The chain is
one-to-one at each edge, so a transaction can be updated repeatedly without
erasing the intermediate states:

```text
T1(deletedAt, supersededBy=T2) <- T2(deletedAt, supersedes=T1, supersededBy=T3) <- T3(active, supersedes=T2)
```

The database enforces two structural checks:

- a row with `supersededBy IS NOT NULL` must also have `deletedAt IS NOT NULL`;
- a row cannot supersede itself or be superseded by itself.

Self-referential foreign keys use `ON DELETE RESTRICT` so future hard-delete
paths cannot silently erase a supersession chain.

### 2. New id over versioned same id

PER-93 locks the **new-id-per-update** strategy.

Keeping the same id with a hidden version number was rejected. It would make
URLs stable, but it makes history ambiguous: one id would refer to multiple
financial meanings over time, and every audit/log/debug tool would need a
version dimension to say which transaction it means. That trades a small UI
convenience for permanent ledger ambiguity.

A new id per update is stricter and easier to audit. The active list shows the
latest non-deleted row. Audit history can show "this transaction was superseded
by X" using the explicit link. Reports that need historical reconstruction can
walk the chain instead of inferring identity from mutable rows.

### 3. Transfer update keeps graph symmetry

Updating a transfer supersedes the entire money movement:

1. soft-delete old outflow `Transaction`;
2. soft-delete old inflow `Transaction`;
3. soft-delete old `Transfer`;
4. create new outflow `Transaction`;
5. create new inflow `Transaction`;
6. create a new `Transfer` linking the new legs.

The old `Transfer` remains in the database so ADR-0031 inverse-pairing still
sees each old transfer-typed leg paired by exactly one transfer row. Soft-delete
does not remove the pair; it only closes it. The new legs are paired by the new
`Transfer` before commit. Every step runs in one Serializable transaction.

The supersession link is stored on the transaction legs:

- old outflow `supersededBy = newOutflow.id`, new outflow `supersedes = oldOutflow.id`;
- old inflow `supersededBy = newInflow.id`, new inflow `supersedes = oldInflow.id`.

No `Transfer.supersedes` column is introduced in PER-93. The transfer update
relationship is derivable from the leg supersession links plus audit rows. A
future UI that needs transfer-level history can add a transfer-specific link in
a narrow follow-up without changing transaction identity.

### 4. Idempotency for update/delete uses `IdempotencyRecord`

Update and delete are endpoint-scoped mutations, so they use ADR-0006
`IdempotencyRecord` instead of `Transaction.idempotencyKey`:

| Endpoint              | Replay key scope                    | Response source                     |
| --------------------- | ----------------------------------- | ----------------------------------- |
| `updateTransactionFn` | `(familyId, "updateTransactionFn")` | cached serialized replacement row   |
| `deleteTransactionFn` | `(familyId, "deleteTransactionFn")` | cached `{ success: true }` response |

The existing `Transaction.idempotencyKey` unique index remains the create-flow
dedupe mechanism. Replacement rows created by update do not store the update
idempotency key in that column because the key is endpoint-scoped by contract
while the existing unique index is only `(familyId, idempotencyKey)`. Audit rows
and `IdempotencyRecord` rows still carry the key, preserving replay and forensic
correlation without introducing a cross-endpoint false conflict.

Each update/delete transaction attempt starts by reading the replay record. If
the key exists:

- same canonical payload returns the stored response without mutating balances,
  rows, or audit logs;
- different canonical payload throws `IdempotencyConflictError` (`409`).

If no record exists, the mutation proceeds and writes the replay record before
commit. A concurrent same-key request may race to the same unique record. The
loser rolls back its attempted mutation on the unique conflict, re-reads the
record, and replays or conflicts from the committed payload.

Replay records keep ADR-0006's 24-hour TTL. Transaction history and audit rows
are not purged for idempotency TTL.

### 5. Deleted-row semantics

An update against a soft-deleted transaction returns **410 Gone** and never
resurrects the row.

A delete against an already-soft-deleted transaction also returns **410 Gone**
when it is a new logical request. The same idempotency key that performed the
original delete replays the prior `{ success: true }` response before row-state
inspection. This preserves retry safety while refusing to treat a new delete
intent against closed ledger history as a success.

### 6. Bulk paths

PER-93 does not redesign bulk update/delete. PER-95 owns bulk parity. Existing
bulk handlers must keep passing their current tests, but they are not allowed
to silently become the new canonical update/delete model. PER-95 will adopt the
same principles:

- no hard delete for ledger history;
- explicit idempotency key per logical bulk mutation;
- update as soft-delete + new-row supersession where financial meaning changes;
- same tenant validation, audit, RLS GUC, and Serializable retry boundary as
  the single-row paths.

### 7. Migration guard

The migration adds the supersession columns and indexes only after fail-loud
drift checks:

- any existing `Transaction.deletedAt IS NOT NULL` row must have a soft-delete
  audit row with non-null before/after JSON;
- malformed pre-existing transfer soft-delete drift aborts rather than letting
  supersession links be added over ambiguous history.

The development database was audited before the ADR: zero soft-deleted
transactions, zero missing soft-delete audit rows, and zero hard-delete-style
transaction audit rows.

## Consequences

### Positive

- Update no longer erases canonical ledger rows or relies on hard delete to
  correct balances.
- Every update/delete retry has an explicit endpoint-scoped replay contract.
  Replays do not mutate balances, create rows, or duplicate audit evidence.
- Transaction identity becomes historically precise: old rows stay old, new
  financial meaning gets a new id, and continuity is represented by explicit
  links.
- Transfer updates preserve ADR-0012 soft-delete symmetry and ADR-0031 pairing
  invariants because old and new transfer graphs both remain paired.
- Same-key/different-payload conflicts fail before mutation when a replay
  record exists, and roll back cleanly when detected by the unique replay record
  race.

### Negative

- The UI can no longer assume an update response has the same transaction id as
  the submitted row. Clients must replace the old local row with the new id and
  refetch TanStack DB collections after mutation.
- Repeated updates create more rows than in-place mutation. This is the
  intentional storage cost of auditability; a financial ledger is optimized for
  explainable history, not row reuse.
- `IdempotencyRecord` and `Transaction.idempotencyKey` now have distinct
  responsibilities. Future agents must not "simplify" update replay by storing
  endpoint-scoped update keys on `Transaction.idempotencyKey` unless the unique
  constraint is redesigned in a separate ADR.
- Bulk paths remain temporarily asymmetric until PER-95. The tests in PER-93
  guard that they keep existing behavior; they do not certify them as the final
  bulk design.

### Alternatives considered

1. **Reuse the old transaction id and add a version column.** Rejected. It
   preserves URL stability but makes one id represent multiple ledger meanings.
   Audit, support, imports, and future reconciliation would need to qualify
   every reference with a version to avoid ambiguity.
2. **Keep hard-delete reversal and rely on `AuditLog` snapshots.** Rejected.
   Audit snapshots help explain a historical change, but they are not a
   substitute for durable canonical ledger rows. ADR-0012 explicitly named
   PER-93 as the point where the interim hard-delete pattern ends.
3. **Make delete of an already-deleted transaction always return 200.** Rejected
   for new logical requests. It is safe for balance arithmetic, but it hides a
   state-machine error from callers and weakens "closed ledger row" semantics.
   Same-key retries still replay 200 through idempotency.
4. **Store update idempotency keys on replacement `Transaction` rows only.**
   Rejected because ADR-0006 scopes keys by endpoint, while the existing
   transaction unique index does not. `IdempotencyRecord` is the correct
   endpoint-scoped replay surface for update/delete.
5. **Add transfer-level supersession columns now.** Deferred. Transaction-leg
   supersession plus audit rows is enough to explain PER-93. Adding
   `Transfer.supersedes` can be done later if the audit UI needs direct
   transfer-chain navigation.

## References

- PER-93 (M2-15 — Idempotent update and delete semantics for ledger mutations)
- PER-95 (bulk update/delete parity follow-up)
- ADR-0006 (idempotency keys and audit-log architecture)
- ADR-0011 (app-level tenant reference validation)
- ADR-0012 (transfer soft-delete symmetry and `onDelete: Restrict`)
- ADR-0013 (optimistic locking and Serializable retry)
- ADR-0031 (transfer graph database invariants)
- `prisma/migrations/20260601020000_idempotent_update_delete/migration.sql`
- `tests/integration/idempotent-mutations.integration.ts`
