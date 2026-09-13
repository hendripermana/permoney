-- PER-102: System categories are global read-only reference data for app
-- traffic. The app role may read them for every tenant, but only privileged
-- migration/seed/admin paths may create or mutate global category metadata.
--
-- Defense-in-depth: the CHECK constraint locks the (isSystem, familyId) shape
-- at the schema layer. RLS protects app-role traffic; the CHECK protects
-- against any privileged path (seed, future bank-sync mappers, AI enrichment
-- jobs, manual SQL) that could otherwise create rows that violate the
-- assumption baked into the SELECT policy. See docs/adr/0009.

-- Data repair pass: pre-existing rows that violate the new invariant come
-- from earlier seed iterations and are pure metadata drift. The migration
-- aborts with a loud error if any of these rows are referenced by a
-- Transaction or SplitEntry, so corrupted ledger data is never silently
-- destroyed.
DO $$
DECLARE
  referenced_violations INT;
BEGIN
  SELECT COUNT(*) INTO referenced_violations
  FROM "Category" c
  WHERE (
      ("isSystem" = false AND "familyId" IS NULL)
      OR ("isSystem" = true AND "familyId" IS NOT NULL)
    )
    AND (
      EXISTS (SELECT 1 FROM "Transaction" t WHERE t."categoryId" = c.id)
      OR EXISTS (SELECT 1 FROM "SplitEntry" s WHERE s."categoryId" = c.id)
    );

  IF referenced_violations > 0 THEN
    RAISE EXCEPTION
      'PER-102 migration aborted: % Category row(s) violate the (isSystem, familyId) invariant AND are referenced by ledger rows. Manual reconciliation required before re-running.',
      referenced_violations;
  END IF;
END
$$;

DELETE FROM "Category"
WHERE
  ("isSystem" = false AND "familyId" IS NULL)
  OR ("isSystem" = true AND "familyId" IS NOT NULL);

ALTER TABLE "Category"
  ADD CONSTRAINT category_system_familyid_consistency
  CHECK (
    ("isSystem" = true AND "familyId" IS NULL)
    OR ("isSystem" = false AND "familyId" IS NOT NULL)
  );

ALTER TABLE "Category" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS category_tenant_isolation ON "Category";
DROP POLICY IF EXISTS category_tenant_select ON "Category";
DROP POLICY IF EXISTS category_tenant_insert ON "Category";
DROP POLICY IF EXISTS category_tenant_update ON "Category";
DROP POLICY IF EXISTS category_tenant_delete ON "Category";

CREATE POLICY category_tenant_select ON "Category"
  FOR SELECT
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    OR ("isSystem" = true AND "familyId" IS NULL)
  );

CREATE POLICY category_tenant_insert ON "Category"
  FOR INSERT
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  );

CREATE POLICY category_tenant_update ON "Category"
  FOR UPDATE
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  );

CREATE POLICY category_tenant_delete ON "Category"
  FOR DELETE
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND "isSystem" = false
  );

ALTER TABLE "Category" FORCE ROW LEVEL SECURITY;
