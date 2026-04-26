-- =============================================================================
-- Migration: Float → BigInt minor units for monetary fields
-- See docs/adr/0001-money-type-migration.md
-- =============================================================================
--
-- Affected fields:
--   Account.balance               REAL → INTEGER (BigInt)
--   Transaction.amount            REAL → INTEGER (BigInt)
--   Transaction.destinationAmount REAL → INTEGER (BigInt)
--   Transaction.accountBalanceAfter REAL → INTEGER (BigInt)
--   SplitEntry.amount             REAL → INTEGER (BigInt)
--
-- Backfill: rows are converted to minor units using a CASE expression keyed
-- on the row's `currency` column. The CASE covers all per-currency scales
-- present in src/lib/data/currencies.ts (179 currencies):
--
--   minor_unit_conversion = 1     (29 currencies, JPY-like + metals)
--   minor_unit_conversion = 5     (2 — MGA, MRU)
--   minor_unit_conversion = 100   (139 — default; covers IDR, USD, EUR…)
--   minor_unit_conversion = 1000  (7 — Middle East: BHD, IQD, JOD, KWD, LYD, OMR, TND)
--   minor_unit_conversion = 10000 (1 — CLF)
--   minor_unit_conversion = 10^8  (1 — BTC)
--
-- The default branch (ELSE 100) catches any row whose currency is not in the
-- known list — safe for the dominant 2-decimal case. If you need to support
-- a currency outside this set in production, add it to the CASE before
-- deploying.
--
-- ROUND() is applied so that floats like 1500000.000001 (subtly polluted by
-- prior IEEE 754 noise) collapse to the nearest minor unit instead of
-- truncating downward.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- -----------------------------------------------------------------------------
-- Account
-- -----------------------------------------------------------------------------
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "balance" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "color" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "familyId" TEXT NOT NULL,
    CONSTRAINT "Account_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Account" ("id", "name", "type", "balance", "currency", "color", "status", "familyId")
SELECT
    "id",
    "name",
    "type",
    CAST(ROUND("balance" * (CASE "currency"
        WHEN 'JPY' THEN 1 WHEN 'BYR' THEN 1 WHEN 'BIF' THEN 1 WHEN 'CLP' THEN 1 WHEN 'DJF' THEN 1
        WHEN 'GBX' THEN 1 WHEN 'GNF' THEN 1 WHEN 'HUF' THEN 1 WHEN 'ISK' THEN 1 WHEN 'KMF' THEN 1
        WHEN 'KRW' THEN 1 WHEN 'PYG' THEN 1 WHEN 'RWF' THEN 1 WHEN 'UGX' THEN 1 WHEN 'VND' THEN 1
        WHEN 'VUV' THEN 1 WHEN 'XAF' THEN 1 WHEN 'XAG' THEN 1 WHEN 'XAU' THEN 1 WHEN 'XBA' THEN 1
        WHEN 'XBB' THEN 1 WHEN 'XBC' THEN 1 WHEN 'XBD' THEN 1 WHEN 'XDR' THEN 1 WHEN 'XOF' THEN 1
        WHEN 'XPD' THEN 1 WHEN 'XPF' THEN 1 WHEN 'XPT' THEN 1 WHEN 'XTS' THEN 1
        WHEN 'MGA' THEN 5 WHEN 'MRU' THEN 5
        WHEN 'BHD' THEN 1000 WHEN 'IQD' THEN 1000 WHEN 'JOD' THEN 1000 WHEN 'KWD' THEN 1000
        WHEN 'LYD' THEN 1000 WHEN 'OMR' THEN 1000 WHEN 'TND' THEN 1000
        WHEN 'CLF' THEN 10000
        WHEN 'BTC' THEN 100000000
        ELSE 100
    END)) AS INTEGER),
    "currency",
    "color",
    "status",
    "familyId"
FROM "Account";

DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";

