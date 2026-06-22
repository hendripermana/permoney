-- ============================================================================
-- PER-82 / ADR-0039 — Import staging, deduplication & promotion (source-agnostic)
--
-- Two tenant-scoped staging tables. Raw import data is staging data, not ledger
-- data (ADR-0008 §5): rows land here first and only explicitly `confirmed`,
-- tenant-validated, deduplicated rows are promoted into canonical Transaction
-- rows through the SHARED ledger create core (FX projection, atomic balance
-- delta, audit) — never a second ledger writer.
--
--   * ImportBatch            — one upload/sync run. Per-file content-hash dedup.
--                              accountId is an OPTIONAL hint; the authoritative
--                              target account is per-row below (one file may span
--                              many accounts, e.g. a Sure export).
--   * RawImportedTransaction — one wide row: immutable rawPayload + nullable
--                              parsed/enrichment/dedup columns. `promoted` is the
--                              sole irreversible terminal state.
--
-- Provider columns (providerConnectionId, externalId) are reserved-nullable for
-- PER-118 / ADR-0015 — that slice only ADDS ProviderConnection + populates them.
--
-- RLS uses the ADR-0036 membership guard (app_is_active_member) on both tables,
-- identical to Account / Transaction / Budget.
-- ============================================================================

-- 1. ImportBatch -------------------------------------------------------------

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "contentHash" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "promotedRows" INTEGER NOT NULL DEFAULT 0,
    "providerConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- Per-file batch dedup target (ADR-0039 §5): re-uploading the identical file
-- within a family+source returns the existing batch, never re-stages.
CREATE UNIQUE INDEX "import_batch_content_dedup"
  ON "ImportBatch"("familyId", "sourceKind", "contentHash");

CREATE INDEX "ImportBatch_familyId_status_idx"
  ON "ImportBatch"("familyId", "status");

-- Composite-FK target (named UNIQUE, not just an index) so a raw row's composite
-- FK can never cross tenants even with a forged batchId — ADR-0010 pattern.
ALTER TABLE "ImportBatch"
  ADD CONSTRAINT "ImportBatch_id_familyId_key" UNIQUE ("id", "familyId");

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain CHECKs (house convention: String + CHECK, not enums).
ALTER TABLE "ImportBatch"
  ADD CONSTRAINT import_batch_source_kind_domain
  CHECK ("sourceKind" IN ('csv_upload', 'provider'));
ALTER TABLE "ImportBatch"
  ADD CONSTRAINT import_batch_status_domain
  CHECK ("status" IN ('pending', 'ready_for_review', 'partially_promoted', 'completed', 'failed'));

-- RLS: tenant isolation + ADR-0036 membership guard.
ALTER TABLE "ImportBatch" ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_batch_tenant_isolation ON "ImportBatch"
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
ALTER TABLE "ImportBatch" FORCE ROW LEVEL SECURITY;

-- 2. RawImportedTransaction --------------------------------------------------

CREATE TABLE "RawImportedTransaction" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "externalId" TEXT,
    "type" TEXT,
    "amount" BIGINT,
    "currency" TEXT,
    "date" TIMESTAMP(3),
    "description" TEXT,
    "fingerprint" TEXT,
    "rowStatus" TEXT NOT NULL DEFAULT 'pending',
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOfTransactionId" TEXT,
    "suggestedCategoryId" TEXT,
    "suggestedMerchantId" TEXT,
    "matchedSmartRuleId" TEXT,
    "errorReason" TEXT,
    "promotionIdempotencyKey" TEXT NOT NULL,
    "promotedTransactionId" TEXT,
    "providerConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawImportedTransaction_pkey" PRIMARY KEY ("id")
);

-- Per-row promotion idempotency (ADR-0039 §5/§9): the durable backstop that
-- stops any re-promotion from double-booking, mirroring Transaction's own
-- (familyId, idempotencyKey) uniqueness.
CREATE UNIQUE INDEX "raw_import_promotion_key"
  ON "RawImportedTransaction"("familyId", "promotionIdempotencyKey");

CREATE INDEX "RawImportedTransaction_importBatchId_rowStatus_idx"
  ON "RawImportedTransaction"("importBatchId", "rowStatus");
CREATE INDEX "RawImportedTransaction_familyId_fingerprint_idx"
  ON "RawImportedTransaction"("familyId", "fingerprint");
CREATE INDEX "RawImportedTransaction_accountId_idx"
  ON "RawImportedTransaction"("accountId");

-- Composite tenant FKs: a raw row can never point at another family's batch or
-- account (ADR-0010 pattern).
ALTER TABLE "RawImportedTransaction" ADD CONSTRAINT "RawImportedTransaction_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RawImportedTransaction" ADD CONSTRAINT "raw_import_batch_family_fkey"
  FOREIGN KEY ("importBatchId", "familyId") REFERENCES "ImportBatch"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RawImportedTransaction" ADD CONSTRAINT "raw_import_account_family_fkey"
  FOREIGN KEY ("accountId", "familyId") REFERENCES "Account"("id", "familyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain CHECKs.
ALTER TABLE "RawImportedTransaction"
  ADD CONSTRAINT raw_import_row_status_domain
  CHECK ("rowStatus" IN ('pending', 'normalized', 'duplicate', 'error', 'confirmed', 'promoted', 'rejected'));
-- Type is income/expense only in PER-82 (transfers/splits reserved). NULL until
-- normalized.
ALTER TABLE "RawImportedTransaction"
  ADD CONSTRAINT raw_import_type_domain
  CHECK ("type" IS NULL OR "type" IN ('income', 'expense'));
-- Signed-amount invariant once both type and amount are present: income >= 0,
-- expense <= 0 (mirrors the canonical ledger sign rule).
ALTER TABLE "RawImportedTransaction"
  ADD CONSTRAINT raw_import_amount_sign
  CHECK (
    "amount" IS NULL OR "type" IS NULL
    OR ("type" = 'income' AND "amount" >= 0)
    OR ("type" = 'expense' AND "amount" <= 0)
  );
-- `promoted` iff the canonical Transaction link is set — the terminal state and
-- its provenance pointer move together.
ALTER TABLE "RawImportedTransaction"
  ADD CONSTRAINT raw_import_promoted_link
  CHECK (("rowStatus" = 'promoted') = ("promotedTransactionId" IS NOT NULL));

-- RLS: tenant isolation + ADR-0036 membership guard. Raw payloads are
-- family-private and must never cross-read.
ALTER TABLE "RawImportedTransaction" ENABLE ROW LEVEL SECURITY;
CREATE POLICY raw_import_tenant_isolation ON "RawImportedTransaction"
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
ALTER TABLE "RawImportedTransaction" FORCE ROW LEVEL SECURITY;
