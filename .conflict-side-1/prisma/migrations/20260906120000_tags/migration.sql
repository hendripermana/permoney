-- ============================================================================
-- PER-145 — free-form, family-scoped Tags on Transaction.
--
-- Two tenant-scoped tables:
--   * Tag             — a plain tenant-owned taxonomy row (mirrors Merchant:
--                       no isSystem split, no parent hierarchy).
--   * TransactionTag  — join table, composite-FK'd to BOTH Transaction and
--                       Tag (ADR-0010 tenant-safe FK pattern) so a row can
--                       never cross tenants even if an id is forged. The
--                       @@unique(transactionId, tagId) makes re-attaching the
--                       same tag idempotent (upsert no-op) instead of a
--                       duplicate row.
--
-- RLS uses the ADR-0036 membership guard (app_is_active_member), identical to
-- Budget/BudgetCategory/Account/Transaction — this is the current-best-practice
-- policy shape for a newly added tenant table (Merchant/Category predate
-- ADR-0036 and still carry the older, simpler tenant-only policy).
-- ============================================================================

-- Composite-FK target on Transaction (ADR-0010) — the same tenant-safe shape
-- Account/Merchant/Budget already expose. `id` is already globally unique
-- (@id); this adds the (id, familyId) pair Prisma's composite relations need.
CREATE UNIQUE INDEX "Transaction_id_familyId_key" ON "Transaction"("id", "familyId");

-- 1. Tag ----------------------------------------------------------------

CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6172F3',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Tag_familyId_idx" ON "Tag"("familyId");
CREATE INDEX "Tag_familyId_archivedAt_idx" ON "Tag"("familyId", "archivedAt");

-- Composite-FK target for TransactionTag.
CREATE UNIQUE INDEX "Tag_id_familyId_key" ON "Tag"("id", "familyId");

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Case/whitespace-insensitive per-family name uniqueness (mirrors
-- `merchant_category_name_dedup`). Prisma cannot express a functional index
-- in the schema DSL, so this is raw SQL, same as Merchant/Category.
CREATE UNIQUE INDEX "Tag_familyId_lower_name_key"
  ON "Tag"("familyId", lower(btrim("name")));

-- RLS: tenant isolation + ADR-0036 membership guard.
ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tag_tenant_isolation ON "Tag"
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
ALTER TABLE "Tag" FORCE ROW LEVEL SECURITY;

-- 2. TransactionTag -------------------------------------------------------

CREATE TABLE "TransactionTag" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionTag_pkey" PRIMARY KEY ("id")
);

-- Attach/detach idempotency: re-attaching the same tag to the same
-- transaction is a no-op upsert, never a duplicate row.
CREATE UNIQUE INDEX "transaction_tag_unique" ON "TransactionTag"("transactionId", "tagId");
CREATE INDEX "TransactionTag_familyId_idx" ON "TransactionTag"("familyId");
CREATE INDEX "TransactionTag_tagId_idx" ON "TransactionTag"("tagId");

-- Composite tenant FKs: a tagging row can never point at another family's
-- transaction OR another family's tag, even if an id is forged.
ALTER TABLE "TransactionTag" ADD CONSTRAINT "TransactionTag_transactionId_familyId_fkey"
  FOREIGN KEY ("transactionId", "familyId") REFERENCES "Transaction"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionTag" ADD CONSTRAINT "TransactionTag_tagId_familyId_fkey"
  FOREIGN KEY ("tagId", "familyId") REFERENCES "Tag"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tenant isolation + ADR-0036 membership guard.
ALTER TABLE "TransactionTag" ENABLE ROW LEVEL SECURITY;
CREATE POLICY transaction_tag_tenant_isolation ON "TransactionTag"
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
ALTER TABLE "TransactionTag" FORCE ROW LEVEL SECURITY;
