-- PER-260: reimbursement/refund category offset — new transaction kind
-- "reimbursement", valid ONLY on type="income".
--
--   An income row tagged kind="reimbursement" and assigned an EXPENSE-type
--   category nets against that category's spending in both the cash-flow
--   report (src/lib/cash-flow.ts groups byCategory agnostic of Category.type
--   already) and the budget engine (src/server/budgets.ts fetchPeriodLedgerRows
--   additionally pulls these rows for the matching budgeted category). See
--   ADR-0055 for the full decision record.
--
-- Widen the kind domain + type/kind shape CHECKs additively (established
-- pattern: 20260602043000, 20260617131419, 20260618120000, 20260809120000) —
-- never edit an old migration file.

ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS transaction_kind_type_shape;
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS transaction_kind_domain;

ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_kind_domain CHECK (
    kind IN (
      'standard',
      'funds_movement',
      'cc_payment',
      'loan_payment',
      'liability_draw',
      'liability_interest',
      'liability_fee',
      'balance_adjustment',
      'fx_fee',
      'transfer_fee',
      'reimbursement'
    )
  );

ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_kind_type_shape CHECK (
    ("type" = 'transfer'
      AND kind IN (
        'funds_movement',
        'cc_payment',
        'loan_payment',
        'liability_draw'
      ))
    OR ("type" = 'expense'
      AND kind IN (
        'standard',
        'liability_interest',
        'liability_fee',
        'balance_adjustment',
        'fx_fee',
        'transfer_fee'
      ))
    OR ("type" = 'income'
      AND kind IN ('standard', 'balance_adjustment', 'reimbursement'))
  );
