-- PER-268 / ADR-0043 anchor-provenance amendment — smallest-viable
-- notification for a HISTORICAL balance correction.
--
-- Before PER-264/265/266 shipped, every anchor used the permissive `derived`
-- afterAnchor rule, so an account whose owner interactively reconciled it and
-- later logged a backdated transaction may have a materialized
-- `Account.balance` that still double-counts that transaction, even though
-- the calculator itself is fixed going forward (an account heals on its next
-- write via `rebuildIfGroundTruthAnchored` / anchor-rebuild.server.ts). A row
-- here is a plain notification record: "this account's stored balance
-- disagrees with the corrected canonical formula, and the owner has not yet
-- approved the fix." Writing one never touches `Account.balance` or
-- `Valuation` — see src/server/balance-correction.server.ts.

CREATE TABLE "PendingBalanceCorrection" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "previousBalance" BIGINT NOT NULL,
    "correctedBalance" BIGINT NOT NULL,
    "driftAmount" BIGINT NOT NULL,
    "anchorValuationId" TEXT,
    "anchorDate" DATE,
    "anchorProvenance" TEXT,
    "ticketRef" TEXT NOT NULL DEFAULT 'PER-268',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "PendingBalanceCorrection_pkey" PRIMARY KEY ("id")
);

-- One live correction per account: a second staging pass on an already
-- pending row refreshes the numbers in place instead of creating a duplicate.
CREATE UNIQUE INDEX "PendingBalanceCorrection_accountId_key"
  ON "PendingBalanceCorrection"("accountId");
CREATE INDEX "PendingBalanceCorrection_familyId_status_idx"
  ON "PendingBalanceCorrection"("familyId", "status");

-- Tenant-safe composite FK to Account(id, familyId) — Pattern A (ADR-0010),
-- same shape as BudgetCategory -> Budget. Cascade delete: if the account
-- itself is ever hard-deleted, its pending correction (if any) goes with it.
ALTER TABLE "PendingBalanceCorrection"
  ADD CONSTRAINT "PendingBalanceCorrection_accountId_familyId_fkey"
  FOREIGN KEY ("accountId", "familyId") REFERENCES "Account"("id", "familyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PendingBalanceCorrection" ADD CONSTRAINT "PendingBalanceCorrection_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain CHECKs (house convention: String + CHECK, not enums).
ALTER TABLE "PendingBalanceCorrection"
  ADD CONSTRAINT pending_balance_correction_status_domain
  CHECK ("status" IN ('pending', 'applied'));
ALTER TABLE "PendingBalanceCorrection"
  ADD CONSTRAINT pending_balance_correction_provenance_domain
  CHECK ("anchorProvenance" IS NULL OR "anchorProvenance" IN ('ground_truth', 'derived'));
-- `appliedAt` is set exactly when the row transitions to "applied", never
-- before and never left unset after.
ALTER TABLE "PendingBalanceCorrection"
  ADD CONSTRAINT pending_balance_correction_applied_at_matches_status
  CHECK (
    ("status" = 'applied' AND "appliedAt" IS NOT NULL)
    OR ("status" = 'pending' AND "appliedAt" IS NULL)
  );

-- RLS: tenant isolation + ADR-0036 membership guard, identical shape to
-- Budget/BudgetCategory.
ALTER TABLE "PendingBalanceCorrection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY pending_balance_correction_tenant_isolation ON "PendingBalanceCorrection"
  FOR ALL
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );
ALTER TABLE "PendingBalanceCorrection" FORCE ROW LEVEL SECURITY;
