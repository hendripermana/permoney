-- ============================================================================
-- PER-170 / ADR-0041 — Sure full-family migration, Phase 1 schema deltas.
--
-- Additive + backward-compatible. Three pieces:
--   1. Durable external-provider bindings on Category + Merchant (mirroring the
--      Account binding) as PARTIAL UNIQUE indexes (Prisma cannot express the
--      `WHERE externalProvider IS NOT NULL` predicate — hand-written here per the
--      family_membership / idempotent_update_delete precedent).
--   2. ImportBatch gains a provider-agnostic `provider` column and a 'migration'
--      sourceKind, so a full-family import is a first-class batch.
--   3. ImportBatchArtifact: tenant-private lossless bundle provenance, RLS-guarded
--      with the ADR-0036 membership guard and a composite tenant FK.
--
-- familyId is part of every binding composite for tenant isolation (ADR-0010).
-- New columns are nullable, so existing rows are untouched.
-- ============================================================================

-- 1. Category + Merchant provider-binding columns ----------------------------

ALTER TABLE "Category"
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalId" TEXT;

ALTER TABLE "Merchant"
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalId" TEXT;

-- 2. Partial UNIQUE bindings (WHERE externalProvider IS NOT NULL) -------------
--    Why partial: Postgres treats NULLs as DISTINCT by default, so manual rows
--    (externalProvider = NULL) are already unique under any composite index. The
--    predicate keeps the index SMALL (provider-bound rows only) and makes the
--    binding uniqueness an EXPLICIT, import-only invariant (ADR-0041 §7).

-- Account: HARDEN the existing plain lookup index into the partial unique
-- binding. The partial unique still serves equality lookups on provider-bound
-- rows, so dropping the redundant plain index loses no access path.
DROP INDEX IF EXISTS "Account_familyId_externalProvider_externalAccountId_idx";
CREATE UNIQUE INDEX "account_provider_binding"
  ON "Account" ("familyId", "externalProvider", "externalAccountId")
  WHERE "externalProvider" IS NOT NULL;

CREATE UNIQUE INDEX "category_provider_binding"
  ON "Category" ("familyId", "externalProvider", "externalId")
  WHERE "externalProvider" IS NOT NULL;

CREATE UNIQUE INDEX "merchant_provider_binding"
  ON "Merchant" ("familyId", "externalProvider", "externalId")
  WHERE "externalProvider" IS NOT NULL;

-- 3. ImportBatch: provider column + 'migration' sourceKind -------------------

ALTER TABLE "ImportBatch" ADD COLUMN "provider" TEXT;

ALTER TABLE "ImportBatch" DROP CONSTRAINT IF EXISTS import_batch_source_kind_domain;
ALTER TABLE "ImportBatch"
  ADD CONSTRAINT import_batch_source_kind_domain
  CHECK ("sourceKind" IN ('csv_upload', 'provider', 'migration'));

-- A migration batch must name its provider (provider-agnostic, no hardcoded
-- per-provider sourceKind — ADR-0041 §8).
ALTER TABLE "ImportBatch"
  ADD CONSTRAINT import_batch_migration_provider
  CHECK ("sourceKind" <> 'migration' OR "provider" IS NOT NULL);

-- 4. ImportBatchArtifact -----------------------------------------------------

CREATE TABLE "ImportBatchArtifact" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKind" TEXT NOT NULL DEFAULT 'inline_bytea',
    "contentHash" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "bytes" BYTEA,
    "storageRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatchArtifact_pkey" PRIMARY KEY ("id")
);

-- One artifact per (batch, raw-bundle hash): re-running the migration on the
-- same bundle reuses the existing batch (ADR-0039 §5) and never re-inserts the
-- artifact (ADR-0041 §7 one-shot).
CREATE UNIQUE INDEX "import_artifact_batch_content"
  ON "ImportBatchArtifact" ("importBatchId", "contentHash");
CREATE INDEX "ImportBatchArtifact_familyId_idx"
  ON "ImportBatchArtifact" ("familyId");

ALTER TABLE "ImportBatchArtifact" ADD CONSTRAINT "ImportBatchArtifact_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite tenant FK: an artifact can never point at another family's batch
-- even with a forged batchId (ADR-0010 pattern, like RawImportedTransaction).
ALTER TABLE "ImportBatchArtifact" ADD CONSTRAINT "import_artifact_batch_family_fkey"
  FOREIGN KEY ("importBatchId", "familyId") REFERENCES "ImportBatch"("id", "familyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain CHECKs (house convention: String + CHECK).
ALTER TABLE "ImportBatchArtifact"
  ADD CONSTRAINT import_artifact_storage_kind_domain
  CHECK ("storageKind" IN ('inline_bytea', 'object_store'));
-- Storage-form invariant: inline bytes XOR external reference, matched to kind.
ALTER TABLE "ImportBatchArtifact"
  ADD CONSTRAINT import_artifact_storage_shape
  CHECK (
    ("storageKind" = 'inline_bytea' AND "bytes" IS NOT NULL AND "storageRef" IS NULL)
    OR ("storageKind" = 'object_store' AND "storageRef" IS NOT NULL AND "bytes" IS NULL)
  );
ALTER TABLE "ImportBatchArtifact"
  ADD CONSTRAINT import_artifact_byte_size_positive
  CHECK ("byteSize" > 0);

-- RLS: tenant isolation + ADR-0036 membership guard. Raw bundles are
-- family-private financial PII and must never cross-read.
ALTER TABLE "ImportBatchArtifact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_artifact_tenant_isolation ON "ImportBatchArtifact"
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
ALTER TABLE "ImportBatchArtifact" FORCE ROW LEVEL SECURITY;
