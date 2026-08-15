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

-- ============================================================================
-- Cross-tenant linkage discovery for the GLOBAL ingest (Financial Ingestion
-- Service, ADR-0052 §3).
--
-- The ingestion router prices only the instruments actually HELD (bounded work,
-- not the whole catalog). "Held" lives on the tenant-scoped holdings `Instrument`
-- table, which is `FORCE ROW LEVEL SECURITY` (20260804120000_holdings_core). The
-- global ingest runs with NO family scope (it writes only the family-neutral
-- market tables, never the ledger — ADR-0050 §6), so under RLS it would see zero
-- linkages and price nothing.
--
-- This `SECURITY DEFINER` function is the explicit, minimal boundary crossing:
-- it returns ONLY the set of GLOBAL `MarketInstrument` ids that at least one
-- holding links — never a tenant row, `familyId`, quantity, cost, or value. No
-- tenant-private data leaves the boundary; the function merely tells the global
-- pricing job which public price series are in use. Tenant isolation is intact;
-- the global job stays bounded. `SET search_path` hardens the definer function
-- against search-path hijacking. Owned by the (privileged) migration role, so it
-- bypasses the holdings-table RLS to compute the DISTINCT set; EXECUTE is left to
-- the PUBLIC default so the app runtime role can call it.
-- ============================================================================
CREATE OR REPLACE FUNCTION market_instrument_ids_linked_to_holdings()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT DISTINCT "marketInstrumentId"
  FROM "Instrument"
  WHERE "marketInstrumentId" IS NOT NULL
$$;
