-- CreateTable
CREATE TABLE "FamilyMember" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "invitedById" TEXT,
    "invitedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FamilyMember_familyId_status_idx" ON "FamilyMember"("familyId", "status");

-- CreateIndex
CREATE INDEX "FamilyMember_userId_idx" ON "FamilyMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyMember_familyId_userId_key" ON "FamilyMember"("familyId", "userId");

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- ADR-0036 — Family membership & role authorization model (PER-144, F4)
--
-- `FamilyMember` is the authoritative membership + role record. Tenant access
-- is driven by an `active` row here at BOTH layers: app-layer
-- `requireCapability(cap)` and a database-layer `app_is_active_member()` guard
-- bolted onto every tenant-table RLS policy.
--
-- Ordering matters: the backfill below runs BEFORE RLS is enabled on
-- `FamilyMember`, because the migrate runner is NOBYPASSRLS (ADR-0014) and would
-- otherwise be rejected by FamilyMember's own WITH CHECK (no `app.family_id`
-- GUC is set during a migration).
-- ============================================================================

-- 1. Domain CHECK constraints (house convention: String + CHECK, not enums).
ALTER TABLE "FamilyMember"
  ADD CONSTRAINT "family_member_role_domain"
  CHECK ("role" IN ('owner', 'admin', 'member', 'viewer'));

ALTER TABLE "FamilyMember"
  ADD CONSTRAINT "family_member_status_domain"
  CHECK ("status" IN ('active', 'invited', 'revoked'));

-- 2. Backfill: every existing user with a family becomes an active owner.
--    Multi-user families -> all owners, preserving today's full-power behavior
--    and guaranteeing no family is left without an owner (ADR-0036 §8). Runs
--    before RLS is enabled (see header). Deterministic id keeps re-runs safe.
INSERT INTO "FamilyMember" (
  "id", "familyId", "userId", "role", "status", "joinedAt", "createdAt", "updatedAt"
)
SELECT
  'fm_' || md5(u."id" || ':' || u."familyId"),
  u."familyId",
  u."id",
  'owner',
  'active',
  u."createdAt",
  now(),
  now()
FROM "User" u
WHERE u."familyId" IS NOT NULL
ON CONFLICT ("familyId", "userId") DO NOTHING;

-- 3. Membership predicate helper. SECURITY DEFINER so it can read "FamilyMember"
--    regardless of the CALLER's table privileges: every tenant-table policy
--    calls this, including writes by roles that have no grant on FamilyMember
--    (e.g. the permoney_system_maintainer seeding a system Category). With
--    SECURITY INVOKER those roles hit "permission denied for table FamilyMember"
--    when the policy expression is evaluated. Recursion-free because
--    FamilyMember's own RLS is plain tenant isolation (step 4) and the function
--    is always called with `fam = current_setting('app.family_id')`. NULL `usr`
--    (unset `app.user_id` GUC) yields false -> fail closed. `search_path` is
--    pinned (SECURITY DEFINER hardening).
CREATE OR REPLACE FUNCTION app_is_active_member(fam text, usr text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "FamilyMember" m
    WHERE m."familyId" = fam
      AND m."userId" = usr
      AND m."status" = 'active'
  )
$$;

-- 4. FamilyMember RLS: plain tenant isolation (familyId = GUC). Member-only
--    enumeration is enforced at the app layer (familyMiddleware gates which
--    family GUC can be set; getMembersFn requires membership). Keeping this
--    policy simple is what makes step 3 recursion-free and lets onboarding
--    bootstrap the first owner under WITH CHECK before any data write.
ALTER TABLE "FamilyMember" ENABLE ROW LEVEL SECURITY;

CREATE POLICY family_member_tenant_isolation ON "FamilyMember"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "FamilyMember" FORCE ROW LEVEL SECURITY;

-- 5. Last-owner protection (cross-row invariant -> trigger, not CHECK).
--    Rejects any UPDATE/DELETE that would leave a family with zero active
--    owners. Reuses the PER-104 check_violation SQLSTATE helper so the app
--    can map it to a friendly CONFLICT/FORBIDDEN error.
CREATE OR REPLACE FUNCTION enforce_family_has_owner()
RETURNS TRIGGER AS $$
DECLARE
  remaining_owners INT;
