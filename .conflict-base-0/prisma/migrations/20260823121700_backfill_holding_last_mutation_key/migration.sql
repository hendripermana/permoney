-- PER-259 Slice 5 follow-up — backfill `Holding.lastMutationIdempotencyKey`
-- for every row that predates the column (holdings mutated only by trades
-- recorded before migration 20260816130000 shipped, 2026-08-23).
--
-- BUG THIS FIXES (found in production 2026-08-24 via a real trade): the
-- migration comment for the original column said a NULL marker means
-- "not known to be the result of a still-latest tracked mutation," treating
-- NULL as fail-safe. That was wrong for a legacy holding whose last
-- quantity-mutating event genuinely IS still the most recent one — with no
-- backfill, `assertTradeIsLatest`'s fast path
-- (current.lastMutationIdempotencyKey === tradeKey) always fails for ANY
-- trade recorded before this migration, permanently blocking edit/delete on
-- it even though nothing has touched the position since. Compounding this,
-- a price-only refresh (`refreshHoldingPricesForFamily`) also leaves the
-- marker untouched (it only ever writes `lastPriceMinor`), so a legacy
-- holding stays NULL indefinitely even after later activity that isn't a
-- quantity change.
--
-- This is a one-time DATA backfill, not a schema change: for each Holding
-- with a NULL marker, find its most recent AuditLog entry that actually
-- changed quantity or avgUnitCostMinor (or was the holding's own create),
-- and stamp that entry's idempotencyKey. A price-only update (quantity and
-- avgUnitCostMinor unchanged) is correctly skipped by the comparison, so the
-- walk falls through to the real last quantity-mutating event. Going
-- forward all four write sites (Buy/Sell, both Switch legs, Dividend
-- reinvest) already stamp the marker themselves, so no NULL should recur
-- for a genuinely-latest holding after this backfill runs.

WITH latest_quantity_mutation AS (
  SELECT DISTINCT ON (al."entityId")
    al."entityId" AS holding_id,
    al."idempotencyKey" AS marker
  FROM "AuditLog" al
  WHERE al."entityType" = 'Holding'
    AND al."idempotencyKey" IS NOT NULL
    AND (
      al.action = 'create'
      OR (al."beforeJson" ->> 'quantity') IS DISTINCT FROM (al."afterJson" ->> 'quantity')
      OR (al."beforeJson" ->> 'avgUnitCostMinor') IS DISTINCT FROM (al."afterJson" ->> 'avgUnitCostMinor')
    )
  ORDER BY al."entityId", al."createdAt" DESC, al.id DESC
)
UPDATE "Holding" h
SET "lastMutationIdempotencyKey" = lm.marker
FROM latest_quantity_mutation lm
WHERE h.id = lm.holding_id
  AND h."lastMutationIdempotencyKey" IS NULL;
