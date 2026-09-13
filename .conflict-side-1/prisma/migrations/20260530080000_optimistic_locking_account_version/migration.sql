-- PER-18 / ADR-0013: optimistic locking for Account.balance.
--
-- Account.version is a monotonically increasing integer used by the
-- application-level balance helper. Every balance write updates by
-- (id, familyId, version), atomically changes balance, and increments version.
-- Serializable retry remains the broader cross-row protection.

-- ============================================================================
-- 1. Drift guard.
-- ============================================================================
-- The column is new, so there is no value-level repair to perform. The guard
-- still validates the Account table shape before adding optimistic locking:
-- duplicate (id, familyId) pairs would make a version predicate ambiguous, and
-- NULL balances would make retry-safe arithmetic impossible.
DO $$
DECLARE
  duplicate_account_family_pairs INT;
  null_balance_rows INT;
  version_column_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'Account'
       AND column_name = 'version'
  ) INTO version_column_exists;

  IF version_column_exists THEN
    RAISE EXCEPTION
      'PER-18 migration aborted: Account.version already exists. Manual schema reconciliation required before re-running.';
  END IF;

  SELECT COUNT(*)
    INTO duplicate_account_family_pairs
    FROM (
      SELECT id, "familyId", COUNT(*)
        FROM "Account"
       GROUP BY id, "familyId"
      HAVING COUNT(*) > 1
    ) drift;

  SELECT COUNT(*)
    INTO null_balance_rows
    FROM "Account"
   WHERE balance IS NULL;

  IF duplicate_account_family_pairs > 0 OR null_balance_rows > 0 THEN
    RAISE EXCEPTION
      'PER-18 migration aborted: % duplicate Account(id, familyId) pair(s), % Account row(s) with NULL balance. Manual reconciliation required before re-running.',
      duplicate_account_family_pairs,
      null_balance_rows;
  END IF;
END
$$;

-- ============================================================================
-- 2. Add optimistic-lock version column.
-- ============================================================================
ALTER TABLE "Account"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