BEGIN
  -- Only relevant when the row being changed is currently an active owner.
  IF NOT (OLD."role" = 'owner' AND OLD."status" = 'active') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- An UPDATE that keeps the row an active owner is always fine.
  IF TG_OP = 'UPDATE' AND NEW."role" = 'owner' AND NEW."status" = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO remaining_owners
  FROM "FamilyMember"
  WHERE "familyId" = OLD."familyId"
    AND "role" = 'owner'
    AND "status" = 'active'
    AND "id" <> OLD."id";

  IF remaining_owners = 0 THEN
    PERFORM _per104_raise_check_violation(format(
      'FamilyMember %s: cannot remove or demote the last active owner of family %s',
      OLD."id", OLD."familyId"
    ));
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER family_must_have_owner
  BEFORE UPDATE OR DELETE ON "FamilyMember"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_family_has_owner();

-- ============================================================================
-- 6. Deep RLS — bolt the membership guard onto every tenant-table policy.
--    Each policy now requires BOTH `familyId = app.family_id` AND an active
--    membership for `app.user_id`. Because both GUCs are constants, the
--    app_is_active_member() call is a once-per-query InitPlan, not a per-row
--    correlated subquery. Privileged role-targeted policies
--    (permoney_system_maintainer, permoney_audit_retention) are left untouched.
-- ============================================================================

-- Account
DROP POLICY IF EXISTS account_tenant_isolation ON "Account";
CREATE POLICY account_tenant_isolation ON "Account"
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

-- Merchant
DROP POLICY IF EXISTS merchant_tenant_isolation ON "Merchant";
CREATE POLICY merchant_tenant_isolation ON "Merchant"
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

-- Transaction
DROP POLICY IF EXISTS transaction_tenant_isolation ON "Transaction";
CREATE POLICY transaction_tenant_isolation ON "Transaction"
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

-- SmartRule
DROP POLICY IF EXISTS smart_rule_tenant_isolation ON "SmartRule";
CREATE POLICY smart_rule_tenant_isolation ON "SmartRule"
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

-- Valuation
DROP POLICY IF EXISTS valuation_tenant_isolation ON "Valuation";
CREATE POLICY valuation_tenant_isolation ON "Valuation"
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

-- FxRateSnapshot
DROP POLICY IF EXISTS fx_rate_snapshot_tenant_isolation ON "FxRateSnapshot";
CREATE POLICY fx_rate_snapshot_tenant_isolation ON "FxRateSnapshot"
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

-- IdempotencyRecord
DROP POLICY IF EXISTS idempotency_record_tenant_isolation ON "IdempotencyRecord";
CREATE POLICY idempotency_record_tenant_isolation ON "IdempotencyRecord"
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

-- SplitEntry — scoped through its parent Transaction + membership guard.
DROP POLICY IF EXISTS split_entry_tenant_isolation ON "SplitEntry";
CREATE POLICY split_entry_tenant_isolation ON "SplitEntry"
  FOR ALL
  USING (
    "transactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    "transactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

-- Transfer — scoped through its parent Transaction + membership guard.
DROP POLICY IF EXISTS transfer_tenant_isolation ON "Transfer";
CREATE POLICY transfer_tenant_isolation ON "Transfer"
  FOR ALL
  USING (
    "outflowTransactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    "outflowTransactionId" IN (
      SELECT id FROM "Transaction"
      WHERE "familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

-- AuditLog — tenant select/insert gain the guard; retention role policies
-- (permoney_audit_retention) are untouched.
DROP POLICY IF EXISTS audit_log_tenant_select ON "AuditLog";
CREATE POLICY audit_log_tenant_select ON "AuditLog"
  FOR SELECT
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

DROP POLICY IF EXISTS audit_log_tenant_insert ON "AuditLog";
CREATE POLICY audit_log_tenant_insert ON "AuditLog"
  FOR INSERT
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

-- Category — membership guard wraps only the tenant branch; the global system
-- category branch (isSystem) stays readable without membership, and the
-- permoney_system_maintenance role policy is untouched.
DROP POLICY IF EXISTS category_tenant_select ON "Category";
CREATE POLICY category_tenant_select ON "Category"
  FOR SELECT
  USING (
    (
      "familyId" = current_setting('app.family_id', true)::text
      AND app_is_active_member(
        current_setting('app.family_id', true)::text,
        current_setting('app.user_id', true)::text
      )
    )
    OR ("isSystem" = true AND "familyId" IS NULL)
  );

DROP POLICY IF EXISTS category_tenant_insert ON "Category";
CREATE POLICY category_tenant_insert ON "Category"
  FOR INSERT
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

DROP POLICY IF EXISTS category_tenant_update ON "Category";
CREATE POLICY category_tenant_update ON "Category"
  FOR UPDATE
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

DROP POLICY IF EXISTS category_tenant_delete ON "Category";
CREATE POLICY category_tenant_delete ON "Category"
  FOR DELETE
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );
