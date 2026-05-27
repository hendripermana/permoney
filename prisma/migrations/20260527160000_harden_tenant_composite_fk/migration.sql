-- PER-104: DB-level tenant composite foreign-key invariants.
--
-- Two patterns, applied based on whether the referenced table has a
-- non-nullable familyId. See docs/adr/0010 for the full rationale.
--
--   Pattern A (composite FK): tenant tables with familyId NOT NULL get a
--   UNIQUE (id, familyId) and references switch to composite FK on
--   (refId, familyId). MATCH SIMPLE handles nullable refId columns
--   correctly: when refId is NULL, the FK is not checked.
--
--   Pattern B (constraint trigger): cases where Pattern A cannot apply —
--   Category (familyId nullable for system rows), SplitEntry (no own
--   familyId), Transfer (leg pair must share family), User actor
--   (User.familyId nullable until onboarded).
--
-- Migration order:
--   1. Fail-loud data repair: abort if any pre-existing row violates the
--      cross-tenant invariant. The development database was audited clean
--      before authoring this migration; the guard is for CI/production.
--   2. Add composite UNIQUE on Account, Merchant.
--   3. Replace single-column FKs on Transaction and SmartRule with
--      composite FKs.
--   4. Create the constraint-trigger helper functions.
--   5. Attach constraint triggers to Transaction, SplitEntry, SmartRule,
--      Transfer, Category.

-- ============================================================================
-- 1. Fail-loud data repair guard
-- ============================================================================

DO $$
DECLARE
  cross_tenant_count INT;
  detail_message TEXT;
BEGIN
  SELECT COUNT(*) INTO cross_tenant_count
  FROM (
    SELECT 1 FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
      WHERE a."familyId" <> t."familyId"
    UNION ALL
    SELECT 1 FROM "Transaction" t JOIN "Account" a ON a.id = t."toAccountId"
      WHERE a."familyId" <> t."familyId"
    UNION ALL
    SELECT 1 FROM "Transaction" t JOIN "Merchant" m ON m.id = t."merchantId"
      WHERE m."familyId" <> t."familyId"
    UNION ALL
    SELECT 1 FROM "Transaction" t JOIN "Category" c ON c.id = t."categoryId"
      WHERE c."isSystem" = false AND c."familyId" <> t."familyId"
    UNION ALL
    SELECT 1 FROM "Transaction" t JOIN "User" u ON u.id = t."userId"
      WHERE u."familyId" IS DISTINCT FROM t."familyId"
    UNION ALL
    SELECT 1 FROM "SplitEntry" s
      JOIN "Transaction" t ON t.id = s."transactionId"
      JOIN "Merchant" m ON m.id = s."merchantId"
      WHERE m."familyId" <> t."familyId"
    UNION ALL
    SELECT 1 FROM "SplitEntry" s
      JOIN "Transaction" t ON t.id = s."transactionId"
      JOIN "Category" c ON c.id = s."categoryId"
      WHERE c."isSystem" = false AND c."familyId" <> t."familyId"
    UNION ALL
    SELECT 1 FROM "SmartRule" r JOIN "Merchant" m ON m.id = r."merchantId"
      WHERE m."familyId" <> r."familyId"
    UNION ALL
    SELECT 1 FROM "SmartRule" r JOIN "Category" c ON c.id = r."categoryId"
      WHERE c."isSystem" = false AND c."familyId" <> r."familyId"
    UNION ALL
    SELECT 1 FROM "Transfer" tr
      JOIN "Transaction" tout ON tout.id = tr."outflowTransactionId"
      JOIN "Transaction" tin ON tin.id = tr."inflowTransactionId"
      WHERE tout."familyId" <> tin."familyId"
    UNION ALL
    SELECT 1 FROM "Category" c JOIN "Category" p ON p.id = c."parentId"
      WHERE NOT (
        (p."isSystem" = true AND p."familyId" IS NULL)
        OR (p."familyId" IS NOT DISTINCT FROM c."familyId")
      )
  ) AS violations;

  IF cross_tenant_count > 0 THEN
    detail_message := format(
      'PER-104 migration aborted: %s pre-existing cross-tenant FK violation(s) detected. Manual reconciliation required before re-running.',
      cross_tenant_count
    );
    RAISE EXCEPTION '%', detail_message;
  END IF;
