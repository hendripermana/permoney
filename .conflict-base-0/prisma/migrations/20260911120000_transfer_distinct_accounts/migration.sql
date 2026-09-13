-- PER-253 Tier 3 "same-account/round-trip guards": a transfer row with
-- accountId = toAccountId is not a real money movement — it nets to zero but
-- still posts two garbage legs (outflow + inflow) onto the SAME account's
-- statement, and violates every downstream assumption that a transfer's two
-- legs land on distinct accounts (per-account direction inference,
-- deriveTransferKindForAccounts, the Transfer row's outflow/inflow pairing).
--
-- The application-level guard lives in `assertManualTransactionKindShape`
-- (src/server/transactions.ts), the single choke point both the create path
-- (`createTransactionForFamily`) and the edit/reversal-and-replace path
-- (`replaceTransactionWithinTenantTransaction`) call before any balance delta
-- or ledger row is written. This CHECK is the "Database Is the Law"
-- defense-in-depth backstop so a raw-SQL write, a future code path, or a bug
-- in the application guard can never persist the violation either.
--
-- `toAccountId` is only meaningful for transfers (NULL for expense/income),
-- so the condition only needs to reject the transfer+equal case — a NULL
-- toAccountId can never equal a non-null accountId.
ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_transfer_distinct_accounts CHECK (
    "type" <> 'transfer' OR "accountId" <> "toAccountId"
  );
