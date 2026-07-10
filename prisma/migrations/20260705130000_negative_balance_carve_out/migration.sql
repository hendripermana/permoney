-- PER-182 / ADR-0045: negative-balance carve-out for DEPOSITORY/E_WALLET
-- accounts (real overdraft-capable cash-like assets), plus ADR-0044 §8's
-- transaction-scoped bulk-replay CHECK bypass used by chunked ledger replay.
--
-- Domain scope (ADR-0045 §1): only DEPOSITORY and E_WALLET may hold a
-- negative final ASSET balance. CASH (physically impossible negative),
-- INVESTMENT (unmodeled margin), RECEIVABLE (category error), TRACKED_ASSET
-- (unchanged, valuation-sourced), and both LIABILITY types are untouched.

-- Single source of truth (ADR-0045 §2): mirrored in TypeScript by
-- allowsNegativeAssetBalance() (src/lib/accounts.ts), coherence-tested
-- exhaustively against this function in tests/integration.
CREATE OR REPLACE FUNCTION app_allows_negative_asset(account_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT account_type IN ('DEPOSITORY', 'E_WALLET')
$$;

-- Account-side CHECK (ADR-0045 §3): explicit ASSET/LIABILITY branches so the
-- carve-out cannot be misread as applying to LIABILITY. The
-- app.bulk_ledger_replay bypass (ADR-0044 §8) is transaction-scoped via
-- SET LOCAL, set only by runBulkLedgerReplayTransaction (src/server/
-- bulk-ledger-replay.ts) — never by any live single-transaction write path.
ALTER TABLE "Account"
  DROP CONSTRAINT account_normal_balance_sign;

ALTER TABLE "Account"
  ADD CONSTRAINT account_normal_balance_sign CHECK (
    current_setting('app.bulk_ledger_replay', true) = 'on'
    OR (
      "accountClass" = 'ASSET'
      AND (balance >= 0 OR app_allows_negative_asset("accountType"))
    )
    OR (
      "accountClass" = 'LIABILITY'
      AND balance <= 0
    )
  );

-- Valuation-side (ADR-0045 §4): normalBalance keeps its original meaning
-- ("this account's usual class-implied sign"); allowsNegativeAsset is an
-- orthogonal denormalized flag populated by the writer (createValuationForFamily,
-- createAccountForFamily's opening-valuation path) from the same
-- app_allows_negative_asset(accountType) predicate at write time. DEFAULT
-- false makes the backfill for every pre-existing row trivially safe: no
-- NEGATIVE-class value ever existed under the prior, stricter CHECK.
ALTER TABLE "Valuation"
  ADD COLUMN "allowsNegativeAsset" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Valuation"
  DROP CONSTRAINT valuation_value_sign;

ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_value_sign CHECK (
    ("normalBalance" = 'POSITIVE' AND ("value" >= 0 OR "allowsNegativeAsset"))
    OR ("normalBalance" = 'NEGATIVE' AND "value" <= 0)
  );
