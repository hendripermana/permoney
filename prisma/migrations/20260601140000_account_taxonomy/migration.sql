-- PER-73: account class/type/subtype taxonomy and capability metadata.
--
-- `accountClass` controls normal-balance behaviour. `accountType` controls the
-- stable ledger capability family. `accountSubtype` is intentionally flexible
-- so new product families can be added without rewriting ledger semantics.

CREATE OR REPLACE FUNCTION _per73_account_class_for_type(account_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN account_type IN ('CREDIT', 'LOAN') THEN 'LIABILITY'
    WHEN account_type IN (
      'CASH',
      'DEPOSITORY',
      'E_WALLET',
      'INVESTMENT',
      'RECEIVABLE',
      'TRACKED_ASSET'
    ) THEN 'ASSET'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION _per73_default_account_subtype(account_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE account_type
    WHEN 'CASH' THEN 'cash'
    WHEN 'DEPOSITORY' THEN 'checking'
    WHEN 'E_WALLET' THEN 'cash'
    WHEN 'CREDIT' THEN 'credit_card'
    WHEN 'LOAN' THEN 'personal_loan'
    WHEN 'INVESTMENT' THEN 'brokerage'
    WHEN 'RECEIVABLE' THEN 'receivable'
    WHEN 'TRACKED_ASSET' THEN 'generic_asset'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION _per73_account_balance_sign_is_valid(
  account_class TEXT,
  balance BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE account_class
    WHEN 'ASSET' THEN balance >= 0
    WHEN 'LIABILITY' THEN balance <= 0
    ELSE false
  END
$$;

DO $$
DECLARE
  null_type_rows INT;
  invalid_type_rows INT;
  invalid_balance_rows INT;
BEGIN
  SELECT COUNT(*)
    INTO null_type_rows
    FROM "Account"
   WHERE "type" IS NULL;

  SELECT COUNT(*)
    INTO invalid_type_rows
    FROM "Account"
   WHERE _per73_account_class_for_type("type") IS NULL;

  SELECT COUNT(*)
    INTO invalid_balance_rows
    FROM "Account"
   WHERE NOT _per73_account_balance_sign_is_valid(
     _per73_account_class_for_type("type"),
     balance
   );

  IF null_type_rows > 0
     OR invalid_type_rows > 0
     OR invalid_balance_rows > 0 THEN
    RAISE EXCEPTION
      'PER-73 migration aborted: % null Account.type row(s), % invalid type row(s), % invalid balance sign row(s). Manual reconciliation required.',
      null_type_rows,
      invalid_type_rows,
      invalid_balance_rows
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE "Account"
  DROP CONSTRAINT IF EXISTS account_type_domain;

ALTER TABLE "Account"
  DROP CONSTRAINT IF EXISTS balance_nonneg_for_asset_accounts;

ALTER TABLE "Account"
  RENAME COLUMN "type" TO "accountType";

ALTER TABLE "Account"
  ADD COLUMN "accountClass" TEXT,
  ADD COLUMN "accountSubtype" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "institutionName" TEXT,
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalAccountId" TEXT,
  ADD COLUMN "mask" TEXT,
  ADD COLUMN "isImportable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "creditLimit" BIGINT,
  ADD COLUMN "statementDay" INTEGER,
  ADD COLUMN "dueDay" INTEGER,
  ADD COLUMN "interestRateBps" INTEGER;

UPDATE "Account"
   SET "accountClass" = _per73_account_class_for_type("accountType"),
       "accountSubtype" = _per73_default_account_subtype("accountType")
 WHERE "accountClass" IS NULL
    OR "accountSubtype" IS NULL;

ALTER TABLE "Account"
  ALTER COLUMN "accountClass" SET NOT NULL,
  ALTER COLUMN "accountSubtype" SET NOT NULL;

ALTER TABLE "Account"
  ADD CONSTRAINT account_class_domain CHECK (
    "accountClass" IN ('ASSET', 'LIABILITY')
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_type_domain CHECK (
    _per73_account_class_for_type("accountType") IS NOT NULL
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_type_class_consistency CHECK (
    _per73_account_class_for_type("accountType") = "accountClass"
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_normal_balance_sign CHECK (
    _per73_account_balance_sign_is_valid("accountClass", balance)
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_subtype_shape CHECK (
    "accountSubtype" ~ '^[a-z][a-z0-9_]{0,63}$'
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_statement_day_range CHECK (
    "statementDay" IS NULL OR "statementDay" BETWEEN 1 AND 31
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_due_day_range CHECK (
    "dueDay" IS NULL OR "dueDay" BETWEEN 1 AND 31
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_credit_limit_nonnegative CHECK (
    "creditLimit" IS NULL OR "creditLimit" >= 0
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_interest_rate_bps_nonnegative CHECK (
    "interestRateBps" IS NULL OR "interestRateBps" >= 0
  );

ALTER TABLE "Account"
  ADD CONSTRAINT account_archive_status_consistency CHECK (
    "archivedAt" IS NULL OR status = 'closed'
  );

CREATE INDEX "Account_familyId_accountClass_accountType_idx"
  ON "Account"("familyId", "accountClass", "accountType");

CREATE INDEX "Account_familyId_status_idx"
  ON "Account"("familyId", status);

CREATE INDEX "Account_familyId_externalProvider_externalAccountId_idx"
  ON "Account"("familyId", "externalProvider", "externalAccountId");
