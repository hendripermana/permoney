-- PER-247: contextual money movement — Transfer.purpose + generalized
-- transfer fee leg (kind "transfer_fee").
--
--   1. Transfer.purpose: constrained, nullable label describing WHY a
--      funds_movement transfer happened (top_up / investment_contribution /
--      investment_withdrawal / savings / cash_withdrawal). NULL means "plain
--      transfer". Liability transfer kinds (cc_payment / loan_payment /
--      liability_draw) already carry their meaning via `kind`, so purpose is
--      forbidden there (trigger guard below).
--   2. New transaction kind "transfer_fee": a standalone expense row posted
--      on the fee-bearing account (default: the transfer source account),
--      linked via Transfer.feeTransactionId — the same slot ADR-0035 §6 uses
--      for fx_fee. One fee leg max per transfer; the kind distinguishes an FX
--      conversion fee (cross-currency transfer) from a general transfer fee.
--   3. Backstops: the fee leg link is now trigger-checked to point only at an
--      fx_fee/transfer_fee expense row, and purpose is trigger-checked to
--      appear only on funds_movement transfers. Both guards live in the
--      existing enforce_transfer_liability_kind_invariant() choke point.

-- 1. Transfer.purpose ----------------------------------------------------------

ALTER TABLE "Transfer" ADD COLUMN "purpose" TEXT;

ALTER TABLE "Transfer"
  ADD CONSTRAINT transfer_purpose_domain CHECK (
    purpose IS NULL
    OR purpose IN (
      'top_up',
      'investment_contribution',
      'investment_withdrawal',
      'savings',
      'cash_withdrawal'
    )
  );

-- 2. `transfer_fee` transaction kind -------------------------------------------
-- Drop + recreate the kind domain and type/kind shape CHECKs to add
-- 'transfer_fee' (established pattern: 20260602043000, 20260617131419,
-- 20260618120000). Like fx_fee it is an EXPENSE kind (a finance cost), never a
-- transfer, and is naturally exempt from
-- enforce_liability_cost_transaction_target() (which early-returns unless
-- kind IN ('liability_interest','liability_fee')), so no toAccountId or
-- liability-target requirement applies.

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
      'transfer_fee'
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
    OR ("type" = 'income' AND kind IN ('standard', 'balance_adjustment'))
  );

-- 3. Trigger guards: purpose only on funds_movement + fee leg kind -------------

CREATE OR REPLACE FUNCTION enforce_transfer_liability_kind_invariant()
RETURNS TRIGGER AS $$
DECLARE
  expected_kind TEXT;
  cash_kind TEXT;
  outflow_account_class TEXT;
  outflow_account_type TEXT;
  inflow_account_class TEXT;
  inflow_account_type TEXT;
  outflow_kind TEXT;
  inflow_kind TEXT;
  fee_kind TEXT;
  fee_type TEXT;
