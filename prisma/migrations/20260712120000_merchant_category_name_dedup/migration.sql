-- PER-189: quick-create Merchant/Category from the transaction form needs a
-- durable dedup boundary, not just an app-level check, so a double-submit or
-- two concurrent requests can never produce two rows for "Starbucks" and
-- "starbucks " in the same family. Case- and whitespace-insensitive per
-- family (ADR-0003 tenant scoping). Verified against the current dev/staging
-- data set before writing this migration: zero existing case-insensitive
-- collisions in either table (2026-07-12).
--
-- Category system rows (isSystem=true, familyId NULL) are out of scope: the
-- category_system_familyid_consistency CHECK (see
-- 20260527120000_harden_category_system_rls) already guarantees isSystem=false
-- implies familyId IS NOT NULL, so the partial index only ever dedups
-- tenant-owned rows.
--
-- Prisma schema cannot express a functional/expression index, so — like the
-- externalProvider partial-unique indexes added in
-- 20260627120000_sure_migration_bindings — this lives only in raw SQL and is
-- documented with a comment on the Prisma model.

CREATE UNIQUE INDEX "Merchant_familyId_lower_name_key"
  ON "Merchant" ("familyId", lower(btrim(name)));

CREATE UNIQUE INDEX "Category_familyId_lower_name_key"
  ON "Category" ("familyId", lower(btrim(name)))
  WHERE "familyId" IS NOT NULL;