-- -----------------------------------------------------------------------------
-- Transaction
-- -----------------------------------------------------------------------------
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'standard',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "status" TEXT NOT NULL DEFAULT 'CLEARED',
    "destinationAmount" BIGINT,
    "destinationCurrency" TEXT,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "notes" TEXT,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "accountBalanceAfter" BIGINT,
    "attachmentUrl" TEXT,
    "deletedAt" DATETIME,
    "merchantId" TEXT,
    "accountId" TEXT NOT NULL,
    "toAccountId" TEXT,
    "categoryId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isSplit" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Transaction" (
    "id", "amount", "type", "kind", "currency", "status",
    "destinationAmount", "destinationCurrency",
    "date", "description", "notes", "excluded",
    "accountBalanceAfter", "attachmentUrl", "deletedAt",
    "merchantId", "accountId", "toAccountId", "categoryId", "userId",
    "createdAt", "updatedAt", "isSplit"
)
SELECT
    "id",
    -- amount uses parent currency
    CAST(ROUND("amount" * (CASE "currency"
        WHEN 'JPY' THEN 1 WHEN 'BYR' THEN 1 WHEN 'BIF' THEN 1 WHEN 'CLP' THEN 1 WHEN 'DJF' THEN 1
        WHEN 'GBX' THEN 1 WHEN 'GNF' THEN 1 WHEN 'HUF' THEN 1 WHEN 'ISK' THEN 1 WHEN 'KMF' THEN 1
        WHEN 'KRW' THEN 1 WHEN 'PYG' THEN 1 WHEN 'RWF' THEN 1 WHEN 'UGX' THEN 1 WHEN 'VND' THEN 1
        WHEN 'VUV' THEN 1 WHEN 'XAF' THEN 1 WHEN 'XAG' THEN 1 WHEN 'XAU' THEN 1 WHEN 'XBA' THEN 1
        WHEN 'XBB' THEN 1 WHEN 'XBC' THEN 1 WHEN 'XBD' THEN 1 WHEN 'XDR' THEN 1 WHEN 'XOF' THEN 1
        WHEN 'XPD' THEN 1 WHEN 'XPF' THEN 1 WHEN 'XPT' THEN 1 WHEN 'XTS' THEN 1
        WHEN 'MGA' THEN 5 WHEN 'MRU' THEN 5
        WHEN 'BHD' THEN 1000 WHEN 'IQD' THEN 1000 WHEN 'JOD' THEN 1000 WHEN 'KWD' THEN 1000
        WHEN 'LYD' THEN 1000 WHEN 'OMR' THEN 1000 WHEN 'TND' THEN 1000
        WHEN 'CLF' THEN 10000
        WHEN 'BTC' THEN 100000000
        ELSE 100
    END)) AS INTEGER),
    "type", "kind", "currency", "status",
    -- destinationAmount uses destinationCurrency (NULL if absent)
    CASE WHEN "destinationAmount" IS NULL THEN NULL ELSE
        CAST(ROUND("destinationAmount" * (CASE "destinationCurrency"
            WHEN 'JPY' THEN 1 WHEN 'BYR' THEN 1 WHEN 'BIF' THEN 1 WHEN 'CLP' THEN 1 WHEN 'DJF' THEN 1
            WHEN 'GBX' THEN 1 WHEN 'GNF' THEN 1 WHEN 'HUF' THEN 1 WHEN 'ISK' THEN 1 WHEN 'KMF' THEN 1
            WHEN 'KRW' THEN 1 WHEN 'PYG' THEN 1 WHEN 'RWF' THEN 1 WHEN 'UGX' THEN 1 WHEN 'VND' THEN 1
            WHEN 'VUV' THEN 1 WHEN 'XAF' THEN 1 WHEN 'XAG' THEN 1 WHEN 'XAU' THEN 1 WHEN 'XBA' THEN 1
            WHEN 'XBB' THEN 1 WHEN 'XBC' THEN 1 WHEN 'XBD' THEN 1 WHEN 'XDR' THEN 1 WHEN 'XOF' THEN 1
            WHEN 'XPD' THEN 1 WHEN 'XPF' THEN 1 WHEN 'XPT' THEN 1 WHEN 'XTS' THEN 1
            WHEN 'MGA' THEN 5 WHEN 'MRU' THEN 5
            WHEN 'BHD' THEN 1000 WHEN 'IQD' THEN 1000 WHEN 'JOD' THEN 1000 WHEN 'KWD' THEN 1000
            WHEN 'LYD' THEN 1000 WHEN 'OMR' THEN 1000 WHEN 'TND' THEN 1000
            WHEN 'CLF' THEN 10000
            WHEN 'BTC' THEN 100000000
            ELSE 100
        END)) AS INTEGER)
    END,
    "destinationCurrency",
    "date", "description", "notes", "excluded",
    -- accountBalanceAfter uses parent currency (same scale as amount)
    CASE WHEN "accountBalanceAfter" IS NULL THEN NULL ELSE
        CAST(ROUND("accountBalanceAfter" * (CASE "currency"
            WHEN 'JPY' THEN 1 WHEN 'BYR' THEN 1 WHEN 'BIF' THEN 1 WHEN 'CLP' THEN 1 WHEN 'DJF' THEN 1
            WHEN 'GBX' THEN 1 WHEN 'GNF' THEN 1 WHEN 'HUF' THEN 1 WHEN 'ISK' THEN 1 WHEN 'KMF' THEN 1
            WHEN 'KRW' THEN 1 WHEN 'PYG' THEN 1 WHEN 'RWF' THEN 1 WHEN 'UGX' THEN 1 WHEN 'VND' THEN 1
            WHEN 'VUV' THEN 1 WHEN 'XAF' THEN 1 WHEN 'XAG' THEN 1 WHEN 'XAU' THEN 1 WHEN 'XBA' THEN 1
            WHEN 'XBB' THEN 1 WHEN 'XBC' THEN 1 WHEN 'XBD' THEN 1 WHEN 'XDR' THEN 1 WHEN 'XOF' THEN 1
            WHEN 'XPD' THEN 1 WHEN 'XPF' THEN 1 WHEN 'XPT' THEN 1 WHEN 'XTS' THEN 1
            WHEN 'MGA' THEN 5 WHEN 'MRU' THEN 5
            WHEN 'BHD' THEN 1000 WHEN 'IQD' THEN 1000 WHEN 'JOD' THEN 1000 WHEN 'KWD' THEN 1000
            WHEN 'LYD' THEN 1000 WHEN 'OMR' THEN 1000 WHEN 'TND' THEN 1000
            WHEN 'CLF' THEN 10000
            WHEN 'BTC' THEN 100000000
            ELSE 100
        END)) AS INTEGER)
    END,
    "attachmentUrl", "deletedAt",
    "merchantId", "accountId", "toAccountId", "categoryId", "userId",
    "createdAt", "updatedAt", "isSplit"