END
$$;

-- ============================================================================
-- 2. Composite UNIQUE on Account and Merchant (Pattern A target)
-- ============================================================================

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_id_familyId_key" UNIQUE (id, "familyId");

ALTER TABLE "Merchant"
  ADD CONSTRAINT "Merchant_id_familyId_key" UNIQUE (id, "familyId");

-- ============================================================================
-- 3. Replace single-column FKs with composite FKs
-- ============================================================================

ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_accountId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_toAccountId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_merchantId_fkey";
ALTER TABLE "SmartRule"  DROP CONSTRAINT IF EXISTS "SmartRule_merchantId_fkey";

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_accountId_familyId_fkey"
  FOREIGN KEY ("accountId", "familyId")
  REFERENCES "Account" (id, "familyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_toAccountId_familyId_fkey"
  FOREIGN KEY ("toAccountId", "familyId")
  REFERENCES "Account" (id, "familyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_merchantId_familyId_fkey"
  FOREIGN KEY ("merchantId", "familyId")
  REFERENCES "Merchant" (id, "familyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SmartRule"
  ADD CONSTRAINT "SmartRule_merchantId_familyId_fkey"
  FOREIGN KEY ("merchantId", "familyId")
  REFERENCES "Merchant" (id, "familyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 4. Constraint-trigger helper functions (Pattern B)
-- ============================================================================

-- 4.1 Category reference validator: "system OR same family".
-- Resolves the source family by table.
CREATE OR REPLACE FUNCTION enforce_category_tenant_invariant()
RETURNS TRIGGER AS $$
DECLARE
  source_family TEXT;
  cat_family    TEXT;
  cat_is_system BOOLEAN;
  category_id   TEXT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'Transaction' THEN
      category_id := NEW."categoryId";
      source_family := NEW."familyId";
    WHEN 'SmartRule' THEN
      category_id := NEW."categoryId";
      source_family := NEW."familyId";
    WHEN 'SplitEntry' THEN
      category_id := NEW."categoryId";
      SELECT t."familyId" INTO source_family
        FROM "Transaction" t WHERE t.id = NEW."transactionId";
      IF source_family IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = format(
            'PER-104 SplitEntry %s references missing parent transaction %s',
            NEW.id, NEW."transactionId"
          );
      END IF;
    WHEN 'Category' THEN
      category_id := NEW."parentId";
      source_family := NEW."familyId";
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = 'undefined_table',
        MESSAGE = format(
          'PER-104 enforce_category_tenant_invariant attached to unsupported table %s',
          TG_TABLE_NAME
        );
  END CASE;

  IF category_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c."familyId", c."isSystem" INTO cat_family, cat_is_system
    FROM "Category" c WHERE c.id = category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'foreign_key_violation',
      MESSAGE = format(
        'PER-104 %s references missing Category %s',
        TG_TABLE_NAME, category_id
      );
  END IF;

  IF cat_is_system = true AND cat_family IS NULL THEN
    RETURN NEW;
  END IF;

  IF cat_family IS NOT DISTINCT FROM source_family THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      'PER-104 cross-tenant Category reference rejected (%s -> Category %s): source family=%s, category family=%s',
      TG_TABLE_NAME, category_id, source_family, cat_family
    );
END;
$$ LANGUAGE plpgsql;

-- 4.2 SplitEntry merchant validator: must share parent transaction's family.
CREATE OR REPLACE FUNCTION enforce_split_entry_merchant_tenant_invariant()
RETURNS TRIGGER AS $$
DECLARE
  source_family   TEXT;
  merchant_family TEXT;
BEGIN
  IF NEW."merchantId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t."familyId" INTO source_family
    FROM "Transaction" t WHERE t.id = NEW."transactionId";
  IF source_family IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'PER-104 SplitEntry %s references missing parent transaction %s',
        NEW.id, NEW."transactionId"
      );
  END IF;

  SELECT m."familyId" INTO merchant_family
    FROM "Merchant" m WHERE m.id = NEW."merchantId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'foreign_key_violation',
      MESSAGE = format(
        'PER-104 SplitEntry %s references missing Merchant %s',
        NEW.id, NEW."merchantId"
      );
  END IF;

  IF merchant_family = source_family THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      'PER-104 cross-tenant Merchant reference rejected (SplitEntry -> Merchant %s): source family=%s, merchant family=%s',
      NEW."merchantId", source_family, merchant_family
    );
END;
$$ LANGUAGE plpgsql;

-- 4.3 User actor validator: User.familyId must equal Transaction.familyId.
CREATE OR REPLACE FUNCTION enforce_transaction_user_tenant_invariant()
RETURNS TRIGGER AS $$
DECLARE
  user_family TEXT;
BEGIN
  SELECT u."familyId" INTO user_family
    FROM "User" u WHERE u.id = NEW."userId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'foreign_key_violation',
      MESSAGE = format(
        'PER-104 Transaction %s references missing User %s',
        NEW.id, NEW."userId"
      );
  END IF;

  IF user_family IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'PER-104 cross-tenant User actor rejected: Transaction %s references unonboarded User %s (no family yet)',
        NEW.id, NEW."userId"
      );
  END IF;

  IF user_family <> NEW."familyId" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'PER-104 cross-tenant User actor rejected (Transaction -> User %s): transaction family=%s, user family=%s',
        NEW."userId", NEW."familyId", user_family
      );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4.4 Transfer leg-pair validator: outflow.familyId must equal inflow.familyId.
