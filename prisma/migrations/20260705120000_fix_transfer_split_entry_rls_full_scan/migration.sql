-- PER-181: `Transfer` and `SplitEntry` have no `familyId` column of their own
-- (ADR-0036 §4 describes the general `"familyId" = GUC` guard, but these two
-- tables are scoped indirectly through their parent `Transaction`). The
-- original `20260620044436_family_membership` migration expressed that
-- indirection as a NON-correlated `IN (subquery)`:
--
--   "outflowTransactionId" IN (SELECT id FROM "Transaction" WHERE "familyId" = ...)
--
-- Postgres cannot decorrelate this: it plans it as a hashed SubPlan that
-- materializes EVERY "Transaction" row belonging to the family, on every
-- single `Transfer`/`SplitEntry` SELECT or INSERT — cost grows linearly with
-- the family's total transaction count, regardless of indexes, because the
-- subquery result doesn't depend on the outer row at all.
--
-- Proven via EXPLAIN ANALYZE against a real-shape populated bundle:
--   493 existing transactions   -> subplan rows=493,  query total  28.6ms
--   1493 existing transactions  -> subplan rows=1493, query total  86.2ms
-- (~0.058ms per existing family transaction, confirmed independent of
-- SERIALIZABLE vs ReadCommitted isolation — this is a planner/plan-shape
-- cost, not a concurrency/retry cost). This made
-- `pairAndPromoteSureTransfers`'s per-pair transfer promotion (which reads
-- and writes `Transfer` once per pair while the family's `Transaction` table
-- is simultaneously growing) cost O(pairs^2) in total, matching the measured
-- 222ms/pair @75 pairs -> 400-578ms/pair @225 pairs -> DNF @~450 pairs cliff.
--
-- Fix: rewrite both predicates as a CORRELATED `EXISTS`, anchored on
-- "Transaction".id (its primary key). Postgres cannot hash-materialize a
-- correlated subplan — it evaluates a per-outer-row Index Scan on
-- Transaction_pkey instead, which is O(log n) regardless of how large the
-- family's ledger is. Semantics are unchanged (same two columns checked, same
-- membership guard) — only the query shape changes. See ADR-0044 §6 (the
-- measurement-gate this ticket closes) and ADR-0036 §4 (amended alongside).

DROP POLICY IF EXISTS split_entry_tenant_isolation ON "SplitEntry";
CREATE POLICY split_entry_tenant_isolation ON "SplitEntry"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "Transaction"
      WHERE "Transaction"."id" = "SplitEntry"."transactionId"
        AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Transaction"
      WHERE "Transaction"."id" = "SplitEntry"."transactionId"
        AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );

DROP POLICY IF EXISTS transfer_tenant_isolation ON "Transfer";
CREATE POLICY transfer_tenant_isolation ON "Transfer"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "Transaction"
      WHERE "Transaction"."id" = "Transfer"."outflowTransactionId"
        AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Transaction"
      WHERE "Transaction"."id" = "Transfer"."outflowTransactionId"
        AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );
