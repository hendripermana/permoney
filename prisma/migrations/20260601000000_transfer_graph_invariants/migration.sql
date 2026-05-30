-- PER-103 / ADR-0031: Transfer graph database invariants.
--
-- A Transfer is one money movement: two Transaction rows (outflow + inflow)
-- linked by a Transfer row. PER-104 locked the leg pair to one family; PER-20
-- locked hard-delete + soft-delete symmetry. Four shape invariants remain
-- unenforced and are closed here, reusing the PER-104 constraint-trigger
-- pattern and SQLSTATE helper (_per104_raise_check_violation).
--
--   1. Self-reference: outflowTransactionId <> inflowTransactionId (CHECK).
--   2. Type-shape: both referenced legs have type='transfer' (immediate trigger).
--   3. Account-distinct: the two legs use different accounts (immediate trigger).
--   4. Inverse pairing: every type='transfer' Transaction has exactly one
--      Transfer row referencing it (DEFERRABLE INITIALLY DEFERRED trigger that
--      fires at COMMIT, because the app creates the two legs and the Transfer
--      row across several statements inside one transaction).
--
-- See docs/adr/0031-transfer-graph-invariants.md for the full rationale,
-- including why pairing must be deferred and the strict-pairing decision.

-- ============================================================================
-- 1. Fail-loud drift guard (mirror PER-104 / PER-20).
-- ============================================================================
-- The development database was audited clean (all five counts zero). The guard
-- defends CI and production: it aborts the migration if any pre-existing row
-- already violates one of the four invariants, rather than letting the trigger
-- creation succeed over silently-malformed data.
DO $$
DECLARE
  type_shape_violations    INT;
  orphan_leg_violations    INT;
  self_ref_violations      INT;
  same_account_violations  INT;
BEGIN
  SELECT COUNT(*) INTO type_shape_violations
  FROM "Transfer" tr
  JOIN "Transaction" tout ON tout.id = tr."outflowTransactionId"
  JOIN "Transaction" tin  ON tin.id  = tr."inflowTransactionId"
  WHERE tout.type <> 'transfer' OR tin.type <> 'transfer';

  SELECT COUNT(*) INTO orphan_leg_violations
  FROM "Transaction" t
  LEFT JOIN "Transfer" tro ON tro."outflowTransactionId" = t.id
  LEFT JOIN "Transfer" tri ON tri."inflowTransactionId"  = t.id
  WHERE t.type = 'transfer' AND tro.id IS NULL AND tri.id IS NULL;

  SELECT COUNT(*) INTO self_ref_violations
  FROM "Transfer"
  WHERE "outflowTransactionId" = "inflowTransactionId";

  SELECT COUNT(*) INTO same_account_violations
  FROM "Transfer" tr
  JOIN "Transaction" tout ON tout.id = tr."outflowTransactionId"
  JOIN "Transaction" tin  ON tin.id  = tr."inflowTransactionId"
  WHERE tout."accountId" = tin."accountId";

  IF type_shape_violations > 0
     OR orphan_leg_violations > 0
     OR self_ref_violations > 0
     OR same_account_violations > 0 THEN
    RAISE EXCEPTION
      'PER-103 migration aborted: malformed transfer graph(s) detected (type-shape=%, orphan-leg=%, self-ref=%, same-account=%). Manual reconciliation required before re-running.',
      type_shape_violations, orphan_leg_violations,
      self_ref_violations, same_account_violations;
  END IF;
END
$$;

-- ============================================================================
-- 2. Self-reference CHECK (in-row, no trigger needed).
-- ============================================================================
ALTER TABLE "Transfer"
  ADD CONSTRAINT "transfer_no_self_reference"
  CHECK ("outflowTransactionId" <> "inflowTransactionId");

-- ============================================================================
-- 3. Trigger functions (Pattern B). Reuse the PER-104 SQLSTATE helper.
-- ============================================================================

-- 3.1 Type-shape: both legs a Transfer references must be type='transfer'.
CREATE OR REPLACE FUNCTION enforce_transfer_type_shape_invariant()
RETURNS TRIGGER AS $$
DECLARE
  outflow_type TEXT;
  inflow_type  TEXT;
BEGIN
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

-- 3.2 Account-distinct: the two legs must use different accounts.
CREATE OR REPLACE FUNCTION enforce_transfer_account_distinct_invariant()
RETURNS TRIGGER AS $$
DECLARE
  outflow_account TEXT;
  inflow_account  TEXT;
BEGIN
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

-- 3.3 Inverse pairing: a type='transfer' Transaction must have exactly one
-- Transfer row referencing it (as outflow XOR inflow). Deferred: fires at
-- COMMIT, after the app has created the Transfer row in the same transaction.
-- Soft-delete (PER-20) keeps the Transfer row (only deletedAt is set), so the
-- pair still exists and this check still passes.
CREATE OR REPLACE FUNCTION enforce_transfer_typed_transaction_paired_invariant()
RETURNS TRIGGER AS $$
DECLARE
  pair_count INT;
BEGIN
  IF NEW.type <> 'transfer' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO pair_count
    FROM "Transfer"
    WHERE "outflowTransactionId" = NEW.id
       OR "inflowTransactionId"  = NEW.id;

  IF pair_count <> 1 THEN
    PERFORM _per104_raise_check_violation(format(
      'PER-103 orphan transfer leg: Transaction %s has type=''transfer'' but is referenced by %s Transfer row(s); exactly one is required',
      NEW.id, pair_count));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 4. Constraint triggers.
-- ============================================================================
-- Two immediate triggers on Transfer (both legs exist at write time, so the
-- referenced types/accounts can be read immediately) and one deferred trigger
-- on Transaction (the Transfer row is created later in the same transaction).

CREATE CONSTRAINT TRIGGER transfer_type_shape_safe
  AFTER INSERT OR UPDATE OF "outflowTransactionId", "inflowTransactionId" ON "Transfer"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_type_shape_invariant();

CREATE CONSTRAINT TRIGGER transfer_account_distinct_safe
  AFTER INSERT OR UPDATE OF "outflowTransactionId", "inflowTransactionId" ON "Transfer"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_account_distinct_invariant();

CREATE CONSTRAINT TRIGGER transaction_transfer_paired_safe
  AFTER INSERT OR UPDATE OF type ON "Transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_typed_transaction_paired_invariant();
