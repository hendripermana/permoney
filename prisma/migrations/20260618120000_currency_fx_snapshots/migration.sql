-- ============================================================================
-- PER-147 / ADR-0035 — Currency, FX rate snapshots, and cross-currency transfers
--
-- 1. FxRateSnapshot: dated, tenant-scoped, directed `from -> to` rate store.
-- 2. Base-currency projection columns on Transaction and Valuation (derived,
--    rebuildable, all-three-or-none, FX-pending-tolerant).
-- 3. Transfer cross-rate + currencies + optional FX-fee leg link.
-- 4. `fx_fee` transaction kind (expense; naturally exempt from the liability
--    cost-target trigger, which only fires for liability_interest/liability_fee).
-- ============================================================================

-- 1. FxRateSnapshot ----------------------------------------------------------

CREATE TABLE "FxRateSnapshot" (
    "id" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rateScaled" BIGINT NOT NULL,
    "asOfDate" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "familyId" TEXT NOT NULL,

    CONSTRAINT "FxRateSnapshot_pkey" PRIMARY KEY ("id")
);

-- One rate per (family, pair, day); idempotent upsert key (ADR-0035 §2/§7).
CREATE UNIQUE INDEX "fx_rate_snapshot_unique"
  ON "FxRateSnapshot"("familyId", "fromCurrency", "toCurrency", "asOfDate");

-- Resolution index: greatest asOfDate <= date, per (family, pair).
CREATE INDEX "FxRateSnapshot_familyId_fromCurrency_toCurrency_asOfDate_idx"
  ON "FxRateSnapshot"("familyId", "fromCurrency", "toCurrency", "asOfDate" DESC);

