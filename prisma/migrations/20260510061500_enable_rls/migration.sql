-- M1-5: Enable Row Level Security on every tenant-scoped table.
--
-- This is defense-in-depth. M1-4 (withFamily HOC + scopeTenant Prisma
-- extension) is the application-layer wall. RLS is the database-layer wall:
-- even if the app forgets to pass `where: { familyId }`, Postgres refuses
-- to read or write cross-tenant rows.
--
-- The GUC `app.family_id` is set at the start of every Prisma $transaction
-- via `SELECT set_config('app.family_id', $1, true)`. The `true` third
-- argument scopes the setting to the current transaction, preventing leaks
-- between pooled connections.
--
-- Non-scoped tables (no familyId column):
--   Family, User, Session, AuthAccount, Verification
-- These are gated by the auth middleware, not RLS.

-- ============================================================================
-- 1. Account
-- ============================================================================
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_tenant_isolation ON "Account"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "Account" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. Merchant
-- ============================================================================
ALTER TABLE "Merchant" ENABLE ROW LEVEL SECURITY;

CREATE POLICY merchant_tenant_isolation ON "Merchant"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "Merchant" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. Category
-- ============================================================================
-- Special: system categories ("isSystem" = true, "familyId" IS NULL) are
-- globally readable. Tenant-scoped categories are gated like other tables.
ALTER TABLE "Category" ENABLE ROW LEVEL SECURITY;

CREATE POLICY category_tenant_isolation ON "Category"
  FOR ALL
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    OR "isSystem" = true
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    OR "isSystem" = true
  );

ALTER TABLE "Category" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. Transaction
-- ============================================================================
ALTER TABLE "Transaction" ENABLE ROW LEVEL SECURITY;

CREATE POLICY transaction_tenant_isolation ON "Transaction"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "Transaction" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. SmartRule
-- ============================================================================
ALTER TABLE "SmartRule" ENABLE ROW LEVEL SECURITY;

CREATE POLICY smart_rule_tenant_isolation ON "SmartRule"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "SmartRule" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. SplitEntry — scoped through its parent Transaction
-- ============================================================================
ALTER TABLE "SplitEntry" ENABLE ROW LEVEL SECURITY;

CREATE POLICY split_entry_tenant_isolation ON "SplitEntry"
  FOR ALL
  USING (
    "transactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
  )
  WITH CHECK (
    "transactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
  );

ALTER TABLE "SplitEntry" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 7. Transfer — scoped through its parent Transaction
-- ============================================================================
ALTER TABLE "Transfer" ENABLE ROW LEVEL SECURITY;

CREATE POLICY transfer_tenant_isolation ON "Transfer"
  FOR ALL
  USING (
    "outflowTransactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
  )
  WITH CHECK (
    "outflowTransactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
  );

ALTER TABLE "Transfer" FORCE ROW LEVEL SECURITY;
