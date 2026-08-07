-- PER-238 / ADR-0050 + ADR-0051 — wire market-data quotes to holdings valuation.
--
-- Adds the intended (previously documented-as-future) bridge from the tenant-
-- scoped holdings `Instrument` (a fund/gold/share a family HOLDS) to the GLOBAL,
-- family-neutral `MarketInstrument` (a tradeable PRICE SERIES). One OPTIONAL,
-- nullable FK column:
--
--   Instrument.marketInstrumentId -> MarketInstrument.id
--
-- WHY THIS IS SAFE / ANCHOR-SAFE (ADR-0050 §2, CLAUDE.md §5A):
-- -----------------------------------------------------------
-- A MarketQuote is an OBSERVATION, never money movement. The refresh path
-- (`refreshHoldingPricesForFamily`) only ever moves a holding's `lastPriceMinor`
-- and the DERIVED Σ-holdings valuation anchor (source="holdings", the account's
-- own value mechanism). It NEVER touches a cash/funding balance, nor any
-- opening/reconciliation/manual user anchor, nor any account that is not a
-- holdings-tracked investment account. This column merely records WHICH global
-- price series a holding's instrument follows; it carries no tenant data.
--
-- TENANCY: `Instrument` stays family-scoped + RLS. The FK target is a global row
-- with NO familyId — existence is validated in the app; there is nothing to
-- tenant-isolate on the market side (a USD/IDR rate or XAU spot is identical for
-- every family, see 20260807130000_market_data_core). ON DELETE SET NULL: if a
-- price series is ever retired, holdings quietly fall back to manual pricing
-- rather than blocking the delete or orphaning the FK.
--
-- ADDITIVE ONLY — adds one nullable column + FK; touches no existing row and
-- changes no existing balance, valuation, or transaction.

ALTER TABLE "Instrument" ADD COLUMN "marketInstrumentId" TEXT;

ALTER TABLE "Instrument" ADD CONSTRAINT "instrument_market_instrument_fkey"
  FOREIGN KEY ("marketInstrumentId") REFERENCES "MarketInstrument"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Lookups by market series (the refresh scans a family's linked holdings) and
-- the SET NULL cascade both benefit from an index on the FK column.
CREATE INDEX "Instrument_marketInstrumentId_idx" ON "Instrument"("marketInstrumentId");
