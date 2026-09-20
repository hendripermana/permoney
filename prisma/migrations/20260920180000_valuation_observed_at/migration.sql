-- ADR-0043 amendment (2026-09-20) — `Valuation.observedAt`.
--
-- A `ground_truth` anchor asserts what a human (or, later, a bank statement)
-- observed. `valuationDate` records only the CALENDAR DAY of that observation
-- (`@db.Date`, midnight), so the shared `afterAnchor` predicate
-- (`t.date > valuationDate`) treated EVERY same-day transaction as "after" the
-- observation — including one logged at 12:00 and reconciled at 14:00, which
-- the reconcile's asserted number already contains. It was counted twice.
--
-- `observedAt` records WHEN, within its day, the observation happened. The
-- application writes it (= the row's createdAt instant, one source of truth)
-- only for a `ground_truth` anchor whose valuationDate is the same UTC calendar
-- day as the write. The predicate becomes
--   t.date > COALESCE("observedAt", "valuationDate")
-- for ground_truth anchors; `derived` anchors and every pre-existing row are
-- unchanged (see below).
--
-- ADDITIVE and DEPLOY-SAFE: a nullable column, NO backfill, NO UPDATE. Every
-- existing row keeps observedAt = NULL and therefore the exact legacy
-- segmentation — no production balance or drift report moves on deploy.

-- TIMESTAMP(3), not TIMESTAMPTZ: this is Prisma's mapping for every DateTime in
-- the schema (values are UTC instants), and `Transaction.date` / `createdAt`,
-- which this column is compared against, are the same type.
ALTER TABLE "Valuation" ADD COLUMN "observedAt" TIMESTAMP(3);

-- Database is the law: the column is meaningful only on a ground_truth anchor,
-- and only on the UTC calendar day it was observed. Anything else would either
-- be silently ignored (derived / market) or would order an anchor by one day
-- and segment it by another. A NULL observedAt is always valid (legacy /
-- back-dated / derived rows).
ALTER TABLE "Valuation"
  ADD CONSTRAINT "valuation_observed_at_domain"
  CHECK (
    "observedAt" IS NULL
    OR (
      "provenance" = 'ground_truth'
      AND "observedAt"::date = "valuationDate"
    )
  );
