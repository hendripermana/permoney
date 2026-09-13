-- ADR-0056 — Zakat Maal calculator.
--
-- Two new tenant-scoped tables (ZakatSettings, ZakatPayer) plus three
-- nullable, additive columns on Account. Additive-only: every existing
-- Account row starts fully untagged (NULL, NULL, NULL), which is the correct
-- historical default — a family with zero or one ZakatPayer needs no
-- tagging at all (see ADR-0056 "Default-behavior rule"), so nothing here
-- changes any existing balance, ledger, or net-worth computation.
--
-- RLS uses the ADR-0036 membership guard (app_is_active_member), the
-- current-best-practice policy shape for a newly added tenant table (mirrors
-- Tag/TransactionTag in migration `20260906120000_tags`).

-- 1. ZakatSettings --------------------------------------------------------

CREATE TABLE "ZakatSettings" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "nisabBasis" TEXT NOT NULL DEFAULT 'gold',
    "haulRule" TEXT NOT NULL DEFAULT 'jumhur_continuous',
    "hawlStartDate" TIMESTAMP(3),

    CONSTRAINT "ZakatSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZakatSettings_familyId_key" ON "ZakatSettings"("familyId");

ALTER TABLE "ZakatSettings" ADD CONSTRAINT "ZakatSettings_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Methodology settings are configurable, never silently defaulted to a
-- single madhab (ADR-0056 "Research summary" — real, documented scholarly
-- disagreement on both of these). Domain-constrained by a CHECK so a raw
-- write can never persist a third, unhandled value.
ALTER TABLE "ZakatSettings" ADD CONSTRAINT "zakat_settings_nisab_basis_domain" CHECK (
  "nisabBasis" IN ('gold', 'silver')
);
ALTER TABLE "ZakatSettings" ADD CONSTRAINT "zakat_settings_haul_rule_domain" CHECK (
  "haulRule" IN ('jumhur_continuous', 'hanafi_start_end')
);

ALTER TABLE "ZakatSettings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY zakat_settings_tenant_isolation ON "ZakatSettings"
  FOR ALL
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );
ALTER TABLE "ZakatSettings" FORCE ROW LEVEL SECURITY;

-- 2. ZakatPayer -------------------------------------------------------------
--
-- Deliberately NOT a FamilyMember, NOT a User — a lightweight domain fact
-- ("who does this account's wealth belong to") with zero auth implications,
-- so it can exist before the deferred multi-user invite/login flow. See
-- ADR-0056 "The real architectural gap".

CREATE TABLE "ZakatPayer" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "linkedUserId" TEXT,

    CONSTRAINT "ZakatPayer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZakatPayer_linkedUserId_key" ON "ZakatPayer"("linkedUserId");
CREATE INDEX "ZakatPayer_familyId_idx" ON "ZakatPayer"("familyId");

-- Composite-FK target for Account.zakatPayerId/zakatJointPayerId (ADR-0010
-- tenant-safe FK pattern, mirrors Merchant/Tag).
CREATE UNIQUE INDEX "ZakatPayer_id_familyId_key" ON "ZakatPayer"("id", "familyId");

ALTER TABLE "ZakatPayer" ADD CONSTRAINT "ZakatPayer_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- `linkedUserId` is a forward-compatible hook only (unused in Slice 1) — a
-- deleted User must not corrupt or cascade-delete the ZakatPayer row itself,
-- exactly like Transaction.reconciledById.
ALTER TABLE "ZakatPayer" ADD CONSTRAINT "ZakatPayer_linkedUserId_fkey"
  FOREIGN KEY ("linkedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ZakatPayer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY zakat_payer_tenant_isolation ON "ZakatPayer"
  FOR ALL
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );
ALTER TABLE "ZakatPayer" FORCE ROW LEVEL SECURITY;

-- 3. Account.zakatPayerId / zakatJointPayerId / zakatJointSharePercent ------
--
-- Nullable, additive, no backfill: NULL/NULL/NULL is the correct historical
-- state for every existing row (nothing was ever tagged before this existed).

ALTER TABLE "Account"
  ADD COLUMN "zakatPayerId" TEXT,
  ADD COLUMN "zakatJointPayerId" TEXT,
  ADD COLUMN "zakatJointSharePercent" INTEGER;

CREATE INDEX "Account_zakatPayerId_idx" ON "Account"("zakatPayerId");
CREATE INDEX "Account_zakatJointPayerId_idx" ON "Account"("zakatJointPayerId");

-- Tenant-safe composite FKs (Pattern A, ADR-0010) — an account can never be
-- tagged to another family's ZakatPayer even if an id is forged.
-- `onDelete: SET NULL` — deleting a ZakatPayer un-tags the account; it must
-- NEVER cascade-delete or otherwise touch ledger data (CLAUDE.md "No Hard
-- Delete for Ledger History"). Column-scoped `SET NULL (column)` (PG 15+,
-- this project runs 16) is REQUIRED here, not the bare `SET NULL` Prisma's
-- schema DSL would emit: a composite FK's plain `SET NULL` nulls EVERY
-- referencing column, including `familyId` — which is `NOT NULL` on
-- `Account` — and the delete would fail outright. Scoping to just the
-- Zakat-owner column is what actually implements "un-tag, don't touch
-- anything else" (found via a real Postgres 23502 failure while writing the
-- integration tests, not by inspection).
ALTER TABLE "Account" ADD CONSTRAINT "account_zakat_payer_fkey"
  FOREIGN KEY ("zakatPayerId", "familyId") REFERENCES "ZakatPayer"("id", "familyId")
  ON DELETE SET NULL ("zakatPayerId") ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "account_zakat_joint_payer_fkey"
  FOREIGN KEY ("zakatJointPayerId", "familyId") REFERENCES "ZakatPayer"("id", "familyId")
  ON DELETE SET NULL ("zakatJointPayerId") ON UPDATE CASCADE;

-- Invariant 1 — "set together" (mirrors transaction_reconciled_fields_together,
-- migration `20260912120000_transaction_reconciliation`): a joint co-owner
-- with no share percent (or vice versa) is a half-written, meaningless state.
ALTER TABLE "Account" ADD CONSTRAINT "account_zakat_joint_fields_together" CHECK (
  ("zakatJointPayerId" IS NULL) = ("zakatJointSharePercent" IS NULL)
);

-- Invariant 2 — a joint share is strictly BETWEEN 0 and 100: 0 or 100 is not
-- "joint", it is the primary payer holding the whole account (ADR-0056:
-- "the joint payer's share (1-99; the primary zakatPayerId holder keeps the
-- remainder)").
ALTER TABLE "Account" ADD CONSTRAINT "account_zakat_joint_share_percent_range" CHECK (
  "zakatJointSharePercent" IS NULL
  OR ("zakatJointSharePercent" BETWEEN 1 AND 99)
);

-- Invariant 3 — an account cannot be jointly owned by the same payer as
-- themselves.
ALTER TABLE "Account" ADD CONSTRAINT "account_zakat_distinct_payers" CHECK (
  "zakatPayerId" IS NULL
  OR "zakatJointPayerId" IS NULL
  OR "zakatPayerId" <> "zakatJointPayerId"
);
