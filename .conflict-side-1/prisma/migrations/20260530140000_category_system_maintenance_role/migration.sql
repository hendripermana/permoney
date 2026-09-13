-- PER-110 / ADR-0014: Seed split — privileged system-data phase vs app-tenant.
--
-- PER-102 locked app-role writes on "Category" to tenant non-system rows and
-- ran FORCE ROW LEVEL SECURITY. That left ONE legitimate path for writing
-- global system categories (isSystem = true, familyId IS NULL): a BYPASSRLS
-- role. A managed-Postgres production migration/seed runner does NOT have
-- BYPASSRLS, so the seed silently fails there.
--
-- This migration introduces a role-targeted RLS maintenance policy so a
-- NOBYPASSRLS role can write system rows ONLY by being a member of a dedicated
-- group role. Role membership is enforced by Postgres and is not forgeable from
-- inside a query — unlike a custom GUC (a dotted `app.bypass_rls` placeholder
-- can be SET by any role even after REVOKE SET ON PARAMETER, so a GUC-gated
-- policy was empirically rejected; see ADR-0014 § Alternatives).

-- 1. Group role that carries the "may maintain system categories" privilege.
--    NOLOGIN: it is a privilege holder, not a login identity. Idempotent so the
--    migration is safe whether or not a managed platform pre-provisioned it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permoney_system_maintainer') THEN
    CREATE ROLE permoney_system_maintainer NOLOGIN;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "Category" TO permoney_system_maintainer;

-- 2. Permissive, role-targeted policy. RLS permissive policies are OR-ed, so a
--    maintainer member gets the union of the PER-102 tenant policies plus this
--    one. The WITH CHECK keeps maintenance system-only; the (isSystem,familyId)
--    CHECK constraint from PER-102 still guards row shape. The app runtime role
--    is never a member, so this policy never widens app-traffic capability.
DROP POLICY IF EXISTS category_system_maintenance ON "Category";
CREATE POLICY category_system_maintenance ON "Category"
  FOR ALL
  TO permoney_system_maintainer
  USING ("isSystem" = true AND "familyId" IS NULL)
  WITH CHECK ("isSystem" = true AND "familyId" IS NULL);

-- 3. Make the role that runs this migration a member, so a single privileged
--    deploy role can both migrate and seed without a separate ALTER ROLE step.
--    The app runtime role connects with a different role and is never granted
--    this membership.
GRANT permoney_system_maintainer TO CURRENT_USER;
