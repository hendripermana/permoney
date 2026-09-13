-- PER-217 — Account reserve / minimum balance ("dana mengendap").
--
-- A user-defined spending floor: money the owner keeps untouched inside a
-- cash-like account (a real bank/e-wallet minimum balance, commonly Rp 20k–50k,
-- or a self-imposed buffer). It is LEDGER-NEUTRAL by construction:
--   * it NEVER changes Account.balance, net worth, transactions, or valuations;
--   * it only feeds the computed "available" (safe-to-spend) view server-side
--     (available = current − held − reserve) and the same figure on the client.
--
-- Because it is a spending earmark, it is meaningful ONLY for cash-like ASSET
-- accounts (accountClass = 'ASSET' AND balanceSource = 'transaction_flow').
-- Liabilities have no "reserve to keep", and tracked/valuation assets are not
-- spent against. A CHECK enforces that invariant so it can never drift
-- ("Database Is the Law", CLAUDE.md §5A): the column is NULL for every other
-- account, and non-negative when present.

ALTER TABLE "Account"
  ADD COLUMN "reserveBalance" BIGINT;

ALTER TABLE "Account"
  ADD CONSTRAINT "account_reserve_balance_valid"
  CHECK (
    "reserveBalance" IS NULL
    OR (
      "reserveBalance" >= 0
      AND "accountClass" = 'ASSET'
      AND "balanceSource" = 'transaction_flow'
    )
  );
