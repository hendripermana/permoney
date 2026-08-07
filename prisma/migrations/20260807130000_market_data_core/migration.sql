-- PER-233 / ADR-0050 — Market-data ingestion (Slice 1: provider-agnostic core).
--
-- Adds THREE GLOBAL, family-neutral tables that make up the market-data
-- subsystem's canonical store and staging boundary:
--
--   * MarketInstrument   — a globally-identified tradeable price series: an FX
--                          pair (USD/IDR), a metal (XAU), a security (AAPL +
--                          MIC), or a crypto asset (BTC). Kind-tagged, domain-
--                          constrained by CHECK.
--   * MarketQuote        — an append-only, dated, sourced observation of a
--                          MarketInstrument's price. UNIQUE (instrument, asOf,
--                          source) is the idempotency key; the latest asOf per
--                          instrument is the "current price".
--   * RawMarketDataFetch — the raw provider payload + provenance (provider,
--                          requested set, fetchedAt, http status, outcome). Every
--                          fetch lands here FIRST; the normalizer maps it into
--                          canonical MarketQuote rows (raw -> staged -> canonical,
--                          mirroring ADR-0008/0039). Raw provider data is never
--                          itself canonical.
--
-- WHY NO ROW-LEVEL SECURITY (deliberate, unlike every ledger table):
-- ------------------------------------------------------------------
-- A USD/IDR rate or the XAU spot price is IDENTICAL for every family — this is
-- public reference data, not tenant data. These tables carry NO `familyId` and
-- hold nothing a family owns, so there is nothing to isolate. Putting them under
-- family RLS would be incorrect (there is no family to scope to) and would break
-- the global-read contract. Tenant isolation stays where the tenant data is: the
-- per-family readers (FxRateSnapshot projection cache, valuations) keep their
-- existing RLS + familyId scoping and read FROM this global store in later
-- slices. See ADR-0050 §6.
--
-- NAMING: `MarketInstrument` is intentionally distinct from the tenant-scoped
-- holdings `Instrument` (ADR-0051 / 20260804120000_holdings_core). Holdings
-- `Instrument` = a fund/gold/share a family HOLDS; `MarketInstrument` = a global
-- tradeable PRICE SERIES. A future slice (PER-238) links them for auto-pricing;
-- that link is NOT created here.
--
-- LEDGER ISOLATION INVARIANT: nothing in this migration (or the ingest pipeline
-- it backs) ever touches `Transaction`, an account `balance`, or a valuation
-- anchor. Prices are observations, never money movement (ADR-0050 §6, CLAUDE.md
-- §5). "Database Is the Law": domain values, non-negativity, and the price scale
-- are DB CHECK constraints, not app conventions.
--
-- ADDITIVE ONLY — creates new tables; touches no existing row.

-- ============================================================================
-- 1. RawMarketDataFetch  (staging / provenance — created first so MarketQuote
--    can FK to it)
-- ============================================================================

CREATE TABLE "RawMarketDataFetch" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestedInstruments" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawMarketDataFetch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RawMarketDataFetch_provider_fetchedAt_idx"
  ON "RawMarketDataFetch"("provider", "fetchedAt" DESC);

ALTER TABLE "RawMarketDataFetch"
  ADD CONSTRAINT raw_market_data_fetch_status_domain CHECK (
    "status" IN ('ok', 'error')
  );

ALTER TABLE "RawMarketDataFetch"
  ADD CONSTRAINT raw_market_data_fetch_provider_non_empty CHECK (
    length(btrim("provider")) > 0
  );

-- ============================================================================
-- 2. MarketInstrument
-- ============================================================================

CREATE TABLE "MarketInstrument" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "baseCurrency" TEXT,
    "quoteCurrency" TEXT NOT NULL,
    "mic" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketInstrument_pkey" PRIMARY KEY ("id")
);

-- Instrument identity: (kind, symbol, COALESCE(mic,''), quoteCurrency). The
-- COALESCE keeps NULL mics (fx/metal/crypto) from being treated as distinct, so
-- re-resolving the same instrument during ingest never creates a duplicate.
CREATE UNIQUE INDEX "market_instrument_identity_key"
  ON "MarketInstrument"("kind", "symbol", (COALESCE("mic", '')), "quoteCurrency");

