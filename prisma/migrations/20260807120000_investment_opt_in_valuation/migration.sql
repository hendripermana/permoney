-- PER-239 / ADR-0051: opt-in valuation tracking for INVESTMENT accounts.
--
-- Genuine INVESTMENT accounts default to balanceSource='transaction_flow'
-- (_per143_balance_source_for_type). To record holdings (ADR-0051) an
-- INVESTMENT account may be explicitly promoted to 'valuation' through the
-- `enableHoldingsTrackingFn` endpoint (a controlled, audited, one-way opt-in
-- that seeds a balance-preserving reconciliation anchor in the same
-- transaction).
--
-- This relaxes the consistency CHECK so an INVESTMENT account may hold EITHER
-- source, while every other accountType stays pinned to its derived source:
-- TRACKED_ASSET => 'valuation'; all others => 'transaction_flow'. The default
-- column value and the account-CREATE path are unchanged (a new INVESTMENT
-- account is still born 'transaction_flow'); only the explicit opt-in flips it.
-- One-way for now (reverse valuation => transaction_flow is a later slice).

ALTER TABLE "Account"
  DROP CONSTRAINT account_balance_source_consistency;

ALTER TABLE "Account"
  ADD CONSTRAINT account_balance_source_consistency CHECK (
    CASE
      WHEN "accountType" = 'INVESTMENT'
        THEN "balanceSource" IN ('transaction_flow', 'valuation')
      ELSE "balanceSource" = _per143_balance_source_for_type("accountType")
    END
  );
