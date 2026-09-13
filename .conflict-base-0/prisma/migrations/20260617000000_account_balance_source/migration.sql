-- PER-143 (M2.5-4): cash-like vs tracked-asset distinction.
--
-- `balanceSource` records whether an account's balance is driven by transaction
-- flow (cash-like: cash, depository, e-wallet, credit, loan, investment,
-- receivable) or by point-in-time valuations (tracked assets: property,
-- vehicle, collectibles). It is a pure function of `accountType` so it can never
-- drift from the ledger capability family. A `TRACKED_ASSET` is valuation-driven;
-- everything else posts its balance from canonical `Transaction` rows.
--
-- See docs/account-taxonomy.md and docs/adr/0008-core-domain-model-and-ledger-boundaries.md §6.

CREATE OR REPLACE FUNCTION _per143_balance_source_for_type(account_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN account_type = 'TRACKED_ASSET' THEN 'valuation'
    ELSE 'transaction_flow'
  END
$$;

ALTER TABLE "Account"
  ADD COLUMN "balanceSource" TEXT NOT NULL DEFAULT 'transaction_flow';

UPDATE "Account"
   SET "balanceSource" = _per143_balance_source_for_type("accountType");

ALTER TABLE "Account"
  ADD CONSTRAINT account_balance_source_domain CHECK (
    "balanceSource" IN ('transaction_flow', 'valuation')
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_balance_source_consistency CHECK (
    "balanceSource" = _per143_balance_source_for_type("accountType")
  );
