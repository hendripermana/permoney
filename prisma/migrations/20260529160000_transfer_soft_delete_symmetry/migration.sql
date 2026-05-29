-- PER-20 / ADR-0012: Transfer soft-delete symmetry + onDelete: Restrict.
--
-- Two changes, paired together:
--
--   1. Switch both Transfer foreign keys from `ON DELETE CASCADE` to
--      `ON DELETE RESTRICT`. Postgres now refuses any future hard DELETE on
--      a Transaction row referenced by a Transfer. Every code path that
--      depends on hard-deleting a transfer leg must declare its dependency
--      on the Transfer row explicitly.
--   2. Add `Transfer.deletedAt` plus an index. A transfer is one money
--      movement; when either Transaction leg is soft-deleted, this shadow
--      column is set in the same `$transaction`, so the audit trail of the
--      transfer row itself survives.
--
-- AGENTS.md § 5.A "No Hard Delete for Ledger History" + "AuditLog Required
-- for Mutations" both apply here. ADR-0012 documents the soft-delete
-- symmetry rule, the interim updateTransactionForFamily reversal pattern,
-- and the explicit non-scope (PER-93 redesigns reversal).

-- ============================================================================
-- 1. Drift guard.
-- ============================================================================
-- Abort the migration if any pre-existing Transfer row references a
-- non-existent Transaction (Cascade would have kept the schema consistent,
-- but defense-in-depth: refuse silently broken rows on the way in).
DO $$
DECLARE
  orphaned_outflow INT;
  orphaned_inflow INT;
BEGIN
  SELECT COUNT(*)
    INTO orphaned_outflow
    FROM "Transfer" tr
    LEFT JOIN "Transaction" t ON t.id = tr."outflowTransactionId"
    WHERE t.id IS NULL;

  SELECT COUNT(*)
    INTO orphaned_inflow
    FROM "Transfer" tr
    LEFT JOIN "Transaction" t ON t.id = tr."inflowTransactionId"
    WHERE t.id IS NULL;

  IF orphaned_outflow > 0 OR orphaned_inflow > 0 THEN
    RAISE EXCEPTION
      'PER-20 migration aborted: % orphaned outflow + % orphaned inflow Transfer row(s). Manual reconciliation required before re-running.',
      orphaned_outflow, orphaned_inflow;
  END IF;
END
$$;

-- ============================================================================
-- 2. Switch foreign keys to RESTRICT.
-- ============================================================================
ALTER TABLE "Transfer"
  DROP CONSTRAINT IF EXISTS "Transfer_outflowTransactionId_fkey";
ALTER TABLE "Transfer"
  DROP CONSTRAINT IF EXISTS "Transfer_inflowTransactionId_fkey";

ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_outflowTransactionId_fkey"
    FOREIGN KEY ("outflowTransactionId")
    REFERENCES "Transaction" (id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_inflowTransactionId_fkey"
    FOREIGN KEY ("inflowTransactionId")
    REFERENCES "Transaction" (id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 3. Add Transfer.deletedAt shadow column + index.
-- ============================================================================
ALTER TABLE "Transfer"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Transfer_deletedAt_idx" ON "Transfer" ("deletedAt");
