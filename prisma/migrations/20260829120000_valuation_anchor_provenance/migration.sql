-- PER-264 / PER-265 — ADR-0043 "Amendment — anchor provenance: ground-truth vs
-- derived". Records WHERE an anchor valuation's asserted value came from, so the
-- one shared `afterAnchor` segmentation predicate can treat the two kinds
-- differently:
--
--   ground_truth — an INDEPENDENT observation of reality (a human's live
--     "Reconcile account" tap against their real wallet, a user-entered opening
--     balance, and later a bank-fetched statement balance). It already reflects
--     every event up to that moment, known to Permoney or not, so post-anchor
--     flow is segmented by DATE ONLY: a transaction dated at/before the anchor
--     is absorbed and never re-counted, no matter when it is entered.
--
--   derived — a value COMPUTED by summing ledger rows Permoney already held
--     when the anchor was written (the Sure migration's reconciliation anchors,
--     the Σ(units × price) holdings anchor, the balance-preserving seed anchor
--     written when an account flips to holdings tracking). Keeps PER-201's
--     date-OR-createdAt disjunction unchanged, which is what makes a fresh Sure
--     import stay zero-drift.
--
-- `market` valuations are observations, never anchors (ADR-0043 §1), so they
-- carry NULL — the CHECK below makes "is an anchor" and "has a provenance"
-- exactly the same predicate at the database level.

ALTER TABLE "Valuation" ADD COLUMN "provenance" TEXT;

-- Backfill (ADR-0043 amendment, "Backfilling existing rows"). Two
-- already-present discriminators on the row, in priority order:
--
--   `source = 'migration:sure'` -> derived. Both Sure anchor writers stamp it
--   at write time; the value came out of another ledger's computation over the
--   very rows the import promoted.
--
--   `type = 'opening'` -> derived, ALWAYS (ADR-0043 amendment, "Scope narrowed
--   2026-08-29"). An opening balance reads like a live observation, and the
--   amendment's first draft classified it ground_truth for that reason. But the
--   row is stamped `valuationDate = <account creation day>`, not a date the
--   user chose as "track me from here", so date-only exclusion silently
--   swallows every transaction dated before setup — i.e. ordinary post-setup
--   backfilling and CSV import. Implementation proved the blast radius: nine
--   real-Postgres failures across five unrelated suites (transfer-purpose-fee,
--   fx-currency, distributions, net-worth-series, sure-migration). PER-264's
--   proven bug was a deliberate reconcile followed WEEKS later by an unrelated
--   backfill — a different scenario. Keeping `opening` on PER-201's unchanged
--   `derived` branch scopes this fix to exactly the bug that was diagnosed.
--
--   Everything else -> ground_truth. In practice that is every row written by
--   the interactive "Reconcile account" action, present and historical. It is
--   the deliberately safe default: wrongly calling a derived row ground_truth
--   merely stops it absorbing a late import correction, while the reverse
--   re-opens the silent double-count this amendment exists to close.
--
-- Two live write sites are explicit exceptions the application code declares
-- for itself rather than inheriting from this heuristic (see PER-266):
-- `src/server/accounts.ts`'s holdings-tracking-enable seed anchor and
-- `src/server/holdings.ts`'s Σ-holdings anchor both carry a non-Sure `source`
-- and a non-`opening` type, yet are computed from Permoney's own rows, so they
-- pass provenance="derived" explicitly. Historically both only ever land on
-- balanceSource='valuation' accounts, where this predicate is never evaluated,
-- so backfilling them as ground_truth here changes no balance.
--
-- Verified against a scratch database seeded with one legacy row per historical
-- write path before this migration ran: opening -> derived, manual/interactive
-- reconciliation -> ground_truth, migration:sure -> derived (soft-deleted rows
-- included, so an un-delete stays correctly classified), market -> NULL.

UPDATE "Valuation"
SET "provenance" = CASE
  WHEN "source" = 'migration:sure' THEN 'derived'
  WHEN "type" = 'opening' THEN 'derived'
  ELSE 'ground_truth'
END
WHERE "type" <> 'market';

-- Database is the law: an anchor-type row must carry a provenance from the
-- closed domain; a market observation must not carry one at all.
--
-- Written as a CASE, deliberately. The obvious spelling —
--   ("type" = 'market' AND "provenance" IS NULL)
--   OR ("type" <> 'market' AND "provenance" IN ('ground_truth','derived'))
-- is WRONG: for an anchor row with a NULL provenance the second disjunct is
-- `TRUE AND NULL` = NULL, the whole expression is `FALSE OR NULL` = NULL, and a
-- CHECK constraint ACCEPTS a NULL result. That spelling would silently let
-- through the exact row this constraint exists to reject. The CASE below is
-- total: every branch yields TRUE or FALSE, never NULL.
ALTER TABLE "Valuation"
  ADD CONSTRAINT "valuation_provenance_domain"
  CHECK (
    CASE
      WHEN "type" = 'market' THEN "provenance" IS NULL
      ELSE "provenance" IS NOT NULL
           AND "provenance" IN ('ground_truth', 'derived')
    END
  );
