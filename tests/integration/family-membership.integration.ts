import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  LastOwnerError,
  MemberNotFoundError,
  MembershipForbiddenError,
  addMemberForFamily,
  getMembersForFamily,
  removeMemberForFamily,
  transferOwnershipForFamily,
  updateMemberRoleForFamily,
} from "@/server/family-members"
import { resolveActiveMembership } from "@/server/middleware/authz"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-144 / ADR-0036 — Real-Postgres proof of the membership + role contract:
// role enforcement, tenant isolation driven by membership, immediate revocation,
// the deep-RLS membership guard, last-owner protection, and idempotent replay.

describe("family membership & role authorization (PER-144)", () => {
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

  // Inject the harness tenant runner so the domain fns run with both GUCs set
  // to the acting owner/admin (exactly what familyMiddleware would do).
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

  const addOutsider = async (familyId: string, ownerId: string) => {
    const user = await factories.createUser({ familyId: null })
    const member = await addMemberForFamily({
      data: {
        email: user.email,
        role: "member",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      actor: { id: ownerId, role: "owner" },
      runInTenantTransaction: runner(ownerId),
    })
    return { user, member }
  }

  // -------------------------------------------------------------------------
  // Onboarding bootstrap + read
  // -------------------------------------------------------------------------
  test("onboarded family has exactly one active owner; getMembers lists it", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const members = await getMembersForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(members).toHaveLength(1)
    expect(members[0]?.role).toBe("owner")
    expect(members[0]?.status).toBe("active")
    expect(members[0]?.userId).toBe(owner.user.id)
  })

  // -------------------------------------------------------------------------
  // Role enforcement
  // -------------------------------------------------------------------------
  test("owner can add a member; admin cannot mint an admin; member/viewer cannot manage", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: added } = await addOutsider(owner.family.id, owner.user.id)

    const members = await getMembersForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(
      members.some((m) => m.userId === added.id && m.role === "member")
    ).toBe(true)

    // An admin may NOT assign the admin role (member:manage_admin is owner-only).
    const adminUser = await factories.createUser({ familyId: null })
    await addMemberForFamily({
      data: {
        email: adminUser.email,
        role: "member",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    await updateMemberRoleForFamily({
      data: {
        userId: adminUser.id,
        role: "admin",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    const newcomer = await factories.createUser({ familyId: null })
    await expect(
      addMemberForFamily({
        data: {
          email: newcomer.email,
          role: "admin",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: adminUser.id, role: "admin" },
        runInTenantTransaction: runner(adminUser.id),
      })
    ).rejects.toBeInstanceOf(MembershipForbiddenError)

    // A plain member may not manage members at all.
    await expect(
      addMemberForFamily({
        data: {
          email: newcomer.email,
          role: "member",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: added.id, role: "member" },
        runInTenantTransaction: runner(added.id),
      })
    ).rejects.toBeInstanceOf(MembershipForbiddenError)
  })

  test("admin cannot manage an owner row", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const adminUser = await factories.createUser({ familyId: null })
    await addMemberForFamily({
      data: {
        email: adminUser.email,
        role: "member",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    await updateMemberRoleForFamily({
      data: {
        userId: adminUser.id,
        role: "admin",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    await expect(
      removeMemberForFamily({
        data: {
          userId: owner.user.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: adminUser.id, role: "admin" },
        runInTenantTransaction: runner(adminUser.id),
      })
    ).rejects.toBeInstanceOf(MembershipForbiddenError)
  })

  // -------------------------------------------------------------------------
  // Tenant isolation driven by membership (deep-RLS guard)
  // -------------------------------------------------------------------------
  test("a member of family A cannot see family B rows even with B's GUC", async () => {
    const [familyA, familyB] = await Promise.all([
      factories.createAuthenticatedOnboardedUser(),
      factories.createAuthenticatedOnboardedUser(),
    ])
    await factories.createAccount({
      familyId: familyB.family.id,
      name: "B private account",
    })

    // app.family_id = B, app.user_id = A's owner (NOT a member of B). The
    // app_is_active_member guard must hide every row.
    const visible = await harness.withMember(
      familyB.family.id,
      familyA.user.id,
      (tx) => tx.account.findMany()
    )
    expect(visible).toHaveLength(0)
  })

  test("the membership guard blocks reads when app.user_id is not an active member", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await factories.createAccount({
      familyId: owner.family.id,
      name: "Guarded",
    })
    // Correct family, but an unknown (non-member) user id.
    const visible = await harness.withMember(
      owner.family.id,
      "user-who-is-not-a-member",
      (tx) => tx.account.findMany()
    )
    expect(visible).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Revocation revokes access immediately + re-add reactivates the same row
  // -------------------------------------------------------------------------
  test("removing a member revokes membership and access immediately; re-add reactivates", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: member } = await addOutsider(owner.family.id, owner.user.id)

    expect(
      await resolveActiveMembership(owner.family.id, member.id)
    ).not.toBeNull()

    await removeMemberForFamily({
      data: {
        userId: member.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    // No active membership -> middleware would reject; data reads as the revoked
    // user are blocked by the guard.
    expect(await resolveActiveMembership(owner.family.id, member.id)).toBeNull()
    const visibleAfterRevoke = await harness.withMember(
      owner.family.id,
      member.id,
      (tx) => tx.account.findMany()
    )
    expect(visibleAfterRevoke).toHaveLength(0)

    // Re-add flips the SAME row back to active (unique holds, no duplicate).
    await addMemberForFamily({
      data: {
        email: member.email,
        role: "member",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(
      await resolveActiveMembership(owner.family.id, member.id)
    ).not.toBeNull()
    const rows = await harness.withFamily(owner.family.id, (tx) =>
      tx.familyMember.findMany({ where: { userId: member.id } })
    )
    expect(rows).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Last-owner protection
  // -------------------------------------------------------------------------
  test("the sole owner cannot be removed or demoted (app + DB)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    await expect(
      removeMemberForFamily({
        data: {
          userId: owner.user.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(LastOwnerError)

    await expect(
      updateMemberRoleForFamily({
        data: {
          userId: owner.user.id,
          role: "admin",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(LastOwnerError)

    // DB backstop: a raw demote of the last owner is rejected by the trigger.
    await expect(
      harness.withMember(owner.family.id, owner.user.id, (tx) =>
        tx.familyMember.updateMany({
          where: { familyId: owner.family.id, userId: owner.user.id },
          data: { role: "admin" },
        })
      )
    ).rejects.toThrow(/owner/i)
  })

  test("ownership transfer is atomic: target becomes owner, actor becomes admin", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: heir } = await addOutsider(owner.family.id, owner.user.id)

    await transferOwnershipForFamily({
      data: {
        userId: heir.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    const members = await getMembersForFamily({
      familyId: owner.family.id,
      userId: heir.id,
    })
    const byUser = new Map(members.map((m) => [m.userId, m.role]))
    expect(byUser.get(heir.id)).toBe("owner")
    expect(byUser.get(owner.user.id)).toBe("admin")
  })

  // PER-271 — transferOwnershipFn already existed with no UI ever calling it.
  // These prove the three things the UI work depended on being true rather
  // than assumed: an AuditLog row per changed row, the caller-is-owner check
  // re-validated at the domain layer (not just the `ownership:transfer`
  // capability middleware in front of the server fn), and that the ex-owner
  // genuinely loses owner-only power the moment the transfer commits.
  test("ownership transfer writes an AuditLog row for both the promoted and demoted member", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: heir } = await addOutsider(owner.family.id, owner.user.id)

    const [promoted, demoted] = await transferOwnershipForFamily({
      data: {
        userId: heir.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    const audits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: {
          entityType: "FamilyMember",
          entityId: { in: [promoted!.id, demoted!.id] },
        },
        orderBy: { createdAt: "asc" },
      })
    )
    expect(audits).toHaveLength(2)
    expect(audits.every((a) => a.action === "update")).toBe(true)
    expect(audits.every((a) => a.userId === owner.user.id)).toBe(true)
    expect(audits.every((a) => a.familyId === owner.family.id)).toBe(true)

    const promotedAudit = audits.find((a) => a.entityId === promoted!.id)
    expect(promotedAudit?.afterJson).toMatchObject({
      userId: heir.id,
      role: "owner",
    })
    const demotedAudit = audits.find((a) => a.entityId === demoted!.id)
    expect(demotedAudit?.afterJson).toMatchObject({
      userId: owner.user.id,
      role: "admin",
    })
  })

  test("a non-owner actor is rejected even if it reaches the domain function directly (defense in depth behind the capability middleware)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: heir } = await addOutsider(owner.family.id, owner.user.id)
    const { user: thirdParty } = await addOutsider(
      owner.family.id,
      owner.user.id
    )
    await updateMemberRoleForFamily({
      data: {
        userId: heir.id,
        role: "admin",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    // A caller who merely CLAIMS role "admin" (e.g. a stale/forged context) is
    // still rejected by the function's own self.role check, which re-reads the
    // ACTUAL row from the database rather than trusting the passed-in actor.
    await expect(
      transferOwnershipForFamily({
        data: {
          userId: thirdParty.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: heir.id, role: "admin" },
        runInTenantTransaction: runner(heir.id),
      })
    ).rejects.toBeInstanceOf(MembershipForbiddenError)
  })

  test("after transfer, only the NEW owner can perform an owner-only action — the ex-owner cannot", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: heir } = await addOutsider(owner.family.id, owner.user.id)
    const { user: thirdParty } = await addOutsider(
      owner.family.id,
      owner.user.id
    )

    await transferOwnershipForFamily({
      data: {
        userId: heir.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    // The ex-owner (now admin) can no longer perform the owner-only action of
    // transferring ownership — even though they just held it a moment ago.
    await expect(
      transferOwnershipForFamily({
        data: {
          userId: thirdParty.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "admin" },
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(MembershipForbiddenError)

    // The new owner CAN.
    const result = await transferOwnershipForFamily({
      data: {
        userId: thirdParty.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: heir.id, role: "owner" },
      runInTenantTransaction: runner(heir.id),
    })
    const byUser = new Map(result.map((m) => [m.userId, m.role]))
    expect(byUser.get(thirdParty.id)).toBe("owner")
    expect(byUser.get(heir.id)).toBe("admin")
  })

  test("replaying an ownership transfer with the same idempotency key does not double promote/demote", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: heir } = await addOutsider(owner.family.id, owner.user.id)
    const key = factories.createIdempotencyKey()

    const first = await transferOwnershipForFamily({
      data: { userId: heir.id, idempotencyKey: key },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    const replay = await transferOwnershipForFamily({
      data: { userId: heir.id, idempotencyKey: key },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    expect(replay).toEqual(first)
    const audits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: {
          entityType: "FamilyMember",
          entityId: { in: [first[0]!.id, first[1]!.id] },
        },
      })
    )
    expect(audits).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------
  test("replaying a membership mutation with the same key does not double-write", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const target = await factories.createUser({ familyId: null })
    const key = factories.createIdempotencyKey()

    const first = await addMemberForFamily({
      data: { email: target.email, role: "member", idempotencyKey: key },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    const replay = await addMemberForFamily({
      data: { email: target.email, role: "member", idempotencyKey: key },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })

    expect(replay.id).toBe(first.id)
    const rows = await harness.withFamily(owner.family.id, (tx) =>
      tx.familyMember.findMany({ where: { userId: target.id } })
    )
    expect(rows).toHaveLength(1)

    // Audit rows are not double-written on replay.
    const audits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityType: "FamilyMember", entityId: first.id },
      })
    )
    expect(audits).toHaveLength(1)
  })

  test("re-revoking an already-revoked member is an idempotent no-op success", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { user: member } = await addOutsider(owner.family.id, owner.user.id)

    await removeMemberForFamily({
      data: {
        userId: member.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    const second = await removeMemberForFamily({
      data: {
        userId: member.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      actor: { id: owner.user.id, role: "owner" },
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(second.success).toBe(true)
    expect(second.status).toBe("revoked")
  })

  test("adding a non-existent user surfaces MemberNotFoundError", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await expect(
      addMemberForFamily({
        data: {
          email: "ghost@permoney.local",
          role: "member",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        actor: { id: owner.user.id, role: "owner" },
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(MemberNotFoundError)
  })
})
