-- PER-74: liability semantics for credit, loan, BNPL, interest, and fees.
--
-- Account balance signs were introduced in PER-73. This migration tightens the
-- Transaction.kind contract so reports can distinguish ordinary spending,
-- liability principal payments, liability draws/new borrowing, and finance
-- charges without changing historical balances.

-- Reclassify existing transfer metadata from the transfer graph direction.
-- This is a metadata correction only: amounts, balances, and audit rows remain
-- unchanged.
WITH transfer_expected_kind AS (
  SELECT
    tr."outflowTransactionId",
    tr."inflowTransactionId",
    CASE
      WHEN inflow_account."accountType" = 'CREDIT' THEN 'cc_payment'
      WHEN inflow_account."accountType" = 'LOAN' THEN 'loan_payment'
      WHEN outflow_account."accountClass" = 'LIABILITY'
        AND inflow_account."accountClass" = 'ASSET'
        THEN 'liability_draw'
      ELSE 'funds_movement'
    END AS expected_kind
  FROM "Transfer" tr
  JOIN "Transaction" outflow_tx
    ON outflow_tx.id = tr."outflowTransactionId"
  JOIN "Transaction" inflow_tx
    ON inflow_tx.id = tr."inflowTransactionId"
  JOIN "Account" outflow_account
    ON outflow_account.id = outflow_tx."accountId"
   AND outflow_account."familyId" = outflow_tx."familyId"
  JOIN "Account" inflow_account
    ON inflow_account.id = inflow_tx."accountId"
   AND inflow_account."familyId" = inflow_tx."familyId"
)
UPDATE "Transaction" tx
   SET kind = transfer_expected_kind.expected_kind
  FROM transfer_expected_kind
 WHERE tx.id IN (
   transfer_expected_kind."outflowTransactionId",
   transfer_expected_kind."inflowTransactionId"
 )
   AND tx.kind <> transfer_expected_kind.expected_kind;

ALTER TABLE "Transaction"
  DROP CONSTRAINT IF EXISTS transaction_kind_type_shape;

ALTER TABLE "Transaction"
  DROP CONSTRAINT IF EXISTS transaction_kind_domain;

ALTER TABLE "Transaction"
  ADD CONSTRAINT transaction_kind_domain CHECK (
    kind IN (
      'standard',
      'funds_movement',
      'cc_payment',
      'loan_payment',
      'liability_draw',
      'liability_interest',
      'liability_fee'
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
        'liability_fee'
      ))
    OR ("type" = 'income' AND kind = 'standard')
  );

CREATE OR REPLACE FUNCTION enforce_liability_cost_transaction_target()
RETURNS TRIGGER AS $$
DECLARE
  target_class TEXT;
BEGIN
  IF NEW.kind NOT IN ('liability_interest', 'liability_fee') THEN
    RETURN NEW;
  END IF;

  IF NEW.type <> 'expense' OR NEW."toAccountId" IS NULL THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-74 malformed liability cost Transaction %s: kind=%s requires type=expense and a liability toAccountId',
      NEW.id, NEW.kind));
  END IF;

  SELECT "accountClass" INTO target_class
    FROM "Account"
   WHERE id = NEW."toAccountId"
     AND "familyId" = NEW."familyId";

  IF target_class IS DISTINCT FROM 'LIABILITY' THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-74 malformed liability cost Transaction %s: target account %s is not a liability',
      NEW.id, NEW."toAccountId"));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_transfer_liability_kind_invariant()
RETURNS TRIGGER AS $$
DECLARE
  expected_kind TEXT;
  inflow_account_class TEXT;
  inflow_account_type TEXT;
  inflow_kind TEXT;
  outflow_account_class TEXT;
  outflow_account_type TEXT;
  outflow_kind TEXT;
BEGIN
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transaction_liability_cost_target_safe ON "Transaction";
CREATE CONSTRAINT TRIGGER transaction_liability_cost_target_safe
  AFTER INSERT OR UPDATE OF kind, type, "toAccountId", "familyId" ON "Transaction"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_liability_cost_transaction_target();

DROP TRIGGER IF EXISTS transfer_liability_kind_safe ON "Transfer";
CREATE CONSTRAINT TRIGGER transfer_liability_kind_safe
  AFTER INSERT OR UPDATE OF "outflowTransactionId", "inflowTransactionId" ON "Transfer"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_liability_kind_invariant();