CREATE OR REPLACE FUNCTION enforce_transfer_leg_pair_tenant_invariant()
RETURNS TRIGGER AS $$
DECLARE
  outflow_family TEXT;
  inflow_family  TEXT;
BEGIN
  SELECT t."familyId" INTO outflow_family
    FROM "Transaction" t WHERE t.id = NEW."outflowTransactionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'foreign_key_violation',
      MESSAGE = format(
        'PER-104 Transfer %s references missing outflow Transaction %s',
        NEW.id, NEW."outflowTransactionId"
      );
  END IF;

  SELECT t."familyId" INTO inflow_family
    FROM "Transaction" t WHERE t.id = NEW."inflowTransactionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'foreign_key_violation',
      MESSAGE = format(
        'PER-104 Transfer %s references missing inflow Transaction %s',
        NEW.id, NEW."inflowTransactionId"
      );
  END IF;

  IF outflow_family = inflow_family THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      'PER-104 cross-tenant Transfer leg pair rejected (Transfer -> outflow %s, inflow %s): outflow family=%s, inflow family=%s',
      NEW."outflowTransactionId", NEW."inflowTransactionId",
      outflow_family, inflow_family
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 5. Constraint triggers
-- ============================================================================

CREATE CONSTRAINT TRIGGER transaction_category_tenant_safe
  AFTER INSERT OR UPDATE OF "categoryId", "familyId" ON "Transaction"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_category_tenant_invariant();

CREATE CONSTRAINT TRIGGER transaction_user_tenant_safe
  AFTER INSERT OR UPDATE OF "userId", "familyId" ON "Transaction"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_transaction_user_tenant_invariant();

CREATE CONSTRAINT TRIGGER split_entry_category_tenant_safe
  AFTER INSERT OR UPDATE OF "categoryId", "transactionId" ON "SplitEntry"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_category_tenant_invariant();

CREATE CONSTRAINT TRIGGER split_entry_merchant_tenant_safe
  AFTER INSERT OR UPDATE OF "merchantId", "transactionId" ON "SplitEntry"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_split_entry_merchant_tenant_invariant();

CREATE CONSTRAINT TRIGGER smart_rule_category_tenant_safe
  AFTER INSERT OR UPDATE OF "categoryId", "familyId" ON "SmartRule"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_category_tenant_invariant();

CREATE CONSTRAINT TRIGGER transfer_leg_pair_tenant_safe
  AFTER INSERT OR UPDATE OF "outflowTransactionId", "inflowTransactionId" ON "Transfer"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_leg_pair_tenant_invariant();

CREATE CONSTRAINT TRIGGER category_parent_tenant_safe
  AFTER INSERT OR UPDATE OF "parentId", "familyId" ON "Category"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_category_tenant_invariant();
