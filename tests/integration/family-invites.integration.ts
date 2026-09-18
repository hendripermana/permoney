import { createHash } from "node:crypto"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { EmailDeliveryError } from "@/server/email.server"
import type { FamilyInviteEmailInput } from "@/server/email.server"
import {
  InviteAlreadyMemberError,
  InviteEmailMismatchError,
  InviteFamilyConflictError,
  InviteNotFoundError,
  InviteNotPendingError,
  acceptFamilyInviteForUser,
  applyInviteAfterSignup,
  createFamilyInviteForFamily,
  listFamilyInvitesForFamily,
  lookupFamilyInviteByToken,
  resendFamilyInviteForFamily,
  revokeFamilyInviteForFamily,
} from "@/server/family-invites"
import {
  MembershipForbiddenError,
  removeMemberForFamily,
} from "@/server/family-members"
import { RateLimitError } from "@/server/middleware/rate-limit"
import { resolveActiveMembership } from "@/server/middleware/authz"
import type { FamilyRole } from "@/server/middleware/authz"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// ADR-0057 — Real-Postgres proof of the family-invitation contract: the
// no-oracle uniform create response, hashed bearer tokens, the shared accept
// core (existing account + post-signup), expiry/revoke/replay/conflict
// rejections, supersede-on-reinvite (app + partial-unique-index backstop),
// tenant scoping of the management paths, rate limiting, and — critically —
// that a failed email send leaves NO invite row behind.

const DAY_MS = 24 * 60 * 60 * 1000
const BASE_URL = "https://permoney.test"

