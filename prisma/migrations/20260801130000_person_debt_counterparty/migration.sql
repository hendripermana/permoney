-- PER-212 / ADR-0049 — person-to-person debt (counterparty layer).
--
-- A person-debt is an ordinary RECEIVABLE(ASSET)/LOAN(LIABILITY) account
-- flagged by a link to a "person" contact. This migration adds:
--   1. Merchant.kind — "business" (classic payee) | "person" (debt party),
--      domain-constrained by a CHECK ("Database Is the Law", CLAUDE.md §5A).
--   2. Account.counterpartyMerchantId — nullable link to the person Merchant
--      this informal-debt account represents. Its presence is the ONLY
--      discriminator for a person-debt account.
--
-- The link is a TENANT-SAFE composite FK to Merchant(id, familyId)
-- (Pattern A, ADR-0010 / migration 20260527160000_harden_tenant_composite_fk):
-- MATCH SIMPLE means a NULL counterpartyMerchantId is never checked, and a
-- non-NULL value can only reference a Merchant in the SAME family. Foreign keys
-- alone are not tenant isolation; the composite (id, familyId) target is.
--
-- Merchant already carries UNIQUE (id, familyId) ("Merchant_id_familyId_key"),
-- created by the PER-104 hardening migration, so the composite FK target exists.

-- ============================================================================
-- 1. Merchant.kind — business | person
-- ============================================================================

ALTER TABLE "Merchant"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'business';

ALTER TABLE "Merchant"
  ADD CONSTRAINT "merchant_kind_domain"
  CHECK ("kind" IN ('business', 'person'));

-- ============================================================================
-- 2. Account.counterpartyMerchantId — tenant-safe composite FK to Merchant
-- ============================================================================

ALTER TABLE "Account"
  ADD COLUMN "counterpartyMerchantId" TEXT;

ALTER TABLE "Account"
  ADD CONSTRAINT "account_counterparty_merchant_fkey"
  FOREIGN KEY ("counterpartyMerchantId", "familyId")
  REFERENCES "Merchant" (id, "familyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Account_counterpartyMerchantId_idx"
  ON "Account" ("counterpartyMerchantId");