FROM "Transaction";

DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";

-- -----------------------------------------------------------------------------
-- SplitEntry — uses the parent transaction's currency for scale.
-- -----------------------------------------------------------------------------
CREATE TABLE "new_SplitEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "categoryId" TEXT,
    "merchantId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SplitEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SplitEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SplitEntry_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_SplitEntry" ("id", "description", "amount", "transactionId", "categoryId", "merchantId", "createdAt")
SELECT
    se."id",
    se."description",
    CAST(ROUND(se."amount" * (CASE t."currency"
        WHEN 'JPY' THEN 1 WHEN 'BYR' THEN 1 WHEN 'BIF' THEN 1 WHEN 'CLP' THEN 1 WHEN 'DJF' THEN 1
        WHEN 'GBX' THEN 1 WHEN 'GNF' THEN 1 WHEN 'HUF' THEN 1 WHEN 'ISK' THEN 1 WHEN 'KMF' THEN 1
        WHEN 'KRW' THEN 1 WHEN 'PYG' THEN 1 WHEN 'RWF' THEN 1 WHEN 'UGX' THEN 1 WHEN 'VND' THEN 1
        WHEN 'VUV' THEN 1 WHEN 'XAF' THEN 1 WHEN 'XAG' THEN 1 WHEN 'XAU' THEN 1 WHEN 'XBA' THEN 1
        WHEN 'XBB' THEN 1 WHEN 'XBC' THEN 1 WHEN 'XBD' THEN 1 WHEN 'XDR' THEN 1 WHEN 'XOF' THEN 1
        WHEN 'XPD' THEN 1 WHEN 'XPF' THEN 1 WHEN 'XPT' THEN 1 WHEN 'XTS' THEN 1
        WHEN 'MGA' THEN 5 WHEN 'MRU' THEN 5
        WHEN 'BHD' THEN 1000 WHEN 'IQD' THEN 1000 WHEN 'JOD' THEN 1000 WHEN 'KWD' THEN 1000
        WHEN 'LYD' THEN 1000 WHEN 'OMR' THEN 1000 WHEN 'TND' THEN 1000
        WHEN 'CLF' THEN 10000
        WHEN 'BTC' THEN 100000000
        ELSE 100
    END)) AS INTEGER),
    se."transactionId",
    se."categoryId",
    se."merchantId",
    se."createdAt"
FROM "SplitEntry" se
INNER JOIN "Transaction" t ON t."id" = se."transactionId";

DROP TABLE "SplitEntry";
ALTER TABLE "new_SplitEntry" RENAME TO "SplitEntry";

-- -----------------------------------------------------------------------------
-- Recreate indexes that lived on the old tables.
-- -----------------------------------------------------------------------------
-- (None of the old monetary-affected tables had indexes besides PK + FK
--  constraints, which are recreated by the CREATE TABLE statements above.)

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
