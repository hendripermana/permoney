-- AlterTable
ALTER TABLE "AuthAccount" ADD COLUMN     "issuer" TEXT;

-- Backfill: better-auth 1.7's sign-in handler matches credential accounts by
-- `providerId = 'credential' AND issuer = 'local:credential'` (strict `===`,
-- see better-auth/dist/api/routes/sign-in.mjs). Existing rows would keep
-- `issuer IS NULL` after the ALTER above and NEVER match that check again,
-- locking out every pre-existing email/password user in production. This
-- app only configures `emailAndPassword` (no OAuth/social providers as of
-- this migration — see src/server/auth.server.ts), so every existing
-- AuthAccount row is a local credential account and gets the same value
-- better-auth's own `createLocalAccountIssuer("credential")` produces.
UPDATE "AuthAccount" SET "issuer" = 'local:credential' WHERE "providerId" = 'credential' AND "issuer" IS NULL;