BEGIN
  -- PER-247: a linked fee leg must be a fee expense row. Guarded here (the
  -- single choke point every Transfer write passes) so raw SQL / future
  -- workers cannot link an arbitrary transaction as a transfer's fee.
  IF NEW."feeTransactionId" IS NOT NULL THEN
    SELECT t.kind, t.type INTO fee_kind, fee_type
      FROM "Transaction" t WHERE t.id = NEW."feeTransactionId";
    IF fee_kind NOT IN ('fx_fee', 'transfer_fee') OR fee_type <> 'expense' THEN
      PERFORM _per104_raise_check_violation(format(
        'PER-247 malformed transfer fee leg (Transfer %s): fee Transaction %s must be an expense of kind fx_fee/transfer_fee, got type=%s kind=%s',
        NEW.id, NEW."feeTransactionId", fee_type, fee_kind));
    END IF;
  END IF;

  IF NEW."valuationId" IS NOT NULL THEN
    IF NEW."outflowTransactionId" IS NOT NULL THEN
      SELECT tx.kind, a."accountClass", a."accountType"
        INTO cash_kind, outflow_account_class, outflow_account_type
        FROM "Transaction" tx
        JOIN "Account" a ON a.id = tx."accountId" AND a."familyId" = tx."familyId"
       WHERE tx.id = NEW."outflowTransactionId";

      SELECT a."accountClass", a."accountType"
        INTO inflow_account_class, inflow_account_type
        FROM "Valuation" v
        JOIN "Account" a ON a.id = v."accountId" AND a."familyId" = v."familyId"
       WHERE v.id = NEW."valuationId";
    ELSE
      SELECT tx.kind, a."accountClass", a."accountType"
        INTO cash_kind, inflow_account_class, inflow_account_type
        FROM "Transaction" tx
        JOIN "Account" a ON a.id = tx."accountId" AND a."familyId" = tx."familyId"
       WHERE tx.id = NEW."inflowTransactionId";

      SELECT a."accountClass", a."accountType"
        INTO outflow_account_class, outflow_account_type
        FROM "Valuation" v
        JOIN "Account" a ON a.id = v."accountId" AND a."familyId" = v."familyId"
       WHERE v.id = NEW."valuationId";
    END IF;

    IF inflow_account_type = 'CREDIT' THEN
      expected_kind := 'cc_payment';
    ELSIF inflow_account_type = 'LOAN' THEN
      expected_kind := 'loan_payment';
    ELSIF outflow_account_class = 'LIABILITY' AND inflow_account_class = 'ASSET' THEN
      expected_kind := 'liability_draw';
    ELSIF outflow_account_class = 'ASSET' AND inflow_account_class = 'ASSET' THEN
      expected_kind := 'funds_movement';
    ELSE
      PERFORM _per104_raise_check_violation(format(
        'PER-196 unsupported valuation-linked transfer direction (Transfer %s): outflow %s/%s, inflow %s/%s',
        NEW.id, outflow_account_class, outflow_account_type, inflow_account_class, inflow_account_type));
    END IF;

    IF cash_kind IS DISTINCT FROM expected_kind THEN
      PERFORM _per104_raise_check_violation(format(
        'PER-196 malformed valuation-linked transfer kind (Transfer %s): expected %s for outflow %s/%s -> inflow %s/%s, got %s',
        NEW.id, expected_kind, outflow_account_class, outflow_account_type, inflow_account_class, inflow_account_type, cash_kind));
    END IF;

    -- PER-247: purpose is a funds_movement-only label.
    IF NEW.purpose IS NOT NULL AND expected_kind <> 'funds_movement' THEN
      PERFORM _per104_raise_check_violation(format(
        'PER-247 transfer purpose %s rejected (Transfer %s): purpose requires kind funds_movement, got %s',
        NEW.purpose, NEW.id, expected_kind));
    END IF;

    RETURN NEW;
  END IF;

  SELECT
      outflow_tx.kind,
      outflow_account."accountClass",
      outflow_account."accountType"
    INTO outflow_kind, outflow_account_class, outflow_account_type
    FROM "Transaction" outflow_tx
    JOIN "Account" outflow_account
      ON outflow_account.id = outflow_tx."accountId"
     AND outflow_account."familyId" = outflow_tx."familyId"
   WHERE outflow_tx.id = NEW."outflowTransactionId";

  SELECT
      inflow_tx.kind,
      inflow_account."accountClass",
      inflow_account."accountType"
    INTO inflow_kind, inflow_account_class, inflow_account_type
    FROM "Transaction" inflow_tx
    JOIN "Account" inflow_account
      ON inflow_account.id = inflow_tx."accountId"
     AND inflow_account."familyId" = inflow_tx."familyId"
   WHERE inflow_tx.id = NEW."inflowTransactionId";

  IF outflow_kind IS DISTINCT FROM inflow_kind THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-74 malformed transfer kind pair (Transfer %s): outflow kind=%s, inflow kind=%s; both legs must share kind',
      NEW.id, outflow_kind, inflow_kind));
  END IF;

  IF inflow_account_type = 'CREDIT' THEN
    expected_kind := 'cc_payment';
  ELSIF inflow_account_type = 'LOAN' THEN
    expected_kind := 'loan_payment';
  ELSIF outflow_account_class = 'LIABILITY'
     AND inflow_account_class = 'ASSET' THEN
    expected_kind := 'liability_draw';
  ELSIF outflow_account_class = 'ASSET'
     AND inflow_account_class = 'ASSET' THEN
    expected_kind := 'funds_movement';
  ELSE
    PERFORM _per104_raise_check_violation(format(
      'PER-74 unsupported transfer liability direction (Transfer %s): outflow %s/%s, inflow %s/%s',
      NEW.id,
      outflow_account_class,
      outflow_account_type,
      inflow_account_class,
      inflow_account_type));
  END IF;

  IF outflow_kind IS DISTINCT FROM expected_kind THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-74 malformed transfer kind (Transfer %s): expected %s for outflow %s/%s -> inflow %s/%s, got %s',
      NEW.id,
      expected_kind,
      outflow_account_class,
      outflow_account_type,
      inflow_account_class,
      inflow_account_type,
      outflow_kind));

  END IF;

  -- PER-247: purpose is a funds_movement-only label.
  IF NEW.purpose IS NOT NULL AND expected_kind <> 'funds_movement' THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-247 transfer purpose %s rejected (Transfer %s): purpose requires kind funds_movement, got %s',
      NEW.purpose, NEW.id, expected_kind));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-create the constraint trigger so purpose/fee-only UPDATEs re-fire the
-- guard too (the previous OF-column list predates both columns).
DROP TRIGGER IF EXISTS transfer_liability_kind_safe ON "Transfer";
CREATE CONSTRAINT TRIGGER transfer_liability_kind_safe
  AFTER INSERT OR UPDATE OF "outflowTransactionId", "inflowTransactionId", "valuationId", "purpose", "feeTransactionId" ON "Transfer"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_liability_kind_invariant();
