-- DropForeignKey
ALTER TABLE "PendingBalanceCorrection" DROP CONSTRAINT "PendingBalanceCorrection_familyId_fkey";

-- DropIndex
DROP INDEX "Instrument_marketInstrumentId_idx";

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetAmountMinor" BIGINT,
    "targetCurrency" TEXT,
    "targetDate" DATE,
    "riskProfile" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalAccount" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalHoldingAllocation" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "holdingId" TEXT NOT NULL,
    "quantity" DECIMAL(38,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalHoldingAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_familyId_archivedAt_idx" ON "Goal"("familyId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Goal_id_familyId_key" ON "Goal"("id", "familyId");

-- CreateIndex
CREATE INDEX "GoalAccount_familyId_goalId_idx" ON "GoalAccount"("familyId", "goalId");

-- CreateIndex
CREATE UNIQUE INDEX "GoalAccount_accountId_familyId_unique" ON "GoalAccount"("accountId", "familyId");

-- CreateIndex
CREATE INDEX "GoalHoldingAllocation_familyId_holdingId_idx" ON "GoalHoldingAllocation"("familyId", "holdingId");

-- CreateIndex
CREATE UNIQUE INDEX "GoalHoldingAllocation_goalId_holdingId_unique" ON "GoalHoldingAllocation"("goalId", "holdingId");

-- AddForeignKey
ALTER TABLE "PendingBalanceCorrection" ADD CONSTRAINT "PendingBalanceCorrection_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "goal_currency_is_iso_4217" FOREIGN KEY ("targetCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalAccount" ADD CONSTRAINT "GoalAccount_goalId_familyId_fkey" FOREIGN KEY ("goalId", "familyId") REFERENCES "Goal"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalAccount" ADD CONSTRAINT "GoalAccount_accountId_familyId_fkey" FOREIGN KEY ("accountId", "familyId") REFERENCES "Account"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalHoldingAllocation" ADD CONSTRAINT "GoalHoldingAllocation_goalId_familyId_fkey" FOREIGN KEY ("goalId", "familyId") REFERENCES "Goal"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalHoldingAllocation" ADD CONSTRAINT "GoalHoldingAllocation_holdingId_familyId_fkey" FOREIGN KEY ("holdingId", "familyId") REFERENCES "Holding"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Goal — broker-agnostic purpose grouping (Bibit "Portofolio" / Betterment
-- "Goals" / M1 "Pies" generalized). Orthogonal to Account/Holding: pure
-- organizational relabeling, never a ledger Transaction. See schema.prisma
-- comment above `model Goal` for the full rationale.
--
-- CONSERVATION INVARIANT (SUM(GoalHoldingAllocation.quantity) per holdingId
-- must never exceed that Holding's own quantity) is enforced in application
-- code (src/server/goals.ts) and integration-tested against real Postgres,
-- not a DB trigger — mirrors this codebase's existing precedent for other
-- cross-row ledger invariants (e.g. the trade "latest mutation" guard).
-- ============================================================================

-- Domain CHECKs (house convention: String + CHECK, not enums).
ALTER TABLE "Goal"
  ADD CONSTRAINT goal_target_amount_nonnegative
  CHECK ("targetAmountMinor" IS NULL OR "targetAmountMinor" >= 0);
ALTER TABLE "Goal"
  ADD CONSTRAINT goal_target_currency_shape
  CHECK ("targetCurrency" IS NULL OR "targetCurrency" ~ '^[A-Z]{3,5}$');
-- A target amount/date implies a currency to measure it in, and vice versa
-- would be meaningless — keep the three fields consistent as a set.
ALTER TABLE "Goal"
  ADD CONSTRAINT goal_target_amount_requires_currency
  CHECK (("targetAmountMinor" IS NULL) = ("targetCurrency" IS NULL));
ALTER TABLE "Goal"
  ADD CONSTRAINT goal_risk_profile_domain
  CHECK ("riskProfile" IS NULL OR "riskProfile" IN ('conservative', 'moderate', 'aggressive'));

-- A stored allocation must be a real, positive slice — "unallocated" is the
-- ABSENCE of a row, never a zero-quantity one (keeps SUM-based conservation
-- checks simple and avoids dead rows accumulating from repeated re-zeroing).
ALTER TABLE "GoalHoldingAllocation"
  ADD CONSTRAINT goal_holding_allocation_quantity_positive
  CHECK ("quantity" > 0);

-- RLS: tenant isolation + ADR-0036 membership guard (identical pattern to
-- Budget/BudgetCategory).
ALTER TABLE "Goal" ENABLE ROW LEVEL SECURITY;
CREATE POLICY goal_tenant_isolation ON "Goal"
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
ALTER TABLE "Goal" FORCE ROW LEVEL SECURITY;

ALTER TABLE "GoalAccount" ENABLE ROW LEVEL SECURITY;
CREATE POLICY goal_account_tenant_isolation ON "GoalAccount"
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
ALTER TABLE "GoalAccount" FORCE ROW LEVEL SECURITY;

ALTER TABLE "GoalHoldingAllocation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY goal_holding_allocation_tenant_isolation ON "GoalHoldingAllocation"
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
ALTER TABLE "GoalHoldingAllocation" FORCE ROW LEVEL SECURITY;
