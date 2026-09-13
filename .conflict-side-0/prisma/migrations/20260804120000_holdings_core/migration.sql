-- PER-232 / ADR-0051 — Investments & Holdings domain (Slice 1: market-priced).
--
-- Adds two tenant-scoped tables:
--   * Instrument — the tradeable thing (fund / metal / stock / crypto / bond /
--     deposit product), v1 manual, tenant-scoped, quoted in a currency.
--   * Holding    — a position of an Instrument inside a valuation-tracked
--     investment Account. Account value = Σ its holdings' current value, written
--     back as a valuation ANCHOR (see src/server/holdings.ts) so the account
--     balance materializes from holdings and every net-worth / balance / audit /
--     RLS invariant holds unchanged (ADR-0008 asset-tracking contract).
--
-- Both carry TENANT-SAFE composite FKs (Pattern A, ADR-0010 / migration
-- 20260527160000_harden_tenant_composite_fk): the (id, familyId) target pair,
-- not the bare id, is what enforces tenant isolation. Account already has
-- UNIQUE (id, familyId); this migration adds the matching key on Instrument so
-- Holding(instrumentId, familyId) can reference it. "Database Is the Law"
-- (CLAUDE.md §5A): domain values and non-negativity are DB CHECK constraints,
-- not app conventions.
--
-- ADDITIVE ONLY — creates new tables + RLS; touches no existing row.

-- ============================================================================
-- 1. Instrument
-- ============================================================================

CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "quoteCurrency" TEXT NOT NULL DEFAULT 'IDR',
    "priceModel" TEXT NOT NULL DEFAULT 'market',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "familyId" TEXT NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- Composite-FK target (tenant-safe reference from Holding).
CREATE UNIQUE INDEX "Instrument_id_familyId_key" ON "Instrument"("id", "familyId");

CREATE INDEX "Instrument_familyId_idx" ON "Instrument"("familyId");

ALTER TABLE "Instrument" ADD CONSTRAINT "Instrument_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Instrument" ADD CONSTRAINT "instrument_quote_currency_is_iso_4217"
  FOREIGN KEY ("quoteCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain CHECKs.
ALTER TABLE "Instrument"
  ADD CONSTRAINT instrument_kind_domain CHECK (
    "kind" IN ('mutual_fund', 'metal', 'stock', 'crypto', 'bond', 'deposit')
  );

ALTER TABLE "Instrument"
  ADD CONSTRAINT instrument_price_model_domain CHECK (
    "priceModel" IN ('market', 'yield')
  );

-- Currency shape, matching iso_4217_currency_code_shape on the registry so the
-- CHECK can never contradict the foreign key (mirrors valuation_currency_shape).
ALTER TABLE "Instrument"
  ADD CONSTRAINT instrument_quote_currency_shape CHECK ("quoteCurrency" ~ '^[A-Z]{3,5}$');

-- ============================================================================
-- 2. Holding
-- ============================================================================

CREATE TABLE "Holding" (
    "id" TEXT NOT NULL,
    "quantity" DECIMAL(38,8) NOT NULL,
    "avgUnitCostMinor" BIGINT NOT NULL,
    "lastPriceMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "familyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,

    CONSTRAINT "Holding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Holding_id_familyId_key" ON "Holding"("id", "familyId");

CREATE INDEX "Holding_familyId_accountId_idx" ON "Holding"("familyId", "accountId");

ALTER TABLE "Holding" ADD CONSTRAINT "Holding_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant-safe composite FKs (MATCH SIMPLE is the Postgres default): a Holding can
-- only reference an Account / Instrument in the SAME family.
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_accountId_familyId_fkey"
  FOREIGN KEY ("accountId", "familyId") REFERENCES "Account"("id", "familyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Holding" ADD CONSTRAINT "Holding_instrumentId_familyId_fkey"
  FOREIGN KEY ("instrumentId", "familyId") REFERENCES "Instrument"("id", "familyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Non-negativity (Database Is the Law): quantity and unit cost are never
-- negative; a manual last price is either unset (NULL) or non-negative.
ALTER TABLE "Holding"
  ADD CONSTRAINT holding_quantity_non_negative CHECK ("quantity" >= 0);

ALTER TABLE "Holding"
  ADD CONSTRAINT holding_avg_unit_cost_non_negative CHECK ("avgUnitCostMinor" >= 0);

ALTER TABLE "Holding"
  ADD CONSTRAINT holding_last_price_non_negative CHECK ("lastPriceMinor" IS NULL OR "lastPriceMinor" >= 0);

-- ============================================================================
-- 3. Row-Level Security — tenant isolation, mirroring Account/Valuation.
-- ============================================================================

ALTER TABLE "Instrument" ENABLE ROW LEVEL SECURITY;

CREATE POLICY instrument_tenant_isolation ON "Instrument"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "Instrument" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Holding" ENABLE ROW LEVEL SECURITY;

CREATE POLICY holding_tenant_isolation ON "Holding"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "Holding" FORCE ROW LEVEL SECURITY;
