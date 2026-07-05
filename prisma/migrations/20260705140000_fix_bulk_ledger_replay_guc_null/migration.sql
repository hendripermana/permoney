-- PER-182 fix: account_normal_balance_sign's app.bulk_ledger_replay bypass
-- clause used `current_setting('app.bulk_ledger_replay', true) = 'on'`.
-- When the GUC is unset (the normal, non-bulk-replay case), current_setting
-- with missing_ok=true returns SQL NULL, and `NULL = 'on'` evaluates to NULL,
-- not false. `NULL OR false OR false` is NULL, and Postgres CHECK constraints
-- only reject a row when the expression evaluates to FALSE — NULL is treated
-- as satisfied. This silently disabled the ENTIRE sign invariant (both ASSET
-- and LIABILITY directions) whenever the bypass GUC was unset, i.e. always,
-- outside a wrapped bulk-replay transaction. Caught by real-PG integration
-- tests before merge (a raw negative-CASH insert and a positive-LIABILITY
-- insert both resolved instead of rejecting). Fixed with an explicit
-- COALESCE so the bypass clause is always a real boolean, never NULL.

ALTER TABLE "Account"
  DROP CONSTRAINT account_normal_balance_sign;

ALTER TABLE "Account"
  ADD CONSTRAINT account_normal_balance_sign CHECK (
    COALESCE(current_setting('app.bulk_ledger_replay', true), 'off') = 'on'
    OR (
      "accountClass" = 'ASSET'
      AND (balance >= 0 OR app_allows_negative_asset("accountType"))
    )
    OR (
      "accountClass" = 'LIABILITY'
      AND balance <= 0
    )
  );