describe("family invitation by email (ADR-0057)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  const runner = (actorId: string) => {
    return <T>(
      familyId: string,
      userId: string,
      fn: Parameters<typeof harness.withMember>[2]
    ) => {
      expect(userId).toBe(actorId)
      return harness.withMember(familyId, userId, fn) as Promise<T>
    }
  }

  // Fake mailer: records every email instead of hitting Resend, so the raw
  // token (only ever present in the emailed link) can be recovered.
  const createMailbox = () => {
    const sent: FamilyInviteEmailInput[] = []
    return {
      sent,
      send: async (input: FamilyInviteEmailInput) => {
        sent.push(input)
      },
      lastToken: (): string => {
        const last = sent.at(-1)
        if (!last) throw new Error("no email was sent")
        const token = new URL(last.acceptUrl).searchParams.get("token")
        if (!token) throw new Error("email link carried no token")
        return token
      },
    }
  }

  type Mailbox = ReturnType<typeof createMailbox>

  interface Owner {
    family: { id: string }
    user: { id: string }
  }

  const invite = async (
    owner: Owner,
    mailbox: Mailbox,
    email: string,
    options: {
      role?: FamilyRole
      actorRole?: FamilyRole
      actorId?: string
      now?: () => Date
      key?: string
    } = {}
  ) => {
    const actorId = options.actorId ?? owner.user.id
    const created = await createFamilyInviteForFamily({
      data: {
        email,
        role: options.role ?? "member",
        idempotencyKey: options.key ?? factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: actorId, role: options.actorRole ?? "owner" },
      acceptBaseUrl: BASE_URL,
      runInTenantTransaction: runner(actorId),
      sendInviteEmail: mailbox.send,
      ...(options.now ? { now: options.now } : {}),
    })
    return { created, token: mailbox.lastToken() }
  }

  const accept = (userId: string, rawToken: string) =>
    acceptFamilyInviteForUser(harness.prisma, { userId, rawToken })

  const liveInviteCount = (familyId: string, email: string) =>
    harness.prisma.familyInvite.count({
      where: { familyId, email, acceptedAt: null, revokedAt: null },
    })

  const auditRows = (
    familyId: string,
    where: { entityType: string; entityId?: string }
  ) =>
    harness.withFamily(familyId, (tx) =>
      tx.auditLog.findMany({ where, orderBy: { createdAt: "asc" } })
    )

  // -------------------------------------------------------------------------
  // No-oracle: the create response is identical with or without an account
  // -------------------------------------------------------------------------
  test("create returns a uniform response whether or not the email has an account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const existing = await factories.createUser({ familyId: null })
    // An account that already belongs to ANOTHER family is also invisible.
    const otherFamilyOwner = await factories.createAuthenticatedOnboardedUser()

    const withAccount = await invite(owner, mailbox, existing.email)
    const withoutAccount = await invite(owner, mailbox, "ghost@permoney.local")
    const inOtherFamily = await invite(
      owner,
      mailbox,
      otherFamilyOwner.user.email
    )

    for (const other of [withoutAccount.created, inOtherFamily.created]) {
      expect(Object.keys(other).sort()).toEqual(
        Object.keys(withAccount.created).sort()
      )
      expect(other.role).toBe(withAccount.created.role)
      expect(other.status).toBe(withAccount.created.status)
      expect(other.invitedByName).toBe(withAccount.created.invitedByName)
      // Same-shaped values everywhere: nothing account-specific leaks.
      expect(typeof other.id).toBe("string")
      expect(new Date(other.expiresAt).getTime()).toBeGreaterThan(Date.now())
    }
    expect(mailbox.sent).toHaveLength(3)
    // Real invites were minted for all three — no branch skipped the write.
    expect(
      await harness.prisma.familyInvite.count({
        where: { familyId: owner.family.id },
      })
    ).toBe(3)
  })

  test("the accept link uses the canonical base URL and the email carries the TTL", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    await invite(owner, mailbox, "link@permoney.local")
    const email = mailbox.sent[0]!
    expect(email.acceptUrl.startsWith(`${BASE_URL}/invite/accept?token=`)).toBe(
      true
    )
    expect(email.expiresInDays).toBe(7)
    expect(email.to).toBe("link@permoney.local")
  })

  // -------------------------------------------------------------------------
  // Token hygiene
  // -------------------------------------------------------------------------
  test("only sha256(token) is persisted — never the raw token", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const { created, token } = await invite(
      owner,
      mailbox,
      "hash@permoney.local"
    )

    const row = await harness.prisma.familyInvite.findUniqueOrThrow({
      where: { id: created.id },
    })
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"))
    expect(row.tokenHash).not.toBe(token)
    expect(JSON.stringify(row)).not.toContain(token)

    // Nothing sensitive reaches the audit trail either.
    const audits = await auditRows(owner.family.id, {
      entityType: "FamilyInvite",
    })
    expect(audits.length).toBeGreaterThan(0)
    expect(JSON.stringify(audits)).not.toContain(token)
    expect(JSON.stringify(audits)).not.toContain(row.tokenHash)
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(
      6.9 * DAY_MS
    )
  })

  test("public lookup resolves a live token and reports not_found for a bogus one", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const { token } = await invite(owner, mailbox, "look@permoney.local", {
      role: "viewer",
    })

    const found = await lookupFamilyInviteByToken(harness.prisma, token)
    expect(found.familyId).toBe(owner.family.id)
    expect(found.invite).toMatchObject({
      status: "valid",
      email: "look@permoney.local",
      role: "viewer",
    })

    const bogus = await lookupFamilyInviteByToken(
      harness.prisma,
      "definitely-not-a-real-token-value"
    )
    expect(bogus.invite).toEqual({ status: "not_found" })
    expect(bogus.familyId).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Accept — existing account
  // -------------------------------------------------------------------------
  test("an existing account accepts: active member, User.familyId, acceptedAt, audited", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const { created, token } = await invite(owner, mailbox, invitee.email, {
      role: "admin",
    })

    const result = await accept(invitee.id, token)
    expect(result).toEqual({
      familyId: owner.family.id,
      role: "admin",
      alreadyAccepted: false,
    })

    const member = await harness.withFamily(owner.family.id, (tx) =>
      tx.familyMember.findUniqueOrThrow({
        where: {
          familyId_userId: { familyId: owner.family.id, userId: invitee.id },
        },
      })
    )
    expect(member).toMatchObject({
      role: "admin",
      status: "active",
      invitedById: owner.user.id,
    })
    expect(member.joinedAt).not.toBeNull()

    expect(
      (
        await harness.prisma.user.findUniqueOrThrow({
          where: { id: invitee.id },
          select: { familyId: true },
        })
      ).familyId
    ).toBe(owner.family.id)
    expect(
      (
        await harness.prisma.familyInvite.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).acceptedAt
    ).not.toBeNull()
    expect(
      await resolveActiveMembership(owner.family.id, invitee.id)
    ).not.toBeNull()

    // AuditLog: FamilyMember create + User familyId change + invite acceptance,
    // all attributed to the ACCEPTING user and written in the same transaction.
    const memberAudit = await auditRows(owner.family.id, {
      entityType: "FamilyMember",
      entityId: member.id,
    })
    expect(memberAudit.map((row) => row.action)).toEqual(["create"])
    expect(memberAudit[0]?.userId).toBe(invitee.id)
    const userAudit = await auditRows(owner.family.id, {
      entityType: "User",
      entityId: invitee.id,
    })
    expect(userAudit[0]?.afterJson).toMatchObject({ familyId: owner.family.id })
    const inviteAudit = await auditRows(owner.family.id, {
      entityType: "FamilyInvite",
      entityId: created.id,
    })
    expect(inviteAudit.map((row) => row.action)).toEqual(["create", "update"])
    expect(inviteAudit[1]?.afterJson).toMatchObject({ reason: "accepted" })
  })

  test("accepting is replay-safe: a second accept is a no-op and a concurrent pair applies once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const { created, token } = await invite(owner, mailbox, invitee.email)

    const [first, second] = await Promise.all([
      accept(invitee.id, token),
      accept(invitee.id, token),
    ])
    expect(
      [first.alreadyAccepted, second.alreadyAccepted].sort(
        (left, right) => Number(left) - Number(right)
      )
    ).toEqual([false, true])

    const again = await accept(invitee.id, token)
    expect(again.alreadyAccepted).toBe(true)

    expect(
      await harness.withFamily(owner.family.id, (tx) =>
        tx.familyMember.count({ where: { userId: invitee.id } })
      )
    ).toBe(1)
    const memberAudit = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.count({
        where: { entityType: "FamilyMember", userId: invitee.id },
      })
    )
    expect(memberAudit).toBe(1)
    const inviteAudit = await auditRows(owner.family.id, {
      entityType: "FamilyInvite",
      entityId: created.id,
    })
    expect(inviteAudit.filter((row) => row.action === "update")).toHaveLength(1)
  })

  test("an already-active member's role is never changed by accepting a later invite", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    // The email was invited BEFORE the person joined by another route (e.g. an
    // earlier invite) — model that by seeding the membership directly.
    const invitee = await factories.createUser({ familyId: owner.family.id })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: invitee.id,
      role: "admin",
    })
    // Bypass the create-time "already a member" guard to model a stale invite.
    const { token } = await (async () => {
      const email = "stale-invite@permoney.local"
      const result = await invite(owner, mailbox, email)
      await harness.prisma.familyInvite.update({
        where: { id: result.created.id },
        data: { email: invitee.email, role: "viewer" },
      })
      return result
    })()

    const result = await accept(invitee.id, token)
    expect(result).toMatchObject({ role: "admin", alreadyAccepted: false })
    const member = await harness.withFamily(owner.family.id, (tx) =>
      tx.familyMember.findFirstOrThrow({ where: { userId: invitee.id } })
    )
    expect(member.role).toBe("admin")
  })

  // -------------------------------------------------------------------------
  // Accept — via signup glue
  // -------------------------------------------------------------------------
  test("post-signup glue applies a matching invite to a fresh account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const { token } = await invite(owner, mailbox, "fresh@permoney.local")
    // What better-auth's signUpEmail leaves behind: a family-less User row.
    const fresh = await factories.createUser({
      email: "fresh@permoney.local",
      familyId: null,
    })

    expect(
      await applyInviteAfterSignup(harness.prisma, {
        userId: fresh.id,
        rawToken: token,
      })
    ).toBe(true)
    expect(
      await resolveActiveMembership(owner.family.id, fresh.id)
    ).not.toBeNull()
    expect(
      (
        await harness.prisma.user.findUniqueOrThrow({
          where: { id: fresh.id },
          select: { familyId: true },
        })
      ).familyId
    ).toBe(owner.family.id)
  })

  test("post-signup glue ignores a token for a different email, or garbage — never throws", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const { created, token } = await invite(
      owner,
      mailbox,
      "invited@permoney.local"
    )
    const someoneElse = await factories.createUser({
      email: "someone-else@permoney.local",
      familyId: null,
    })

    expect(
      await applyInviteAfterSignup(harness.prisma, {
        userId: someoneElse.id,
        rawToken: token,
      })
    ).toBe(false)
    expect(
      await applyInviteAfterSignup(harness.prisma, {
        userId: someoneElse.id,
        rawToken: "garbage",
      })
    ).toBe(false)
    expect(
      await applyInviteAfterSignup(harness.prisma, {
        userId: someoneElse.id,
        rawToken: "a-well-formed-but-unknown-token-value",
      })
    ).toBe(false)

    // Signup proceeds as a normal, family-less account; the invite is untouched.
    expect(
      (
        await harness.prisma.user.findUniqueOrThrow({
          where: { id: someoneElse.id },
          select: { familyId: true },
        })
      ).familyId
    ).toBeNull()
    expect(
      (
        await harness.prisma.familyInvite.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).acceptedAt
    ).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Accept — rejections
  // -------------------------------------------------------------------------
  test("an expired invite is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const { token } = await invite(owner, mailbox, invitee.email, {
      now: () => new Date(Date.now() - 8 * DAY_MS),
    })

    await expect(accept(invitee.id, token)).rejects.toMatchObject({
      name: "InviteUnavailableError",
      reason: "expired",
    })
    expect(
      (await lookupFamilyInviteByToken(harness.prisma, token)).invite
    ).toEqual({ status: "expired" })
    expect(
      await resolveActiveMembership(owner.family.id, invitee.id)
    ).toBeNull()
  })

  test("a revoked invite is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const { created, token } = await invite(owner, mailbox, invitee.email)

    await revokeFamilyInviteForFamily({
      data: {
        inviteId: created.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    await expect(accept(invitee.id, token)).rejects.toMatchObject({
      name: "InviteUnavailableError",
      reason: "revoked",
    })
    expect(
      (await lookupFamilyInviteByToken(harness.prisma, token)).invite
    ).toEqual({ status: "revoked" })
  })

  test("an accepted invite's link is dead for anyone who is not the active member", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const { token } = await invite(owner, mailbox, invitee.email)
    await accept(invitee.id, token)

    // Removed from the family afterwards: the old link must NOT re-admit them.
    await removeMemberForFamily({
      data: {
        userId: invitee.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    await expect(accept(invitee.id, token)).rejects.toMatchObject({
      name: "InviteUnavailableError",
      reason: "accepted",
    })
    expect(
      await resolveActiveMembership(owner.family.id, invitee.id)
    ).toBeNull()
  })

  test("a session whose email differs from the invite's is rejected and nothing changes", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const { created, token } = await invite(
      owner,
      mailbox,
      "target@permoney.local"
    )
    const intruder = await factories.createUser({ familyId: null })

    await expect(accept(intruder.id, token)).rejects.toBeInstanceOf(
      InviteEmailMismatchError
    )
    expect(
      await resolveActiveMembership(owner.family.id, intruder.id)
    ).toBeNull()
    expect(
      (
        await harness.prisma.familyInvite.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).acceptedAt
    ).toBeNull()
  })

  test("a user already in ANOTHER family gets a conflict and the invite is not consumed", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const otherOwner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const { created, token } = await invite(
      owner,
      mailbox,
      otherOwner.user.email
    )

    await expect(accept(otherOwner.user.id, token)).rejects.toBeInstanceOf(
      InviteFamilyConflictError
    )
    expect(
      (
        await harness.prisma.user.findUniqueOrThrow({
          where: { id: otherOwner.user.id },
          select: { familyId: true },
        })
      ).familyId
    ).toBe(otherOwner.family.id)
    expect(
      (
        await harness.prisma.familyInvite.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).acceptedAt
    ).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Composition with the PR #350 fix (revoke clears User.familyId)
  // -------------------------------------------------------------------------
  test("revoke-then-reinvite: a removed member is re-invited and accepts cleanly (same row reactivated)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const member = await factories.createUser({ familyId: null })
    const first = await invite(owner, mailbox, member.email)
    await accept(member.id, first.token)

    await removeMemberForFamily({
      data: {
        userId: member.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(
      (
        await harness.prisma.user.findUniqueOrThrow({
          where: { id: member.id },
          select: { familyId: true },
        })
      ).familyId
    ).toBeNull()

    const second = await invite(owner, mailbox, member.email, {
      role: "viewer",
    })
    const result = await accept(member.id, second.token)
    expect(result).toMatchObject({ role: "viewer", alreadyAccepted: false })

    const rows = await harness.withFamily(owner.family.id, (tx) =>
      tx.familyMember.findMany({ where: { userId: member.id } })
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "active", role: "viewer" })
    expect(rows[0]?.revokedAt).toBeNull()
    expect(
      await resolveActiveMembership(owner.family.id, member.id)
    ).not.toBeNull()
  })

  test("a user removed from family A can be invited into family B", async () => {
    const familyA = await factories.createAuthenticatedOnboardedUser()
    const familyB = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const person = await factories.createUser({ familyId: null })
    const inA = await invite(familyA, mailbox, person.email)
    await accept(person.id, inA.token)
    await removeMemberForFamily({
      data: {
        userId: person.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyA.family.id,
      actor: { id: familyA.user.id, role: "owner" },
      runInTenantTransaction: runner(familyA.user.id),
    })

    const inB = await invite(familyB, mailbox, person.email)
    await accept(person.id, inB.token)
    expect(
      (
        await harness.prisma.user.findUniqueOrThrow({
          where: { id: person.id },
          select: { familyId: true },
        })
      ).familyId
    ).toBe(familyB.family.id)
    expect(
      await resolveActiveMembership(familyB.family.id, person.id)
    ).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // Supersede + one live invite per (family, email)
  // -------------------------------------------------------------------------
  test("re-inviting an email supersedes the earlier link; only one live row remains", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const first = await invite(owner, mailbox, invitee.email)
    const second = await invite(owner, mailbox, invitee.email)

    expect(second.created.id).not.toBe(first.created.id)
    expect(await liveInviteCount(owner.family.id, invitee.email)).toBe(1)
    expect(
      (await lookupFamilyInviteByToken(harness.prisma, first.token)).invite
    ).toEqual({ status: "revoked" })
    await expect(accept(invitee.id, first.token)).rejects.toMatchObject({
      reason: "revoked",
    })

    const superseded = await auditRows(owner.family.id, {
      entityType: "FamilyInvite",
      entityId: first.created.id,
    })
    expect(superseded.at(-1)?.afterJson).toMatchObject({
      reason: "superseded",
    })

    // The newest link is the one that works.
    expect((await accept(invitee.id, second.token)).alreadyAccepted).toBe(false)
  })

  test("an expired-but-unrevoked invite is superseded too (no unique-index collision)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const email = "expired-then-reinvited@permoney.local"
    const stale = await invite(owner, mailbox, email, {
      now: () => new Date(Date.now() - 9 * DAY_MS),
    })
    expect(await liveInviteCount(owner.family.id, email)).toBe(1)

    const fresh = await invite(owner, mailbox, email)
    expect(await liveInviteCount(owner.family.id, email)).toBe(1)
    expect(
      (
        await harness.prisma.familyInvite.findUniqueOrThrow({
          where: { id: stale.created.id },
        })
      ).revokedAt
    ).not.toBeNull()
    expect(fresh.created.status).toBe("pending")
  })

  test("the partial unique index rejects a second live invite for the same (family,email) at the DB", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const email = "index-backstop@permoney.local"
    await invite(owner, mailbox, email)

    await expect(
      harness.prisma.familyInvite.create({
        data: {
          familyId: owner.family.id,
          email,
          role: "member",
          tokenHash: "f".repeat(64),
          invitedById: owner.user.id,
          expiresAt: new Date(Date.now() + DAY_MS),
        },
      })
    ).rejects.toMatchObject({ code: "P2002" })

    // A revoked/accepted row does NOT count as live — the index is partial.
    await harness.prisma.familyInvite.create({
      data: {
        familyId: owner.family.id,
        email,
        role: "member",
        tokenHash: "e".repeat(64),
        invitedById: owner.user.id,
        expiresAt: new Date(Date.now() + DAY_MS),
        revokedAt: new Date(),
      },
    })
  })

  test("the role CHECK rejects a raw write outside the role domain", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await expect(
      harness.prisma.familyInvite.create({
        data: {
          familyId: owner.family.id,
          email: "bad-role@permoney.local",
          role: "superuser",
          tokenHash: "d".repeat(64),
          invitedById: owner.user.id,
          expiresAt: new Date(Date.now() + DAY_MS),
        },
      })
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // Already-a-member is tenant-scoped ONLY
  // -------------------------------------------------------------------------
  test("inviting an active member of THIS family is rejected; a member of another family is not", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const otherOwner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const member = await factories.createUser({ familyId: owner.family.id })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: member.id,
      role: "member",
    })

    await expect(invite(owner, mailbox, member.email)).rejects.toBeInstanceOf(
      InviteAlreadyMemberError
    )
    expect(mailbox.sent).toHaveLength(0)

    // An account that exists elsewhere is indistinguishable from any other
    // address: the invite is created normally.
    const { created } = await invite(owner, mailbox, otherOwner.user.email)
    expect(created.status).toBe("pending")
  })

  // -------------------------------------------------------------------------
  // Email delivery failure => NO invite row (critical)
  // -------------------------------------------------------------------------
  test("a failed email send leaves NO FamilyInvite, audit, or idempotency row behind", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const key = factories.createIdempotencyKey()

    await expect(
      createFamilyInviteForFamily({
        data: {
          email: "nomail@permoney.local",
          role: "member",
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        acceptBaseUrl: BASE_URL,
        runInTenantTransaction: runner(owner.user.id),
        sendInviteEmail: async () => {
          throw new EmailDeliveryError("simulated Resend outage")
        },
      })
    ).rejects.toBeInstanceOf(EmailDeliveryError)

    expect(await harness.prisma.familyInvite.count()).toBe(0)
    const leaked = await harness.withFamily(owner.family.id, async (tx) => ({
      audits: await tx.auditLog.count({
        where: { entityType: "FamilyInvite" },
      }),
      idempotency: await tx.idempotencyRecord.count({
        where: { endpoint: "createFamilyInviteFn" },
      }),
    }))
    expect(leaked).toEqual({ audits: 0, idempotency: 0 })

    // The same key can be retried once email works: the failure recorded nothing.
    const mailbox = createMailbox()
    const retried = await invite(owner, mailbox, "nomail@permoney.local", {
      key,
    })
    expect(retried.created.status).toBe("pending")
  })

  test("the DEFAULT sender fails loudly (and leaves no row) when RESEND_API_KEY is unset", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const saved = {
      key: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM_EMAIL,
    }
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_FROM_EMAIL
    try {
      await expect(
        createFamilyInviteForFamily({
          data: {
            email: "noconfig@permoney.local",
            role: "member",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          actor: { id: owner.user.id, role: "owner" },
          acceptBaseUrl: BASE_URL,
          runInTenantTransaction: runner(owner.user.id),
        })
      ).rejects.toBeInstanceOf(EmailDeliveryError)
    } finally {
      if (saved.key !== undefined) process.env.RESEND_API_KEY = saved.key
      if (saved.from !== undefined) process.env.RESEND_FROM_EMAIL = saved.from
    }
    expect(await harness.prisma.familyInvite.count()).toBe(0)
  })

  test("a failed send during RE-invite does not revoke the earlier live link", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const email = "keeps-old-link@permoney.local"
    const original = await invite(owner, mailbox, email)

    await expect(
      createFamilyInviteForFamily({
        data: {
          email,
          role: "member",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        acceptBaseUrl: BASE_URL,
        runInTenantTransaction: runner(owner.user.id),
        sendInviteEmail: async () => {
          throw new EmailDeliveryError("simulated outage")
        },
      })
    ).rejects.toBeInstanceOf(EmailDeliveryError)

    expect(await liveInviteCount(owner.family.id, email)).toBe(1)
    expect(
      (await lookupFamilyInviteByToken(harness.prisma, original.token)).invite
        .status
    ).toBe("valid")
  })

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------
  test("replaying a create with the same key returns the stored response without re-sending", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const key = factories.createIdempotencyKey()
    const first = await invite(owner, mailbox, "replay@permoney.local", { key })
    const replay = await invite(owner, mailbox, "replay@permoney.local", {
      key,
    })

    expect(replay.created).toEqual(first.created)
    expect(mailbox.sent).toHaveLength(1)
    expect(
      await harness.prisma.familyInvite.count({
        where: { familyId: owner.family.id },
      })
    ).toBe(1)
    const audits = await auditRows(owner.family.id, {
      entityType: "FamilyInvite",
    })
    expect(audits).toHaveLength(1)
  })

  test("the same key with a different payload is a conflict", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const key = factories.createIdempotencyKey()
    await invite(owner, mailbox, "one@permoney.local", { key })
    await expect(
      invite(owner, mailbox, "two@permoney.local", { key })
    ).rejects.toMatchObject({ name: "IdempotencyConflictError" })
  })

  // -------------------------------------------------------------------------
  // Role rules
  // -------------------------------------------------------------------------
  test("an admin may invite member/viewer but not admin/owner; a plain member may not invite", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const admin = await factories.createUser({ familyId: owner.family.id })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: admin.id,
      role: "admin",
    })

    const ok = await invite(owner, mailbox, "by-admin@permoney.local", {
      actorId: admin.id,
      actorRole: "admin",
      role: "viewer",
    })
    expect(ok.created.role).toBe("viewer")

    for (const role of ["admin", "owner"] as const) {
      await expect(
        invite(owner, mailbox, `${role}-by-admin@permoney.local`, {
          actorId: admin.id,
          actorRole: "admin",
          role,
        })
      ).rejects.toBeInstanceOf(MembershipForbiddenError)
    }

    const plain = await factories.createUser({ familyId: owner.family.id })
    await expect(
      invite(owner, mailbox, "by-member@permoney.local", {
        actorId: plain.id,
        actorRole: "member",
      })
    ).rejects.toBeInstanceOf(MembershipForbiddenError)
  })

  // -------------------------------------------------------------------------
  // Management paths: list / revoke / resend, scoped to the caller's family
  // -------------------------------------------------------------------------
  test("list shows pending and expired-unrevoked invites for THIS family only", async () => {
    const familyA = await factories.createAuthenticatedOnboardedUser()
    const familyB = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    await invite(familyA, mailbox, "pending@permoney.local")
    await invite(familyA, mailbox, "stale@permoney.local", {
      now: () => new Date(Date.now() - 8 * DAY_MS),
    })
    const revoked = await invite(familyA, mailbox, "revoked@permoney.local")
    await invite(familyB, mailbox, "b-only@permoney.local")
    await revokeFamilyInviteForFamily({
      data: {
        inviteId: revoked.created.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyA.family.id,
      actor: { id: familyA.user.id, role: "owner" },
      runInTenantTransaction: runner(familyA.user.id),
    })

    const list = await listFamilyInvitesForFamily({
      familyId: familyA.family.id,
      userId: familyA.user.id,
      runInTenantTransaction: runner(familyA.user.id),
    })
    expect(
      list
        .map((row) => [row.email, row.status] as const)
        .sort((left, right) => left[0].localeCompare(right[0]))
    ).toEqual([
      ["pending@permoney.local", "pending"],
      ["stale@permoney.local", "expired"],
    ])
  })

  test("revoke and resend refuse another family's invite id as not found", async () => {
    const familyA = await factories.createAuthenticatedOnboardedUser()
    const familyB = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const inB = await invite(familyB, mailbox, "b-target@permoney.local")

    await expect(
      revokeFamilyInviteForFamily({
        data: {
          inviteId: inB.created.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: familyA.family.id,
        actor: { id: familyA.user.id, role: "owner" },
        runInTenantTransaction: runner(familyA.user.id),
      })
    ).rejects.toBeInstanceOf(InviteNotFoundError)
    await expect(
      resendFamilyInviteForFamily({
        data: {
          inviteId: inB.created.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: familyA.family.id,
        actor: { id: familyA.user.id, role: "owner" },
        acceptBaseUrl: BASE_URL,
        runInTenantTransaction: runner(familyA.user.id),
        sendInviteEmail: mailbox.send,
      })
    ).rejects.toBeInstanceOf(InviteNotFoundError)

    expect(
      (await lookupFamilyInviteByToken(harness.prisma, inB.token)).invite.status
    ).toBe("valid")
  })

  test("revoke is audited and idempotent; an accepted invite cannot be revoked", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const pending = await invite(owner, mailbox, "to-revoke@permoney.local")
    const revoke = (inviteId: string) =>
      revokeFamilyInviteForFamily({
        data: { inviteId, idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        runInTenantTransaction: runner(owner.user.id),
      })

    await revoke(pending.created.id)
    await expect(revoke(pending.created.id)).resolves.toMatchObject({
      success: true,
    })
    const audits = await auditRows(owner.family.id, {
      entityType: "FamilyInvite",
      entityId: pending.created.id,
    })
    // create + exactly ONE revoke audit (the second revoke was a no-op).
    expect(audits.map((row) => row.action)).toEqual(["create", "update"])

    const invitee = await factories.createUser({ familyId: null })
    const accepted = await invite(owner, mailbox, invitee.email)
    await accept(invitee.id, accepted.token)
    await expect(revoke(accepted.created.id)).rejects.toBeInstanceOf(
      InviteNotPendingError
    )
  })

  test("resend rotates the token (old link dies, new one works) and extends expiry", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const invitee = await factories.createUser({ familyId: null })
    const original = await invite(owner, mailbox, invitee.email, {
      now: () => new Date(Date.now() - 5 * DAY_MS),
    })

    const resent = await resendFamilyInviteForFamily({
      data: {
        inviteId: original.created.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      acceptBaseUrl: BASE_URL,
      runInTenantTransaction: runner(owner.user.id),
      sendInviteEmail: mailbox.send,
    })
    const newToken = mailbox.lastToken()

    expect(resent.id).toBe(original.created.id)
    expect(newToken).not.toBe(original.token)
    expect(new Date(resent.expiresAt).getTime()).toBeGreaterThan(
      new Date(original.created.expiresAt).getTime()
    )
    expect(mailbox.sent).toHaveLength(2)
    expect(
      (await lookupFamilyInviteByToken(harness.prisma, original.token)).invite
    ).toEqual({ status: "not_found" })
    expect((await accept(invitee.id, newToken)).alreadyAccepted).toBe(false)
  })

  test("a failed resend send keeps the previously emailed link working", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const original = await invite(owner, mailbox, "resend-fail@permoney.local")

    await expect(
      resendFamilyInviteForFamily({
        data: {
          inviteId: original.created.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        acceptBaseUrl: BASE_URL,
        runInTenantTransaction: runner(owner.user.id),
        sendInviteEmail: async () => {
          throw new EmailDeliveryError("simulated outage")
        },
      })
    ).rejects.toBeInstanceOf(EmailDeliveryError)
    expect(
      (await lookupFamilyInviteByToken(harness.prisma, original.token)).invite
        .status
    ).toBe("valid")
  })

  test("resending a revoked invite is refused", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()
    const target = await invite(owner, mailbox, "revoked-resend@permoney.local")
    await revokeFamilyInviteForFamily({
      data: {
        inviteId: target.created.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    await expect(
      resendFamilyInviteForFamily({
        data: {
          inviteId: target.created.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        acceptBaseUrl: BASE_URL,
        runInTenantTransaction: runner(owner.user.id),
        sendInviteEmail: mailbox.send,
      })
    ).rejects.toBeInstanceOf(InviteNotPendingError)
  })

  // -------------------------------------------------------------------------
  // Rate limit (10 / hour per inviting user; create + resend share it)
  // -------------------------------------------------------------------------
  test("the 11th invite from one user inside the window is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const mailbox = createMailbox()

    for (let index = 0; index < 10; index += 1) {
      await invite(owner, mailbox, `bulk-${index}@permoney.local`)
    }
    await expect(
      invite(owner, mailbox, "bulk-10@permoney.local")
    ).rejects.toBeInstanceOf(RateLimitError)
    expect(mailbox.sent).toHaveLength(10)
    expect(
      await harness.prisma.familyInvite.count({
        where: { familyId: owner.family.id },
      })
    ).toBe(10)

    // Keyed by the inviting USER, not the family/IP: another user is unaffected.
    const other = await factories.createAuthenticatedOnboardedUser()
    await invite(other, mailbox, "other-user@permoney.local")
  })
})
