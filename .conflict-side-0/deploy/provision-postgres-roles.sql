-- =============================================================================
-- Permoney production Postgres role provisioning (PER-192)
-- =============================================================================
-- Run TWICE against a fresh production database, connected as the Postgres
-- superuser the `postgres:16` image bootstraps (POSTGRES_USER from
-- docker-compose.prod.yml). Idempotent — safe to re-run either pass any
-- number of times.
--
--   Pass 1, BEFORE `prisma migrate deploy`: creates the login roles and sets
--   ALTER DEFAULT PRIVILEGES. Because this runs before permoney_migrator has
--   created any tables, every table the migration subsequently creates
--   inherits permoney_app's grants automatically — the explicit
--   "GRANT ... ON ALL TABLES" and the AuditLog REVOKE below will error
--   harmlessly (no tables exist yet; psql continues past errors by default
--   with a plain `-f` invocation) — that's expected on this pass.
--
--   Pass 2, AFTER `prisma migrate deploy`: re-run the same file. Role
--   creation/password-setting and the default-privileges declaration are
--   no-ops the second time; what actually matters on this pass is the
--   AuditLog REVOKE, which can only succeed once the table exists (default
--   privileges are schema-wide and cannot selectively exclude one table).
--
-- Usage (never puts real passwords in this file or in shell history in
-- plaintext-on-disk; pass them as psql variables from the server-side .env):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U permoney_admin -d permoney_prod \
--     -v migrator_password="$PERMONEY_MIGRATOR_PASSWORD" \
--     -v app_password="$PERMONEY_APP_PASSWORD" \
--     -f - < deploy/provision-postgres-roles.sql
--
-- Two distinct roles, matching the split ADR-0014/.env.example already
-- documents for managed-Postgres deploys, replicated here for the
-- self-hosted case (docs/adr/0047-self-hosted-production-postgres.md):
--
--   permoney_migrator — used ONLY for `prisma migrate deploy`. Has CREATEROLE
--     so the `20260530140000_category_system_maintenance_role` migration can
--     self-provision `permoney_system_maintainer` and grant it to itself
--     (CURRENT_USER at migrate time). NOT superuser, NOT bypassrls — Postgres
--     16 tightened CREATEROLE so it cannot grant attributes (BYPASSRLS,
--     SUPERUSER, REPLICATION) it doesn't itself hold, so this role cannot
--     escalate a role to bypass RLS even though it can create roles.
--
--   permoney_app — the DATABASE_URL role the running application connects
--     as. NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB. Never a member
--     of permoney_system_maintainer. This is the role
--     tests/integration/support/database.ts's `assertRuntimeRoleEnforcesRls`
--     shape is built to verify (rolsuper = false AND rolbypassrls = false)
--     before the app is ever allowed to trust it.
-- =============================================================================

-- psql's `:'var'` client-side substitution does NOT apply inside dollar-quoted
-- (DO $$...$$) bodies — it's plain text to the substitution engine, so a
-- password interpolated there would send a literal, invalid ":'name'" token
-- to the server. Split role creation (idempotent, no password, safe inside
-- $$...$$) from attribute/password assignment (plain top-level ALTER ROLE,
-- where substitution works, and safely re-appliable on every run).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permoney_migrator') THEN
    CREATE ROLE permoney_migrator NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permoney_app') THEN
    CREATE ROLE permoney_app NOLOGIN;
  END IF;
END
$$;

ALTER ROLE permoney_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD :'migrator_password';
ALTER ROLE permoney_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'app_password';

GRANT CONNECT ON DATABASE permoney_prod TO permoney_migrator;
GRANT CONNECT ON DATABASE permoney_prod TO permoney_app;

-- permoney_migrator owns schema objects it creates via `migrate deploy`
-- (default: whichever role runs CREATE TABLE owns the table). Grant it
-- CREATE on the schema so migrations can add tables/indexes/constraints.
GRANT USAGE, CREATE ON SCHEMA public TO permoney_migrator;
GRANT USAGE ON SCHEMA public TO permoney_app;

-- Current tables/sequences (idempotent — only meaningful after the first
-- `prisma migrate deploy` has run; re-run this script after that if you
-- provision roles before the first migration).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO permoney_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO permoney_app;

-- AuditLog is append-only (ADR-0006) — the app role may INSERT/SELECT but
-- never mutate or erase audit evidence.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM permoney_app;

-- Future tables/sequences: any table permoney_migrator creates in a LATER
-- `prisma migrate deploy` run automatically grants permoney_app the same
-- baseline access, so the app role never needs a manual re-grant after a
-- routine migration.
--
-- CAVEAT (read before adding a new immutable/append-only table, e.g. a
-- second audit-shaped table): default privileges are schema-wide, not
-- per-table — there is no way to pre-exclude UPDATE/DELETE/TRUNCATE for a
-- specific future table here. After any migration that adds a new
-- audit/immutable-ledger table, manually run the equivalent of the
-- AuditLog REVOKE above for that table. See docs/runbook-production.md.
ALTER DEFAULT PRIVILEGES FOR ROLE permoney_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO permoney_app;
ALTER DEFAULT PRIVILEGES FOR ROLE permoney_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO permoney_app;

-- Sanity check, printed for the operator running this interactively —
-- mirrors tests/integration/support/database.ts's assertRuntimeRoleEnforcesRls.
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
FROM pg_roles
WHERE rolname IN ('permoney_migrator', 'permoney_app')
ORDER BY rolname;
