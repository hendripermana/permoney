-- ============================================================================
-- PER-199 — Per-transaction cross-batch import idempotency.
--
-- Additive + backward-compatible. `Transaction` gains the same durable
-- external-provider binding already used by Account/Category/Merchant
-- (PER-170 / ADR-0041 §3), so a re-imported Sure transaction can be
-- recognized as already-canonical by (familyId, externalProvider, externalId)
-- instead of only by whole-bundle contentHash. New columns are nullable, so
-- existing (manual and manually-imported CSV) rows are untouched — they stay
-- externalProvider = NULL and are exempt from the partial unique below.
-- ============================================================================

ALTER TABLE "Transaction"
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalId" TEXT;

-- Partial UNIQUE (WHERE externalProvider IS NOT NULL): Postgres treats NULLs
-- as DISTINCT by default, so manual/CSV rows (externalProvider = NULL) are
-- already unique under any composite index — the predicate keeps the index
-- small (provider-bound rows only) and makes the binding uniqueness an
-- EXPLICIT, import-only invariant, mirroring account_provider_binding /
-- category_provider_binding / merchant_provider_binding exactly.
--
-- Deliberately NOT scoped by deletedAt: a soft-deleted transaction's
-- externalId identity must still block a duplicate live re-promotion of the
-- same provider row (ADD-ONLY means "never re-create", not "re-create once
-- the old one is deleted"). The app-layer dedup check (loadCanonicalDedupIndex,
-- src/server/imports.ts) mirrors this exactly: its externalId lookup is also
-- NOT deletedAt-scoped, so an imported-then-deleted row still counts as a
-- duplicate and skips re-promotion — it never inserts a second row that would
-- collide with this index.
CREATE UNIQUE INDEX "transaction_provider_binding"
  ON "Transaction" ("familyId", "externalProvider", "externalId")
  WHERE "externalProvider" IS NOT NULL;