ALTER TABLE "FxRateSnapshot" ADD CONSTRAINT "fx_from_currency_is_iso_4217"
  FOREIGN KEY ("fromCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FxRateSnapshot" ADD CONSTRAINT "fx_to_currency_is_iso_4217"
  FOREIGN KEY ("toCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FxRateSnapshot" ADD CONSTRAINT "FxRateSnapshot_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain CHECKs.
ALTER TABLE "FxRateSnapshot"
  ADD CONSTRAINT fx_rate_positive CHECK ("rateScaled" > 0);
ALTER TABLE "FxRateSnapshot"
  ADD CONSTRAINT fx_from_to_distinct CHECK ("fromCurrency" <> "toCurrency");
ALTER TABLE "FxRateSnapshot"
  ADD CONSTRAINT fx_from_currency_shape CHECK ("fromCurrency" ~ '^[A-Z]{3,5}$');
ALTER TABLE "FxRateSnapshot"
  ADD CONSTRAINT fx_to_currency_shape CHECK ("toCurrency" ~ '^[A-Z]{3,5}$');
ALTER TABLE "FxRateSnapshot"
  ADD CONSTRAINT fx_source_domain CHECK ("source" IN ('manual', 'seed', 'provider'));

-- Row-Level Security: tenant isolation, mirroring Account/Transaction/Valuation.
ALTER TABLE "FxRateSnapshot" ENABLE ROW LEVEL SECURITY;
CREATE POLICY fx_rate_snapshot_tenant_isolation ON "FxRateSnapshot"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);
ALTER TABLE "FxRateSnapshot" FORCE ROW LEVEL SECURITY;

-- 2. Base-currency projection on Transaction ---------------------------------

ALTER TABLE "Transaction"
  ADD COLUMN "baseAmount" BIGINT,
  ADD COLUMN "baseCurrency" TEXT,
  ADD COLUMN "fxRateScaled" BIGINT,
  ADD COLUMN "fxRateSnapshotId" TEXT;

ALTER TABLE "Transaction" ADD CONSTRAINT "transaction_base_currency_is_iso_4217"
  FOREIGN KEY ("baseCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_base_currency_shape
  CHECK ("baseCurrency" IS NULL OR "baseCurrency" ~ '^[A-Z]{3,5}$');
ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_fx_rate_positive
  CHECK ("fxRateScaled" IS NULL OR "fxRateScaled" > 0);
-- All-three-or-none: converted (all set) or FX-pending (all NULL). ADR-0035 §4.
ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_base_projection_coherent CHECK (
    ("baseAmount" IS NULL AND "baseCurrency" IS NULL AND "fxRateScaled" IS NULL)
    OR ("baseAmount" IS NOT NULL AND "baseCurrency" IS NOT NULL AND "fxRateScaled" IS NOT NULL)
  );

-- 3. Base-currency projection on Valuation -----------------------------------

ALTER TABLE "Valuation"
  ADD COLUMN "baseValue" BIGINT,
  ADD COLUMN "baseCurrency" TEXT,
  ADD COLUMN "fxRateScaled" BIGINT,
  ADD COLUMN "fxRateSnapshotId" TEXT;

ALTER TABLE "Valuation" ADD CONSTRAINT "valuation_base_currency_is_iso_4217"
  FOREIGN KEY ("baseCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_base_currency_shape
  CHECK ("baseCurrency" IS NULL OR "baseCurrency" ~ '^[A-Z]{3,5}$');
ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_fx_rate_positive
  CHECK ("fxRateScaled" IS NULL OR "fxRateScaled" > 0);
ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_base_projection_coherent CHECK (
    ("baseValue" IS NULL AND "baseCurrency" IS NULL AND "fxRateScaled" IS NULL)
    OR ("baseValue" IS NOT NULL AND "baseCurrency" IS NOT NULL AND "fxRateScaled" IS NOT NULL)
  );

-- 4. Transfer cross-rate, currencies, and FX-fee leg link --------------------

ALTER TABLE "Transfer"
  ADD COLUMN "fxRateScaled" BIGINT,
  ADD COLUMN "fromCurrency" TEXT,
  ADD COLUMN "toCurrency" TEXT,
  ADD COLUMN "feeTransactionId" TEXT;

CREATE UNIQUE INDEX "Transfer_feeTransactionId_key" ON "Transfer"("feeTransactionId");
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_feeTransactionId_fkey"
  FOREIGN KEY ("feeTransactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transfer"
  ADD CONSTRAINT transfer_fx_rate_positive
  CHECK ("fxRateScaled" IS NULL OR "fxRateScaled" > 0);
-- from/to recorded together or not at all.
ALTER TABLE "Transfer"
  ADD CONSTRAINT transfer_fx_currencies_paired
  CHECK (("fromCurrency" IS NULL) = ("toCurrency" IS NULL));
-- A recorded rate implies a genuine cross-currency pair. Same-currency => NULL rate.
ALTER TABLE "Transfer"
  ADD CONSTRAINT transfer_fx_rate_requires_cross
  CHECK ("fxRateScaled" IS NULL OR ("fromCurrency" IS NOT NULL AND "fromCurrency" <> "toCurrency"));
ALTER TABLE "Transfer"
  ADD CONSTRAINT transfer_from_currency_shape
  CHECK ("fromCurrency" IS NULL OR "fromCurrency" ~ '^[A-Z]{3,5}$');
ALTER TABLE "Transfer"
  ADD CONSTRAINT transfer_to_currency_shape
  CHECK ("toCurrency" IS NULL OR "toCurrency" ~ '^[A-Z]{3,5}$');

-- 5. `fx_fee` transaction kind ------------------------------------------------
-- Drop + recreate the kind domain and type/kind shape CHECKs to add 'fx_fee'.
-- fx_fee is an EXPENSE kind (a finance cost), not a transfer. It is naturally
-- exempt from enforce_liability_cost_transaction_target() (which early-returns
-- unless kind IN ('liability_interest','liability_fee')), so no toAccountId or
-- liability-target requirement applies.

ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS transaction_kind_type_shape;
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS transaction_kind_domain;

ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_kind_domain CHECK (
    kind IN (
      'standard',
      'funds_movement',
      'cc_payment',
      'loan_payment',
      'liability_draw',
      'liability_interest',
      'liability_fee',
      'balance_adjustment',
      'fx_fee'
    )
  );

ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_kind_type_shape CHECK (
    ("type" = 'transfer'
      AND kind IN (
        'funds_movement',
        'cc_payment',
        'loan_payment',
        'liability_draw'
      ))
    OR ("type" = 'expense'
      AND kind IN (
        'standard',
        'liability_interest',
        'liability_fee',
        'balance_adjustment',
        'fx_fee'
      ))
    OR ("type" = 'income' AND kind IN ('standard', 'balance_adjustment'))
  );