CREATE INDEX "MarketInstrument_kind_idx" ON "MarketInstrument"("kind");

ALTER TABLE "MarketInstrument" ADD CONSTRAINT "market_instrument_base_currency_is_iso_4217"
  FOREIGN KEY ("baseCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MarketInstrument" ADD CONSTRAINT "market_instrument_quote_currency_is_iso_4217"
  FOREIGN KEY ("quoteCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain CHECKs (Database Is the Law).
ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_kind_domain CHECK (
    "kind" IN ('fx', 'metal', 'security', 'crypto')
  );

ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_symbol_non_empty CHECK (
    length(btrim("symbol")) > 0
  );

-- Currency shapes mirror iso_4217_currency_code_shape so a CHECK can never
-- contradict its foreign key (same pattern as Instrument/FxRateSnapshot).
ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_quote_currency_shape CHECK ("quoteCurrency" ~ '^[A-Z]{3,5}$');

ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_base_currency_shape CHECK ("baseCurrency" IS NULL OR "baseCurrency" ~ '^[A-Z]{3,5}$');

-- An FX pair — and ONLY an FX pair — has a base currency (needed to reuse the
-- fx.ts "1 base major = rate quote major" encoding).
ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_base_currency_only_fx CHECK (
    ("kind" = 'fx') = ("baseCurrency" IS NOT NULL)
  );

-- A MIC/exchange only makes sense for a security.
ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_mic_only_security CHECK (
    "mic" IS NULL OR "kind" = 'security'
  );

-- ============================================================================
-- 3. MarketQuote  (append-only canonical observation)
-- ============================================================================

CREATE TABLE "MarketQuote" (
    "id" TEXT NOT NULL,
    "marketInstrumentId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "price" BIGINT NOT NULL,
    "priceScale" INTEGER NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "providerRef" TEXT,
    "rawFetchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketQuote_pkey" PRIMARY KEY ("id")
);

-- Idempotency key of the canonical store (ADR-0050 §4): re-ingesting the same
-- observation upserts in place, never duplicates.
CREATE UNIQUE INDEX "market_quote_instrument_asof_source_key"
  ON "MarketQuote"("marketInstrumentId", "asOf", "source");

-- Latest-quote ("current price") selection.
CREATE INDEX "MarketQuote_marketInstrumentId_asOf_idx"
  ON "MarketQuote"("marketInstrumentId", "asOf" DESC);

ALTER TABLE "MarketQuote" ADD CONSTRAINT "MarketQuote_marketInstrumentId_fkey"
  FOREIGN KEY ("marketInstrumentId") REFERENCES "MarketInstrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketQuote" ADD CONSTRAINT "MarketQuote_rawFetchId_fkey"
  FOREIGN KEY ("rawFetchId") REFERENCES "RawMarketDataFetch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MarketQuote" ADD CONSTRAINT "market_quote_currency_is_iso_4217"
  FOREIGN KEY ("quoteCurrency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prices are strictly positive (a zero/negative market price is nonsense), and
-- the scale is one of the two documented conventions: 12 (fx / RATE_SCALE) or
-- 8 (spot / SPOT_PRICE_SCALE). Each row is self-describing via priceScale.
ALTER TABLE "MarketQuote"
  ADD CONSTRAINT market_quote_price_positive CHECK ("price" > 0);

ALTER TABLE "MarketQuote"
  ADD CONSTRAINT market_quote_price_scale_domain CHECK ("priceScale" IN (8, 12));

ALTER TABLE "MarketQuote"
  ADD CONSTRAINT market_quote_currency_shape CHECK ("quoteCurrency" ~ '^[A-Z]{3,5}$');

ALTER TABLE "MarketQuote"
  ADD CONSTRAINT market_quote_source_non_empty CHECK ("source" ~ '\S');

-- ============================================================================
-- 4. NO Row-Level Security (intentional — see header). These tables carry no
--    tenant data; there is nothing to isolate. Do NOT add family RLS here.
-- ============================================================================
