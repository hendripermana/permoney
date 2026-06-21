-- ============================================================================
-- PER-148 / ADR-0037 — Budget period model, progress derivation, authorization
--
-- Two tenant-scoped tables:
--   * Budget          — a concrete PERIOD INSTANCE (monthly built; weekly/custom
--                       reserved). Date-only anchors in family timezone. The only
--                       durable money is the per-category allocation below.
--   * BudgetCategory  — per-category allocation (base-currency minor units),
--                       composite-FK'd to its Budget so it can never cross tenants.
--
-- Actual/remaining/over are NOT stored: they are derived read-side from the
-- canonical ledger via each Transaction's materialized baseAmount (ADR-0035).
--
-- RLS uses the ADR-0036 membership guard (app_is_active_member) on both tables,
-- identical to Account/Transaction/FxRateSnapshot.
-- ============================================================================

-- 1. Budget ------------------------------------------------------------------

CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodKind" TEXT NOT NULL DEFAULT 'monthly',
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- One budget per family per period kind per start (idempotent upsert target).
CREATE UNIQUE INDEX "budget_family_period_unique"
  ON "Budget"("familyId", "periodKind", "periodStart");

CREATE INDEX "Budget_familyId_archivedAt_periodStart_idx"
  ON "Budget"("familyId", "archivedAt", "periodStart" DESC);

-- Composite-FK target (named UNIQUE constraint, not just an index, so it can be
-- referenced by BudgetCategory's composite FK — ADR-0010 pattern).
ALTER TABLE "Budget"
  ADD CONSTRAINT "Budget_id_familyId_key" UNIQUE ("id", "familyId");

ALTER TABLE "Budget" ADD CONSTRAINT "Budget_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Budget" ADD CONSTRAINT "budget_currency_is_iso_4217"
  FOREIGN KEY ("currency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain CHECKs (house convention: String + CHECK, not enums).
ALTER TABLE "Budget"
  ADD CONSTRAINT budget_period_kind_domain
  CHECK ("periodKind" IN ('monthly', 'weekly', 'custom'));
ALTER TABLE "Budget"
  ADD CONSTRAINT budget_period_order
  CHECK ("periodEnd" >= "periodStart");
ALTER TABLE "Budget"
  ADD CONSTRAINT budget_currency_shape
  CHECK ("currency" ~ '^[A-Z]{3,5}$');

-- RLS: tenant isolation + ADR-0036 membership guard.
ALTER TABLE "Budget" ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_tenant_isolation ON "Budget"
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
ALTER TABLE "Budget" FORCE ROW LEVEL SECURITY;

-- 2. BudgetCategory ----------------------------------------------------------

CREATE TABLE "BudgetCategory" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "allocatedAmount" BIGINT NOT NULL,
    "rolloverPolicy" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetCategory_pkey" PRIMARY KEY ("id")
);

-- One allocation per category per budget.
CREATE UNIQUE INDEX "budget_category_unique"
  ON "BudgetCategory"("budgetId", "categoryId");
CREATE INDEX "BudgetCategory_familyId_idx" ON "BudgetCategory"("familyId");
CREATE INDEX "BudgetCategory_categoryId_idx" ON "BudgetCategory"("categoryId");

-- Composite tenant FK: a line item can never point at another family's budget.
ALTER TABLE "BudgetCategory" ADD CONSTRAINT "budget_category_budget_family_fkey"
  FOREIGN KEY ("budgetId", "familyId") REFERENCES "Budget"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain CHECKs.
ALTER TABLE "BudgetCategory"
  ADD CONSTRAINT budget_category_allocated_nonnegative
  CHECK ("allocatedAmount" >= 0);
ALTER TABLE "BudgetCategory"
  ADD CONSTRAINT budget_category_rollover_domain
  CHECK ("rolloverPolicy" IN ('none', 'carryover'));

-- RLS: tenant isolation + ADR-0036 membership guard.
ALTER TABLE "BudgetCategory" ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_category_tenant_isolation ON "BudgetCategory"
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
ALTER TABLE "BudgetCategory" FORCE ROW LEVEL SECURITY;
