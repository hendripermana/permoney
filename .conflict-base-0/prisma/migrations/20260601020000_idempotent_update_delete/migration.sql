-- PER-93 / ADR-0032: Idempotent update/delete semantics.
--
-- Update stops hard-deleting ledger rows. A replacement transaction now gets a
-- new primary id and links to the old, soft-deleted row through a one-to-one
-- supersession edge. Delete and update replay through IdempotencyRecord rows at
-- the application layer; this migration owns the durable Transaction links.

-- ============================================================================
-- 1. Fail-loud drift guard.
-- ============================================================================
-- If an environment already contains soft-deleted Transaction rows, they must
-- have a soft-delete audit row with before/after JSON before supersession links
-- are added over the same history. The development database was audited clean:
-- deleted transactions = 0, missing soft-delete audit = 0, hard-delete-style
-- Transaction audit rows = 0.
DO $$
DECLARE
  deleted_without_audit INT;
  half_deleted_transfers INT;
BEGIN
  SELECT COUNT(*)
    INTO deleted_without_audit
    FROM "Transaction" t
    WHERE t."deletedAt" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM "AuditLog" a
          WHERE a."entityType" = 'Transaction'
            AND a."entityId" = t.id
            AND a.action = 'soft_delete'
            AND a."beforeJson" IS NOT NULL
            AND a."afterJson" IS NOT NULL
      );

  SELECT COUNT(*)
    INTO half_deleted_transfers
    FROM "Transfer" tr
    JOIN "Transaction" tout ON tout.id = tr."outflowTransactionId"
    JOIN "Transaction" tin  ON tin.id  = tr."inflowTransactionId"
    WHERE (tr."deletedAt" IS NULL) <> (tout."deletedAt" IS NULL)
       OR (tr."deletedAt" IS NULL) <> (tin."deletedAt" IS NULL);

  IF deleted_without_audit > 0 OR half_deleted_transfers > 0 THEN
    RAISE EXCEPTION
      'PER-93 migration aborted: soft-delete drift detected (deleted-without-audit=%, transfer-symmetry=%). Manual reconciliation required before re-running.',
      deleted_without_audit, half_deleted_transfers;
  END IF;
END
$$;

-- ============================================================================
-- 2. Supersession columns and one-to-one indexes.
-- ============================================================================
ALTER TABLE "Transaction"
  ADD COLUMN "supersededBy" TEXT,
  ADD COLUMN "supersedes" TEXT;

CREATE UNIQUE INDEX "Transaction_supersededBy_key"
  ON "Transaction"("supersededBy");

CREATE UNIQUE INDEX "Transaction_supersedes_key"
  ON "Transaction"("supersedes");

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_supersededBy_fkey"
    FOREIGN KEY ("supersededBy")
    REFERENCES "Transaction"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_supersedes_fkey"
    FOREIGN KEY ("supersedes")
    REFERENCES "Transaction"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- A row that points to its successor is historical and must already be closed.
-- The replacement row points backward through supersedes and may remain active.
ALTER TABLE "Transaction"
  ADD CONSTRAINT "transaction_superseded_rows_are_soft_deleted"
    CHECK ("supersededBy" IS NULL OR "deletedAt" IS NOT NULL),
  ADD CONSTRAINT "transaction_superseded_by_not_self"
    CHECK ("supersededBy" IS NULL OR "supersededBy" <> id),
  ADD CONSTRAINT "transaction_supersedes_not_self"
    CHECK ("supersedes" IS NULL OR "supersedes" <> id);
