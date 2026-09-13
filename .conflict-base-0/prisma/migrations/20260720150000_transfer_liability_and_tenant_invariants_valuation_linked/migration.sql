-- PER-196 / ADR-0048 §4: two more PER-104/PER-74 constraint triggers on
-- "Transfer" that assumed both Transaction legs always exist, found via an
-- exhaustive grep of every migration referencing outflowTransactionId /
-- inflowTransactionId after 20260720130000 shipped (that migration only
-- updated the three PER-103/ADR-0031 triggers; these two were missed the
-- first pass and surfaced immediately by real-Postgres integration tests
-- attempting a valuation-linked insert):
--
--   1. enforce_transfer_leg_pair_tenant_invariant (PER-104 / ADR-0010 §4.4):
--      required both legs to resolve a Transaction and compared their
--      familyId. Fixed by resolving the "other side" via the linked
--      Valuation's own familyId when valuationId is set.
--   2. enforce_transfer_liability_kind_invariant (PER-74 / liability
--      semantics): required both legs to resolve a Transaction (kind +
--      account class/type) and compared them. Fixed the same way: whichever
--      side has no Transaction row resolves its account class/type through
--      the linked Valuation's accountId instead, and the "both legs share
--      kind" cross-check is skipped (only one kind value exists on a
--      valuation-linked transfer — there's nothing to cross-check against).

CREATE OR REPLACE FUNCTION enforce_transfer_leg_pair_tenant_invariant()
RETURNS TRIGGER AS $$
DECLARE
  outflow_family   TEXT;
  inflow_family    TEXT;
  cash_leg_id      TEXT;
  cash_family      TEXT;
  valuation_family TEXT;
BEGIN
  IF NEW."valuationId" IS NOT NULL THEN
    cash_leg_id := COALESCE(NEW."outflowTransactionId", NEW."inflowTransactionId");

    SELECT t."familyId" INTO cash_family
      FROM "Transaction" t WHERE t.id = cash_leg_id;
    IF NOT FOUND THEN
      PERFORM _per104_raise_foreign_key_violation(format(
        'PER-196 valuation-linked Transfer %s references missing cash Transaction %s',
        NEW.id, cash_leg_id));
    END IF;

    SELECT v."familyId" INTO valuation_family
      FROM "Valuation" v WHERE v.id = NEW."valuationId";
    IF NOT FOUND THEN
      PERFORM _per104_raise_foreign_key_violation(format(
        'PER-196 valuation-linked Transfer %s references missing Valuation %s',
        NEW.id, NEW."valuationId"));
    END IF;

    IF cash_family = valuation_family THEN
      RETURN NEW;
    END IF;

    PERFORM _per104_raise_check_violation(format(
      'PER-196 cross-tenant valuation-linked Transfer rejected (Transfer -> cash %s, valuation %s): cash family=%s, valuation family=%s',
      cash_leg_id, NEW."valuationId", cash_family, valuation_family));
  END IF;

  SELECT t."familyId" INTO outflow_family
    FROM "Transaction" t WHERE t.id = NEW."outflowTransactionId";
  IF NOT FOUND THEN
    PERFORM _per104_raise_foreign_key_violation(format(
        'PER-104 Transfer %s references missing outflow Transaction %s',
        NEW.id, NEW."outflowTransactionId"
      ));
  END IF;

  SELECT t."familyId" INTO inflow_family
    FROM "Transaction" t WHERE t.id = NEW."inflowTransactionId";
  IF NOT FOUND THEN
    PERFORM _per104_raise_foreign_key_violation(format(
        'PER-104 Transfer %s references missing inflow Transaction %s',
        NEW.id, NEW."inflowTransactionId"
      ));
  END IF;

  IF outflow_family = inflow_family THEN
    RETURN NEW;
  END IF;

  PERFORM _per104_raise_check_violation(format(
      'PER-104 cross-tenant Transfer leg pair rejected (Transfer -> outflow %s, inflow %s): outflow family=%s, inflow family=%s',
      NEW."outflowTransactionId", NEW."inflowTransactionId",
      outflow_family, inflow_family
    ));
END;
$$ LANGUAGE plpgsql;

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
BEGIN
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
