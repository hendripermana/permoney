-- PER-83 Slice 1 — "Manual reconciliation workflow foundation".
--
-- Adds line-by-line, TRANSACTION-LEVEL reconciliation tracking. This is
-- orthogonal to the existing ACCOUNT-level "Reconcile" button (ADR-0043's
-- ground_truth ANCHOR Valuation, which re-materializes an account's overall
-- balance) — that mechanism is untouched by this migration. This one instead
-- lets a user tick an individual, already-CLEARED transaction off against a
-- real bank statement, the way a paper register works.
--
-- Additive-only: both new columns are nullable with no default and no
-- backfill — every existing row starts unreconciled (NULL, NULL), which is
-- the correct historical truth (nothing was ever reconciled through this
-- mechanism before it existed).
ALTER TABLE "Transaction"
  ADD COLUMN "reconciledAt" TIMESTAMP(3),
  ADD COLUMN "reconciledById" TEXT;

-- Plain FK (mirrors `userId`'s FK on the same table), but `onDelete: SET
-- NULL` — a deleted user must not corrupt or cascade-delete ledger history.
-- Losing "who reconciled this" is an acceptable degradation; losing the
-- transaction or its `RECONCILED` status is not.
ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_reconciledById_fkey"
  FOREIGN KEY ("reconciledById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Supports the reconciled-by-user lookup and keeps the FK's implicit index.
CREATE INDEX "Transaction_reconciledById_idx" ON "Transaction"("reconciledById");

-- Invariant 1 — "set/cleared together": a reconciliation timestamp with no
-- reconciler (or vice versa) is a half-written, meaningless state.
ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_reconciled_fields_together CHECK (
    ("reconciledAt" IS NULL) = ("reconciledById" IS NULL)
  );

-- Invariant 2 — reconciliation metadata may only be present on a row whose
-- status IS "RECONCILED". This is the durable, row-level half of the
-- reconciliation contract (CLAUDE.md "Database Is the Law"). The other half
-- — WHICH prior status may legally become "RECONCILED" (CLEARED yes,
-- PENDING no) and the "re-reconciling only refreshes the timestamp, never an
-- error" idempotency rule — is a STATE-TRANSITION rule, not a row-shape
-- rule: a CHECK constraint only ever sees the proposed new row, never the
-- row it is replacing, so it structurally cannot express "the previous
-- status was X". That transition guard lives in the application layer
-- instead, inside `setTransactionReconciledFn`'s tenant transaction
-- (src/server/transaction-reconciliation.ts) — the same layering
-- `assertManualTransactionKindShape` already uses for the transfer
-- same-account guard before its DB-CHECK backstop.
ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_reconciled_only_when_status_reconciled CHECK (
    "reconciledAt" IS NULL OR "status" = 'RECONCILED'
  );
