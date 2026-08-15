-- PER-257 / ADR-0052 — Financial Ingestion Service (provider routing engine).
--
-- Adds an EXPLICIT source-adapter discriminator to MarketInstrument so the
-- ingestion router can select the correct vendor per instrument, batch per
-- vendor, and ingest through the (unchanged) raw -> staged -> canonical pipeline.
--
-- WHY an explicit column (chosen over overloading `mic`): an instrument should
-- DECLARE its data source. `mic` is an ISO-10383 exchange code; a reksadana fund
-- has no exchange, so a synthetic mic would be a contract smell. An explicit
-- column removes routing ambiguity entirely (ADR-0052 §1). A CHECK constrains it
-- to the known adapter-id domain so an unknown source can never be persisted.
--
-- ADDITIVE ONLY: a NULLABLE column, no default, no backfill. Existing rows (the
-- BSI gold series) stay NULL and keep routing correctly via kind/mic derivation
-- (`resolveProviderId`: metal -> 'logam_mulia'). Touches no existing value; adds
-- no ledger behaviour; this table remains family-neutral (no RLS — see the
-- 20260807130000_market_data_core header).

ALTER TABLE "MarketInstrument" ADD COLUMN "provider" TEXT;

-- Domain CHECK (Database Is the Law). NULL is allowed (derive the route); a
-- non-NULL value must be one of the known adapter ids.
ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_provider_domain CHECK (
    "provider" IS NULL
    OR "provider" IN ('logam_mulia', 'reksadana_id', 'yahoo', 'alpaca', 'twelvedata')
  );

-- NOTE (ADR-0052 §3): the ingestion router discovers what to price by reading the
-- GLOBAL, family-neutral `MarketInstrument` catalog directly (a row exists only
-- because a holding linked it or a prior ingest created it — so the catalog IS
-- the in-use set, bounded, with NO tenant-RLS dependency). It deliberately does
-- NOT read the tenant-scoped, FORCE-RLS holdings `Instrument` table: a
-- no-family-scope global job cannot see those rows under a NOBYPASSRLS role
-- (prod's `permoney_app`/`permoney_migrator`), and a `SECURITY DEFINER`
-- cross-tenant read is banned. No new object is needed here.
