# ADR-0012 — Transfer soft-delete symmetry and `onDelete: Restrict`

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-29     |
| **Accepted**      | 2026-05-29     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

A `Transfer` is one money movement represented as two `Transaction` rows: an outflow leg and an inflow leg. The existing schema declares both relations as `onDelete: Cascade`:

```prisma
outflowTransaction Transaction @relation("OutflowTransaction", fields: [outflowTransactionId], references: [id], onDelete: Cascade)
inflowTransaction  Transaction @relation("InflowTransaction",  fields: [inflowTransactionId],  references: [id], onDelete: Cascade)
```

User-facing soft delete sets `Transaction.deletedAt` (not `DELETE`), so the cascade does not fire today. Three forces still make the current state a latent risk:

- AGENTS.md § 5.A "No Hard Delete for Ledger History" — ledger history must not be erased as the correctness mechanism. The schema document of intent (`Cascade`) contradicts that rule for Transfer.
- A future hard-delete code path, an admin tool, a migration that converts soft delete to real DELETE, or a manual SQL operation will silently drop `Transfer` rows along with the Transaction. The audit trail of "was money moved? when? who?" is destroyed.
- `updateTransactionForFamily` already implements an internal "reversal-and-replace" pattern that hard-deletes the old `Transaction` rows. That path quietly relies on the `Cascade` to clean up the `Transfer`, which means changing the FK to `Restrict` without coordinating the handler will break update.

PER-20 closes the gap. Soft-delete becomes symmetric across both legs and the `Transfer` row itself. The FK becomes `Restrict` to make every future hard-delete path explicit and auditable.

## Decision

**Switch both `Transfer` foreign keys from `Cascade` to `Restrict`. Add `Transfer.deletedAt`. Treat a soft-delete on either leg as a soft-delete of the entire transfer.**

### Schema

```prisma
model Transfer {
  // existing ...
  deletedAt DateTime?

  outflowTransaction Transaction @relation("OutflowTransaction", fields: [outflowTransactionId], references: [id], onDelete: Restrict)
  inflowTransaction  Transaction @relation("InflowTransaction",  fields: [inflowTransactionId],  references: [id], onDelete: Restrict)

  @@index([deletedAt])
}
```

`onDelete: Restrict` makes Postgres refuse to `DELETE` any `Transaction` that a `Transfer` references. Every code path that previously depended on `Cascade` must now declare its dependency on `Transfer` explicitly.

### Soft-delete symmetry rule

A user request to delete a transfer leg deletes the entire money movement:

1. Soft-delete the outflow `Transaction` (`deletedAt = NOW()`).
2. Soft-delete the inflow `Transaction` (`deletedAt = NOW()`).
3. Soft-delete the `Transfer` row (`deletedAt = NOW()`).
4. Reverse the balance on both accounts.
5. Append three audit rows in the same `$transaction`: outflow soft-delete, inflow soft-delete, transfer soft-delete.

If any of those four steps fails, all five must roll back. The rule applies to every user-facing soft-delete path: `deleteTransactionForFamily` and `bulkDeleteTransactionsForFamily`.

The rule has one direction: deleting either leg deletes the whole transfer. There is no "delete one leg only" operation. A transfer with one leg alive and one dead would be an inconsistent ledger state and must not be representable.

### Idempotency

Soft-delete is idempotent. Deleting an already-soft-deleted Transfer is a no-op:

- The handler reads the transaction, sees `deletedAt IS NOT NULL`, returns success without re-reversing balances or writing duplicate audit rows.
- AGENTS.md § 5.A "Delete Must Be Idempotent": "Deleting a transaction twice must never reverse the balance twice."

PER-93 will introduce explicit idempotency-key replay semantics; PER-20 keeps the simpler "deletedAt-is-set ⇒ no-op" rule that the existing handler already uses for non-transfer transactions.

### Update reversal-and-replace path (interim)

`updateTransactionForFamily` currently uses hard-delete + recreate to update a transfer. After PER-20 the order becomes:

1. Reverse balances on both legs' accounts.
2. **`tx.transfer.delete({ where: { id: oldTransferId } })`** — the new explicit step.
3. `tx.transaction.delete({ where: { id: inflowTransactionId } })`.
4. `tx.transaction.delete({ where: { id: outflowTransactionId } })`.
5. Create the new outflow Transaction.
6. Create the new inflow Transaction.
7. Create the new Transfer.
8. Apply new balance deltas.
9. Audit each step.

Step 2 is the new behavior. Without it, steps 3 and 4 would fail with `restrict_violation` because the `Transfer` row still references the old transactions.

This keeps the existing hard-delete-reversal pattern intact for compatibility. AGENTS.md § 5.A "No Hard Delete for Ledger History" applies to ledger history that crosses the user boundary; `updateTransactionForFamily`'s internal reversal is captured in `AuditLog` (before/after of every deleted row), satisfying the "must be represented in AuditLog inside the same transaction" clause.

