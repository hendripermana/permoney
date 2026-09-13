-- PER-196 / ADR-0048 §4: transfer_tenant_isolation (PER-181's correlated-EXISTS
-- fix) checked only outflowTransactionId, matching the old always-both-legs
-- schema. A valuation-linked transfer (20260720130000) can have
-- outflowTransactionId NULL (redemption: only inflowTransactionId is set) —
-- "Transaction"."id" = NULL never matches, so RLS silently rejected every
-- redemption-direction Transfer row. Fixed by OR-ing a second correlated
-- EXISTS against inflowTransactionId: every Transfer shape (classic dual-leg,
-- valuation-linked contribution, valuation-linked redemption) always has AT
-- LEAST one non-null Transaction leg with the correct familyId, so this
-- covers all three without reintroducing PER-181's O(n) IN-subquery
-- regression — both EXISTS clauses remain correlated on Transaction's primary
-- key, so each is an O(log n) index scan regardless of family size.

DROP POLICY IF EXISTS transfer_tenant_isolation ON "Transfer";
CREATE POLICY transfer_tenant_isolation ON "Transfer"
  FOR ALL
  USING (
    (
      EXISTS (
        SELECT 1 FROM "Transaction"
        WHERE "Transaction"."id" = "Transfer"."outflowTransactionId"
          AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
      )
      OR EXISTS (
        SELECT 1 FROM "Transaction"
        WHERE "Transaction"."id" = "Transfer"."inflowTransactionId"
          AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
      )
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  )
  WITH CHECK (
    (
      EXISTS (
        SELECT 1 FROM "Transaction"
        WHERE "Transaction"."id" = "Transfer"."outflowTransactionId"
          AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
      )
      OR EXISTS (
        SELECT 1 FROM "Transaction"
        WHERE "Transaction"."id" = "Transfer"."inflowTransactionId"
          AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
      )
    )
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id', true)::text
    )
  );
