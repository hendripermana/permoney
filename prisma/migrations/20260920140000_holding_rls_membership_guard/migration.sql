-- F1 audit finding "Security S1" (Phase 1 report, Department 6 — scrutineering):
-- `Instrument` and `Holding` were the only two of the 22 tenant-scoped tables
-- whose RLS policy omitted the ADR-0036 §4 membership guard. Both shipped with
-- the plain tenant predicate only:
--
--   USING ("familyId" = current_setting('app.family_id', true)::text)
--
-- That means the second wall of tenant isolation (the database, not the
-- application) accepted a session for ANY user whose `app.family_id` GUC
-- carried the family id — including a member whose `FamilyMember.status` is
-- `revoked`, and including a user who is not a member of that family at all.
-- Holdings carry cost basis and position size (the household's investment
-- data); every other tenant table already refuses the same session.
--
-- Evidence at the time of the audit:
--   grep -rn app_is_active_member prisma/migrations   -> matched 9 files,
--     NOT 20260804120000_holdings_core
--   prisma/migrations/20260804120000_holdings_core/migration.sql:117-120
--     (instrument_tenant_isolation) and :126-129 (holding_tenant_isolation)
--   and no later migration re-created either policy, so the gap persisted.
--
-- Fix: policy-only replacement, copied verbatim from the reference pattern in
-- `20260906120000_tags/migration.sql` (which carries the guard on
-- `tag_tenant_isolation` and `transaction_tag_tenant_isolation`). USING and
-- WITH CHECK both gain the conjunct, so a non-active member can neither read
-- nor write. ENABLE/FORCE ROW LEVEL SECURITY are already set on both tables
-- and are deliberately left untouched — this migration changes no data and no
-- table shape, so it is safe to apply on a populated database.
--
-- See ADR-0036 §4 (membership boundary) and the tags migration for the
-- canonical predicate.

-- Both tables get the SAME policy, so it is generated once from a table list
-- (no duplicated predicate to drift). Resulting policy names are exactly the
-- shipped ones: instrument_tenant_isolation and holding_tenant_isolation.
DO $$
DECLARE
  guarded_table text;
BEGIN
  FOREACH guarded_table IN ARRAY ARRAY['Instrument', 'Holding'] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      lower(guarded_table) || '_tenant_isolation',
      guarded_table
    );
    EXECUTE format(
      $policy$
        CREATE POLICY %I ON %I
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
          )
      $policy$,
      lower(guarded_table) || '_tenant_isolation',
      guarded_table
    );
  END LOOP;
END
$$;
