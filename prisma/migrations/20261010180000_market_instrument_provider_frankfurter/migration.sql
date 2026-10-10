-- PER-234 / ADR-0050 slice 2 — the Frankfurter (ECB reference rates) FX
-- adapter joins the provider-routing domain (ADR-0052 §1). This is a pure
-- WIDENING of the CHECK: every previously-valid value stays valid, the domain
-- only grows by one adapter id ('frankfurter'). No row is rewritten, dropped,
-- or re-typed; the constraint is re-declared (Postgres CHECK domains can only
-- change via DROP + ADD) with the exact same name so the history stays stable.
ALTER TABLE "MarketInstrument"
  DROP CONSTRAINT IF EXISTS market_instrument_provider_domain;

ALTER TABLE "MarketInstrument"
  ADD CONSTRAINT market_instrument_provider_domain CHECK (
    "provider" IS NULL
    OR "provider" IN (
      'logam_mulia', 'reksadana_id', 'yahoo', 'alpaca', 'twelvedata',
      'frankfurter'
    )
  );