PER-93 will redesign reversal-and-replace into a true soft-delete + new-row pattern. PER-20 deliberately does not absorb that scope.

### `getTransactionsFn` list filter

Existing filter:

```ts
where: {
  familyId,
  deletedAt: null,
  transferIn: { is: null },
}
```

After PER-20 the symmetry rule guarantees both legs share the same `deletedAt` state, so `deletedAt: null` already excludes soft-deleted transfers from the list. As defense in depth against any future drift (a concurrent partial update, a manual SQL operation, a future code path that forgets the symmetry), the filter is extended with an explicit `transferOut` check:

```ts
where: {
  familyId,
  deletedAt: null,
  transferIn: { is: null },
  OR: [
    { transferOut: { is: null } },                 // not part of a transfer
    { transferOut: { deletedAt: null } },          // outflow leg of a non-soft-deleted transfer
  ],
}
```

The filter still treats `Transaction.deletedAt` as the canonical signal; the additional clause is a belt-and-suspenders check on the `Transfer.deletedAt` shadow.

## Consequences

### Positive

- Hard-deleting a `Transaction` referenced by a `Transfer` is now refused by Postgres. Future raw SQL paths, admin tools, bank-sync jobs, and AI workers cannot quietly destroy transfer audit history.
- A transfer is one money movement at the schema level. The `(both Transaction.deletedAt) AND Transfer.deletedAt` invariant is enforceable because every soft-delete handler sets all three in the same `$transaction`.
- `updateTransactionForFamily`'s implicit reliance on `Cascade` becomes explicit. Future agents reading the code see the dependency on `Transfer` instead of inheriting it as folklore.
- The `getTransactionsFn` filter survives drift: even a partially soft-deleted transfer will not appear in the user list, because the `OR` arm requires `transferOut.deletedAt` to be null.
- Real-Postgres adversarial tests prove every invariant: hard-delete attempt rejected with `restrict_violation`; soft-delete on either leg sets all three `deletedAt` columns in one transaction; `getTransactionsFn` excludes soft-deleted transfers; idempotent replay does not double-reverse balances.

### Negative

- Adds one column (`Transfer.deletedAt`) and one index. Negligible storage cost.
- `updateTransactionForFamily` and `bulkDeleteTransactionsForFamily` gain one extra Prisma call (delete or updateMany on `Transfer`). Inside an existing `$transaction`, this is a single query in the same connection — measurable but invisible at human-scale write rates.
- The interim hard-delete reversal in `updateTransactionForFamily` still erases the old `Transaction` rows. PER-93 redesigns this; PER-20 makes the dependency explicit so the redesign is straightforward.

### Alternatives considered

1. **Switch FKs to `SetNull` instead of `Restrict`.** Rejected. `SetNull` would leave the `Transfer` row pointing at NULL when its `Transaction` is hard-deleted — an orphaned audit row with no money movement attached. `Restrict` makes every hard-delete path explicit instead.
2. **Keep `Cascade` and rely on application code to never hard-delete.** Rejected. AGENTS.md § "Long-Horizon Engineering Standard" forbids "good enough today" shortcuts in ledger correctness; the database must enforce the rule, not the convention.
3. **Soft-delete only the leg the user clicked, leave the other half alive.** Rejected. A transfer with one leg dead and one alive is an inconsistent ledger state — balances do not reconcile, the transfer is no longer self-explanatory, and the user has no UI to undo it. The symmetry rule keeps the ledger explainable.
4. **Redesign `updateTransactionForFamily` to use soft-delete + new-row instead of hard-delete + recreate.** Out of scope. That is PER-93. Doing it here would conflate two milestones and slow review.
5. **Drop `Transfer.deletedAt` and rely solely on `Transaction.deletedAt`.** Rejected. Without `Transfer.deletedAt`, the audit row for "transfer X was deleted at time Y" has nowhere to live except a derived computation across two `Transaction` rows. The shadow column makes the transfer state queryable directly and supports the defense-in-depth filter in `getTransactionsFn`.

## References

- PER-20 (M2-6 — Drop onDelete: Cascade on Transfer; switch to soft-delete + Restrict)
- PER-93 (M2-15 — Idempotent update/delete semantics, will redesign reversal)
- PER-103 (M2-21 — Transfer graph DB invariants, builds on this work)
- ADR-0006 (Idempotency + AuditLog architecture)
- ADR-0010 (Tenant composite FK invariants — pattern of explicit FK dependencies)
- AGENTS.md § 5.A — Transaction Core Architecture, Data Integrity rules
- Postgres docs: [`ON DELETE RESTRICT`](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-FK)
