-- PER-196 / ADR-0048 §4: Transfer gains an optional valuation leg.
--
-- A classic transfer (both legs cash-like) is unchanged: both Transaction FKs
-- set, valuationId null. A valuation-linked move (one leg on a
-- balanceSource="valuation" account) sets exactly one of
-- outflowTransactionId/inflowTransactionId (whichever side is the cash leg)
-- plus valuationId (the new Valuation written on the tracked-asset side).
-- This generalizes, not weakens, the ADR-0031/PER-103 dual-leg invariant: a
-- second, equally-strict leg shape, not an unchecked one.
--
-- No pre-existing-row audit is needed (unlike PER-103's original migration):
-- every existing Transfer row already has BOTH Transaction FKs NOT NULL under
-- the old schema, and this migration only ADDS the nullable valuationId
-- column (defaulting NULL) — every existing row trivially satisfies the new
-- transfer_leg_shape CHECK's first branch (both legs set, valuationId null)
-- by construction.

-- ============================================================================
-- 1. Base schema change (Prisma-generated diff).
-- ============================================================================
ALTER TABLE "Transfer" ADD COLUMN     "valuationId" TEXT,
ALTER COLUMN "outflowTransactionId" DROP NOT NULL,
ALTER COLUMN "inflowTransactionId" DROP NOT NULL;

CREATE UNIQUE INDEX "Transfer_valuationId_key" ON "Transfer"("valuationId");

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "Valuation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 2. Leg-shape CHECK: classic dual-Transaction XOR valuation-linked.
-- ============================================================================
-- transfer_no_self_reference (outflowTransactionId <> inflowTransactionId)
-- from PER-103 is untouched and still correct: when either side is NULL
-- (valuation-linked case), the comparison evaluates to NULL, which Postgres
-- treats as satisfying the CHECK — no change needed there.
ALTER TABLE "Transfer"
  ADD CONSTRAINT "transfer_leg_shape" CHECK (
    ("outflowTransactionId" IS NOT NULL AND "inflowTransactionId" IS NOT NULL AND "valuationId" IS NULL)
    OR (
      "valuationId" IS NOT NULL
      AND (("outflowTransactionId" IS NOT NULL) <> ("inflowTransactionId" IS NOT NULL))
    )
  );

-- ============================================================================
-- 3. PER-103 trigger functions gain a valuation-linked branch.
-- ============================================================================
-- CHECK constraints validate synchronously at row-insert time, strictly
-- before any AFTER trigger fires (both of these are "AFTER INSERT ...
-- DEFERRABLE INITIALLY IMMEDIATE"), so by the time either function below
-- runs, transfer_leg_shape has already guaranteed: valuationId set implies
-- exactly one of outflowTransactionId/inflowTransactionId is set. Each
-- function only needs to resolve "the cash leg", not re-derive that
-- invariant.

CREATE OR REPLACE FUNCTION enforce_transfer_type_shape_invariant()
RETURNS TRIGGER AS $$
DECLARE
  outflow_type  TEXT;
  inflow_type   TEXT;
  cash_leg_id   TEXT;
  cash_leg_type TEXT;
BEGIN
  IF NEW."valuationId" IS NOT NULL THEN
    cash_leg_id := COALESCE(NEW."outflowTransactionId", NEW."inflowTransactionId");

    SELECT type INTO cash_leg_type
      FROM "Transaction" WHERE id = cash_leg_id;
    IF NOT FOUND THEN
      PERFORM _per104_raise_foreign_key_violation(format(
        'PER-196 valuation-linked Transfer %s references missing cash Transaction %s',
        NEW.id, cash_leg_id));
    END IF;

    IF cash_leg_type <> 'transfer' THEN
      PERFORM _per104_raise_check_violation(format(
        'PER-196 malformed valuation-linked transfer type-shape (Transfer %s): cash leg type=%s; must be ''transfer''',
        NEW.id, cash_leg_type));
    END IF;

    RETURN NEW;
  END IF;

  SELECT type INTO outflow_type
    FROM "Transaction" WHERE id = NEW."outflowTransactionId";
  IF NOT FOUND THEN
    PERFORM _per104_raise_foreign_key_violation(format(
      'PER-103 Transfer %s references missing outflow Transaction %s',
      NEW.id, NEW."outflowTransactionId"));
  END IF;

  SELECT type INTO inflow_type
    FROM "Transaction" WHERE id = NEW."inflowTransactionId";
  IF NOT FOUND THEN
    PERFORM _per104_raise_foreign_key_violation(format(
      'PER-103 Transfer %s references missing inflow Transaction %s',
      NEW.id, NEW."inflowTransactionId"));
  END IF;

  IF outflow_type <> 'transfer' OR inflow_type <> 'transfer' THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-103 malformed transfer type-shape (Transfer %s): outflow type=%s, inflow type=%s; both must be ''transfer''',
      NEW.id, outflow_type, inflow_type));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_transfer_account_distinct_invariant()
RETURNS TRIGGER AS $$
DECLARE
  outflow_account   TEXT;
  inflow_account    TEXT;
  cash_leg_id       TEXT;
  cash_account      TEXT;
  valuation_account TEXT;
BEGIN
  IF NEW."valuationId" IS NOT NULL THEN
    cash_leg_id := COALESCE(NEW."outflowTransactionId", NEW."inflowTransactionId");

    SELECT "accountId" INTO cash_account
      FROM "Transaction" WHERE id = cash_leg_id;
    SELECT "accountId" INTO valuation_account
      FROM "Valuation" WHERE id = NEW."valuationId";

    IF cash_account = valuation_account THEN
      PERFORM _per104_raise_check_violation(format(
        'PER-196 malformed valuation-linked transfer (Transfer %s): cash leg and valuation share account %s; a transfer must move between two distinct accounts',
        NEW.id, cash_account));
    END IF;

    RETURN NEW;
  END IF;

  SELECT "accountId" INTO outflow_account
    FROM "Transaction" WHERE id = NEW."outflowTransactionId";
  SELECT "accountId" INTO inflow_account
    FROM "Transaction" WHERE id = NEW."inflowTransactionId";

  IF outflow_account = inflow_account THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-103 malformed transfer (Transfer %s): outflow and inflow share account %s; a transfer must move between two distinct accounts',
      NEW.id, outflow_account));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- enforce_transfer_typed_transaction_paired_invariant (the deferred
-- Transaction-side trigger) is UNCHANGED: it counts Transfer rows matching
-- "outflowTransactionId = NEW.id OR inflowTransactionId = NEW.id", which
-- already resolves to exactly 1 for a valuation-linked transfer's one
-- type='transfer' Transaction row (it sits in whichever FK slot is non-null),
-- identically to the classic dual-leg case.
