-- CreateTable
CREATE TABLE "Valuation" (
    "id" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "valuationDate" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "normalBalance" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,

    CONSTRAINT "Valuation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Valuation_familyId_accountId_valuationDate_idx" ON "Valuation"("familyId", "accountId", "valuationDate" DESC);

-- CreateIndex
CREATE INDEX "Valuation_familyId_accountId_type_idx" ON "Valuation"("familyId", "accountId", "type");

-- AddForeignKey
ALTER TABLE "Valuation" ADD CONSTRAINT "valuation_currency_is_iso_4217" FOREIGN KEY ("currency") REFERENCES "iso_4217_currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Valuation" ADD CONSTRAINT "Valuation_accountId_familyId_fkey" FOREIGN KEY ("accountId", "familyId") REFERENCES "Account"("id", "familyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Valuation" ADD CONSTRAINT "Valuation_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- PER-146 / ADR-0034 — Valuation primitive: domain CHECKs, sign rule, the
-- single-opening-anchor invariant, RLS tenant isolation, the existing-account
-- backfill, and the balance_adjustment transaction kind used to post cash
-- reconciliation corrections into the ledger.
-- ============================================================================

-- Domain CHECKs ---------------------------------------------------------------

ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_type_domain CHECK (
    "type" IN ('opening', 'reconciliation', 'market', 'manual')
  );

ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_normal_balance_domain CHECK (
    "normalBalance" IN ('POSITIVE', 'NEGATIVE')
  );

-- Currency shape, matching iso_4217_currency_code_shape on the registry so the
-- CHECK can never contradict the foreign key (which already enforces membership).
ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_currency_shape CHECK ("currency" ~ '^[A-Z]{3,5}$');

-- Value sign rule. A table CHECK cannot join to Account.accountClass, so the
-- normal-balance discriminator is denormalized at write time and validated
-- here. This is exactly equivalent to the account_normal_balance_sign rule
-- (_per73_account_balance_sign_is_valid): ASSET/TRACKED_ASSET (POSITIVE) >= 0,
-- LIABILITY (NEGATIVE) <= 0. Zero is valid for either. See ADR-0034 §9.
ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_value_sign CHECK (
    ("normalBalance" = 'POSITIVE' AND "value" >= 0)
    OR ("normalBalance" = 'NEGATIVE' AND "value" <= 0)
  );

-- Exactly one live opening valuation per account: the rebuild anchor (ADR-0034
-- §3/§4). Partial unique index so soft-deleted openings never block a re-open.
CREATE UNIQUE INDEX "valuation_one_opening_per_account"
  ON "Valuation"("accountId")
  WHERE "type" = 'opening' AND "deletedAt" IS NULL;

-- Backfill: synthesize one opening anchor per existing non-deleted account so
-- rebuild is a provable no-op (ADR-0034 §10). The anchor is the PRE-transaction
-- baseline, not the current balance: each Transaction.amount is the signed delta
-- to its own accountId (transfers post a separate inflow row on the destination
-- account), so the account's transaction flow is SUM(amount) over its rows, and
-- the opening value that reproduces the current balance is
-- balance - SUM(flow). Cash rebuild is then opening.value + SUM(flow) = balance;
-- tracked accounts have no transactions, so opening.value = balance. The sign is
-- valid by construction (it equals the account's original signed opening, which
-- the account_normal_balance_sign rule already guarantees). Runs BEFORE RLS is
-- enabled on Valuation; migrations apply via the admin/superuser connection (see
-- docs/testing.md), so the SELECT over Account sees every tenant row, and
-- familyId is carried from the joined account so tenant ownership holds.
INSERT INTO "Valuation" (
  "id", "value", "currency", "valuationDate", "type", "source",
  "normalBalance", "createdById", "accountId", "familyId"
)
SELECT
  gen_random_uuid()::text,
  a."balance" - COALESCE((
    SELECT SUM(t."amount")
    FROM "Transaction" t
    WHERE t."accountId" = a."id" AND t."deletedAt" IS NULL
  ), 0),
  a."currency",
  COALESCE((
    SELECT MIN(t."date")
    FROM "Transaction" t
    WHERE t."accountId" = a."id" AND t."deletedAt" IS NULL
  )::date, CURRENT_DATE),
  'opening',
  'backfill',
  CASE WHEN a."accountClass" = 'LIABILITY' THEN 'NEGATIVE' ELSE 'POSITIVE' END,
  'system-backfill',
  a."id",
  a."familyId"
FROM "Account" a;

-- Row-Level Security: tenant isolation, mirroring Account/Transaction.
ALTER TABLE "Valuation" ENABLE ROW LEVEL SECURITY;

CREATE POLICY valuation_tenant_isolation ON "Valuation"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "Valuation" FORCE ROW LEVEL SECURITY;

-- balance_adjustment transaction kind: the explicit, audited ledger correction
-- posted when a cash reconciliation valuation reveals drift (ADR-0034 §4). It is
-- an ordinary income (positive top-up) or expense (negative draw-down) row, never
-- a transfer, so it stays out of the transfer/liability kind triggers.
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
      'liability_fee',
      'balance_adjustment'
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
        'balance_adjustment'
      ))
    OR ("type" = 'income' AND kind IN ('standard', 'balance_adjustment'))
  );
