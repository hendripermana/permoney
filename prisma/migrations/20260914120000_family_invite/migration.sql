-- ADR-0057 — Family invitation by email.
--
-- One new table, `FamilyInvite`, purely additive: no other table's data or
-- shape changes. Deliberately NOT RLS-scoped — mirrors the existing
-- Family/User precedent (see prisma/seed/app-tenant.ts: "Family is not
-- RLS-protected (auth-gated)"). The accept-flow's core lookup ("does this raw
-- token from the URL correspond to a live invite?") runs before the visitor is
-- a member of the target family, so there is no membership yet to derive
-- app.family_id from — a `scopedTenantTransaction` cannot apply here. Access
-- control is enforced in application code instead:
--   - token-lookup/accept path: bearer-capability model (possessing the
--     unguessable 256-bit token IS the authorization to read/accept that one
--     row), same trust model as a password-reset link.
--   - management (list/revoke/resend) path: requireCapability("member:manage")
--     plus an explicit `WHERE familyId = context.familyId` in every query.

CREATE TABLE "FamilyInvite" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FamilyInvite_tokenHash_key" ON "FamilyInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "FamilyInvite_familyId_email_idx" ON "FamilyInvite"("familyId", "email");

-- CreateIndex
CREATE INDEX "FamilyInvite_email_idx" ON "FamilyInvite"("email");

-- At most ONE live (unaccepted, unrevoked) invite per (family, email). A partial
-- unique index — Prisma cannot express the predicate, so it lives only here (same
-- convention as the Sure-migration `externalId` partial uniques in schema.prisma).
-- `createFamilyInviteForFamily` revokes any live invite for the pair BEFORE
-- inserting the new one (so re-inviting an email supersedes the old link); this
-- index is the race backstop when two invites for the same pair run concurrently.
-- Expired-but-unrevoked invites are still "live" here by design: the application
-- revokes them explicitly on re-invite.
CREATE UNIQUE INDEX "FamilyInvite_live_familyId_email_key"
  ON "FamilyInvite"("familyId", "email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "FamilyInvite" ADD CONSTRAINT "FamilyInvite_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyInvite" ADD CONSTRAINT "FamilyInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain CHECK (house convention: String + CHECK, not enums) — the SAME role
-- vocabulary as FamilyMember.role (see "family_member_role_domain" in
-- migration 20260620044436_family_membership). A raw write can never persist a
-- role outside this domain.
ALTER TABLE "FamilyInvite" ADD CONSTRAINT "family_invite_role_domain"
  CHECK ("role" IN ('owner', 'admin', 'member', 'viewer'));

-- No RLS enabled on this table — see file header comment. Family and User (the
-- two tables FamilyInvite references) carry no RLS policies either.
