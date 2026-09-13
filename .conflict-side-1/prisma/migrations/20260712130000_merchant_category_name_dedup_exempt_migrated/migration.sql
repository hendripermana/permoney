-- PER-189 follow-up (head-eng review, PR #158): the quick-create dedup index
-- from `merchant_category_name_dedup` was scoped too broadly and would break
-- Sure full-family migration. Real Sure exports bind Category/Merchant
-- identity by `externalId`, NEVER by name (ADR-0041 §3) — a Sure bundle can
-- legitimately carry two DIFFERENT entities named "Food" and "food" (a
-- renamed category, or merged data from two Sure workspaces). The prior
-- index had no such carve-out and would raise a unique-constraint violation
-- mid-import for tx.merchant.create/tx.category.create in sure-migration.ts,
-- silently corrupting the import rather than the user's own quick-create
-- flow it was meant to protect.
--
-- Fix: rebuild both indexes with an added `WHERE "externalProvider" IS NULL`
-- predicate. Manually-created (quick-create) rows are always
-- externalProvider IS NULL, so they keep full DB-enforced race protection —
-- the original goal is unaffected. Migration-bound rows (externalProvider
-- set) are exempt from the DB constraint, matching their externalId-bound
-- identity.
--
-- The app-level pre-check in createMerchantForFamily/createCategoryForFamily
-- is UNCHANGED and still scans every row regardless of externalProvider — a
-- manual quick-create still gets a clear DuplicateNameError against an
-- existing migrated entity of the same name; only the concurrent-request DB
-- backstop is scoped to manual-vs-manual races.

DROP INDEX "Merchant_familyId_lower_name_key";
DROP INDEX "Category_familyId_lower_name_key";

CREATE UNIQUE INDEX "Merchant_familyId_lower_name_key"
  ON "Merchant" ("familyId", lower(btrim(name)))
  WHERE "externalProvider" IS NULL;

CREATE UNIQUE INDEX "Category_familyId_lower_name_key"
  ON "Category" ("familyId", lower(btrim(name)))
  WHERE "familyId" IS NOT NULL AND "externalProvider" IS NULL;
