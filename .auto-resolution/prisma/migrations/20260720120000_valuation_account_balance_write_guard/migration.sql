-- PER-196 / ADR-0048 §3: database backstop for the valuation-account balance
-- write guard.
--
-- `balanceSource = "valuation"` accounts (TRACKED_ASSET) derive their
-- canonical balance solely from the latest Valuation (ADR-0034 §5,
-- ADR-0043 §3, unchanged). `applyAccountBalanceDelta`
-- (src/server/transactions.ts) now refuses to apply an incremental
-- `balance: { increment }` write to such an account at the TypeScript layer.
-- This trigger is the "database is the law" backstop for that same
-- invariant: it does not matter which future call site forgets the
-- TypeScript check, or which raw-SQL/maintenance path bypasses application
-- code entirely — the constraint still holds.
--
-- Two transaction-scoped bypass GUCs, both SET LOCAL (`set_config(..., true)`),
-- both read-only from this trigger's perspective:
--   app.bulk_ledger_replay      -- existing (ADR-0044 §8): chunked import
--                                  replay (src/server/bulk-ledger-replay.ts),
--                                  always followed by an unbypassed
--                                  rebuildFamilyBalances() outside the wrapper.
--   app.valuation_balance_write -- NEW: the single legitimate absolute-set
--                                  writer, set only inside setAccountBalanceTo
--                                  (src/server/valuations.ts), which both
--                                  createValuationForFamily and
--                                  rebuildWithinTx/rebuildFamilyBalances
--                                  route every write through.
--
-- Fires only on UPDATE OF balance where the value actually changes, so a
-- no-op write (or an update that touches other columns only) is never
-- affected. No pre-existing-violation audit is needed (unlike PER-103's
-- migration): this trigger constrains future writes, not current row shape;
-- existing PER-196 drift from before this migration is fixed separately by
-- the ADR-0048 §5 cleanup migration.

CREATE OR REPLACE FUNCTION enforce_valuation_account_balance_write_invariant()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."balanceSource" = 'valuation'
     AND NEW.balance <> OLD.balance
     AND COALESCE(current_setting('app.bulk_ledger_replay', true), 'off') <> 'on'
     AND COALESCE(current_setting('app.valuation_balance_write', true), 'off') <> 'on'
  THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-196 refused incremental balance write on valuation-tracked Account %s: balanceSource="valuation" accounts may only change balance through a Valuation write (ADR-0048 §3)',
      NEW.id));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER valuation_account_balance_write_safe
  AFTER UPDATE OF balance ON "Account"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_valuation_account_balance_write_invariant();
