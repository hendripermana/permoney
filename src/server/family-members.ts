import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { auditLog, auditLogs, createAuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
} from "./middleware/with-family"
import type { TenantTransactionClient } from "./middleware/with-family"
import type { FamilyRole } from "./middleware/authz"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import { isUniqueConstraintError, uuidV7Schema } from "./mutation-kit"

// =============================================================================
// PER-144 — Family membership & role authorization (ADR-0036).
//
// Membership mutations are first-class ledger-grade mutations: every one runs in
// an interactive tenant transaction (app.family_id + app.user_id GUCs), replays
// through `IdempotencyRecord`, validates tenant-owned references, and writes an
// append-only `AuditLog` row with entityType "FamilyMember" in the same tx.
//
// Authorization is layered: the server fns gate on `member:manage` (or
// `ownership:transfer`), and the domain functions additionally enforce the
// target-role rules below so an admin can never escalate by editing a
// higher-privileged row. The DB last-owner trigger is the final backstop.
// =============================================================================

const ADD_MEMBER_ENDPOINT = "addMemberFn"
const UPDATE_MEMBER_ROLE_ENDPOINT = "updateMemberRoleFn"
const REMOVE_MEMBER_ENDPOINT = "removeMemberFn"
const TRANSFER_OWNERSHIP_ENDPOINT = "transferOwnershipFn"

const ROLE_VALUES = ["owner", "admin", "member", "viewer"] as const
const roleSchema = z.enum(ROLE_VALUES)

/**
 * Raised when a membership mutation is refused by the role rules (distinct from
 * the middleware-level FORBIDDEN, which gates the capability itself). Surfaces a
 * 403 to the caller.
 */
export class MembershipForbiddenError extends Error {
  override readonly name = "MembershipForbiddenError"
  readonly statusCode = 403
  constructor(message: string) {
    super(message)
  }
}

export class MemberNotFoundError extends Error {
  override readonly name = "MemberNotFoundError"
  readonly statusCode = 404
  constructor(message = "Member not found for this family") {
    super(message)
  }
}

export class LastOwnerError extends Error {
  override readonly name = "LastOwnerError"
  readonly statusCode = 409
  constructor(message = "A family must always have at least one active owner") {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Role authorization rules (the target-row half of ADR-0036 §2).
// ---------------------------------------------------------------------------

// Which roles an actor may assign to (or manage on) another row.
function assignableRoles(actorRole: FamilyRole): ReadonlySet<FamilyRole> {
  if (actorRole === "owner") {
    return new Set<FamilyRole>(["owner", "admin", "member", "viewer"])
  }
  if (actorRole === "admin") {
    return new Set<FamilyRole>(["member", "viewer"])
  }
  return new Set<FamilyRole>()
}

// Whether an actor may manage a row that currently holds `targetRole`. Owners
// manage anyone; admins manage only member/viewer rows (never owner/admin).
function canManageTarget(
  actorRole: FamilyRole,
  targetRole: FamilyRole
): boolean {
  if (actorRole === "owner") return true
  if (actorRole === "admin") {
    return targetRole === "member" || targetRole === "viewer"
  }
  return false
}

function assertCanAssignRole(actorRole: FamilyRole, role: FamilyRole): void {
  if (!assignableRoles(actorRole).has(role)) {
    throw new MembershipForbiddenError(
      `Role ${actorRole} may not assign the role ${role}`
    )
  }
}

function assertCanManageTarget(
  actorRole: FamilyRole,
  targetRole: FamilyRole
): void {
  if (!canManageTarget(actorRole, targetRole)) {
    throw new MembershipForbiddenError(
      `Role ${actorRole} may not manage a ${targetRole} member`
    )
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedFamilyMember {
  id: string
  userId: string
  email: string
  name: string
  role: string
  status: string
  invitedAt: string | null
  joinedAt: string | null
  revokedAt: string | null
}

interface MemberRow {
  id: string
  userId: string
  role: string
  status: string
  invitedAt: Date | null
  joinedAt: Date | null
  revokedAt: Date | null
  user: { email: string; name: string }
}

function serializeMember(member: MemberRow): SerializedFamilyMember {
  return {
    id: member.id,
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    role: member.role,
    status: member.status,
    invitedAt: member.invitedAt?.toISOString() ?? null,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    revokedAt: member.revokedAt?.toISOString() ?? null,
  }
}

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  invitedAt: true,
  joinedAt: true,
  revokedAt: true,
  user: { select: { email: true, name: true } },
} as const

// ===========================================================================
// READ
// ===========================================================================

export async function getMembersForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedFamilyMember[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const members = await tx.familyMember.findMany({
      where: { familyId, status: { in: ["active", "invited"] } },
      select: MEMBER_SELECT,
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    })
    return members.map(serializeMember)
  })
}

export const getMembersFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getMembersForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// ADD MEMBER
// ===========================================================================

const addMemberInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: roleSchema.default("member"),
  idempotencyKey: uuidV7Schema,
})

type AddMemberInput = z.input<typeof addMemberInputSchema>

interface ActorContext {
  id: string
  role: FamilyRole
}

export async function addMemberForFamily({
  data: rawData,
  familyId,
  actor,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: AddMemberInput
  familyId: string
  actor: ActorContext
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedFamilyMember> {
  const data = addMemberInputSchema.parse(rawData)
  // Only owners may mint admins/owners; admins may add member/viewer only.
  assertCanAssignRole(actor.role, data.role)

  const requestHash = await hashCanonicalPayload({
    email: data.email,
    role: data.role,
  })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedFamilyMember>(tx, {
          endpoint: ADD_MEMBER_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      // The target user must already exist (no email-invitation flow in this
      // slice — `invited` status is reserved for it). User is not RLS-scoped.
      const targetUser = await tx.user.findUnique({
        where: { email: data.email },
        select: { id: true, familyId: true },
      })
      if (!targetUser) {
        throw new MemberNotFoundError(`No user exists with email ${data.email}`)
      }

      const existing = await tx.familyMember.findUnique({
        where: { familyId_userId: { familyId, userId: targetUser.id } },
        select: { id: true, role: true, status: true },
      })
      // Re-managing an existing row obeys the same target-role rule.
      if (existing) {
        assertCanManageTarget(actor.role, existing.role as FamilyRole)
      }

      const member = await tx.familyMember.upsert({
        where: { familyId_userId: { familyId, userId: targetUser.id } },
        update: {
          role: data.role,
          status: "active",
          revokedAt: null,
          joinedAt: new Date(),
          invitedById: actor.id,
        },
        create: {
          familyId,
          userId: targetUser.id,
          role: data.role,
          status: "active",
          joinedAt: new Date(),
          invitedById: actor.id,
        },
        select: MEMBER_SELECT,
      })

      // A user with no active family yet adopts this one as their active
      // pointer so they can actually act in it. Users already pointing at a
      // family keep that pointer (multi-family is reserved, not built here).
      if (!targetUser.familyId) {
        await tx.user.update({
          where: { id: targetUser.id },
          data: { familyId },
        })
      }

      const serialized = serializeMember(member)
      await auditLog(tx, auditCtx, {
        action: existing ? "update" : "create",
        entityType: "FamilyMember",
        entityId: member.id,
        before: existing
          ? { role: existing.role, status: existing.status }
          : null,
        after: {
          userId: member.userId,
          role: member.role,
          status: member.status,
        },
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: ADD_MEMBER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedFamilyMember>(tx, {
        endpoint: ADD_MEMBER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const addMemberFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("member:manage")])
  .inputValidator((data: AddMemberInput) => addMemberInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    return await addMemberForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
    })
  })

// ===========================================================================
// UPDATE ROLE
// ===========================================================================

const updateMemberRoleInputSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
  idempotencyKey: uuidV7Schema,
})

type UpdateMemberRoleInput = z.input<typeof updateMemberRoleInputSchema>

async function loadMemberByUserId(
  tx: TenantTransactionClient,
  familyId: string,
  userId: string
): Promise<{ id: string; role: FamilyRole; status: string }> {
  const member = await tx.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId } },
    select: { id: true, role: true, status: true },
  })
  if (!member || member.status !== "active") {
    throw new MemberNotFoundError()
  }
  return {
    id: member.id,
    role: member.role as FamilyRole,
    status: member.status,
  }
}

async function countActiveOwners(
  tx: TenantTransactionClient,
  familyId: string
): Promise<number> {
  return await tx.familyMember.count({
    where: { familyId, role: "owner", status: "active" },
  })
}

export async function updateMemberRoleForFamily({
  data: rawData,
  familyId,
  actor,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: UpdateMemberRoleInput
  familyId: string
  actor: ActorContext
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedFamilyMember> {
  const data = updateMemberRoleInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    userId: data.userId,
    role: data.role,
  })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedFamilyMember>(tx, {
          endpoint: UPDATE_MEMBER_ROLE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const target = await loadMemberByUserId(tx, familyId, data.userId)
      // Actor must be allowed to manage the target's CURRENT role and to assign
      // the NEW role (e.g. an admin cannot touch an admin, nor promote to admin).
      assertCanManageTarget(actor.role, target.role)
      assertCanAssignRole(actor.role, data.role)

      // App-level last-owner pre-check for a friendly error; the DB trigger is
      // the backstop. Demoting the last active owner is refused.
      if (target.role === "owner" && data.role !== "owner") {
        const owners = await countActiveOwners(tx, familyId)
        if (owners <= 1) throw new LastOwnerError()
      }

      const member = await tx.familyMember.update({
        where: { id: target.id },
        data: { role: data.role },
        select: MEMBER_SELECT,
      })

      const serialized = serializeMember(member)
      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "FamilyMember",
        entityId: member.id,
        before: { userId: data.userId, role: target.role },
        after: { userId: member.userId, role: member.role },
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: UPDATE_MEMBER_ROLE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedFamilyMember>(tx, {
        endpoint: UPDATE_MEMBER_ROLE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const updateMemberRoleFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("member:manage")])
  .inputValidator((data: UpdateMemberRoleInput) =>
    updateMemberRoleInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await updateMemberRoleForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
    })
  })

// ===========================================================================
// REMOVE MEMBER (soft-revoke)
// ===========================================================================

const removeMemberInputSchema = z.object({
  userId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

type RemoveMemberInput = z.input<typeof removeMemberInputSchema>

export interface RemoveMemberResult {
  success: boolean
  userId: string
  status: string
}

export async function removeMemberForFamily({
  data: rawData,
  familyId,
  actor,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: RemoveMemberInput
  familyId: string
  actor: ActorContext
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<RemoveMemberResult> {
  const data = removeMemberInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({ userId: data.userId })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<RemoveMemberResult>(
        tx,
        {
          endpoint: REMOVE_MEMBER_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      const target = await tx.familyMember.findUnique({
        where: { familyId_userId: { familyId, userId: data.userId } },
        select: { id: true, role: true, status: true },
      })
      if (!target) throw new MemberNotFoundError()

      // Idempotent: re-revoking an already-revoked member is a no-op success.
      if (target.status === "revoked") {
        const result: RemoveMemberResult = {
          success: true,
          userId: data.userId,
          status: "revoked",
        }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: REMOVE_MEMBER_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response: result,
        })
        return result
      }

      assertCanManageTarget(actor.role, target.role as FamilyRole)

      if (target.role === "owner") {
        const owners = await countActiveOwners(tx, familyId)
        if (owners <= 1) throw new LastOwnerError()
      }

      const member = await tx.familyMember.update({
        where: { id: target.id },
        data: { status: "revoked", revokedAt: new Date() },
        select: MEMBER_SELECT,
      })

      const result: RemoveMemberResult = {
        success: true,
        userId: data.userId,
        status: member.status,
      }
      await auditLog(tx, auditCtx, {
        action: "delete",
        entityType: "FamilyMember",
        entityId: member.id,
        before: {
          userId: data.userId,
          role: target.role,
          status: target.status,
        },
        after: {
          userId: member.userId,
          role: member.role,
          status: member.status,
        },
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: REMOVE_MEMBER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: result,
      })
      return result
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<RemoveMemberResult>(tx, {
        endpoint: REMOVE_MEMBER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const removeMemberFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("member:manage")])
  .inputValidator((data: RemoveMemberInput) =>
    removeMemberInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await removeMemberForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
    })
  })

// ===========================================================================
// TRANSFER OWNERSHIP (atomic promote target + demote self)
// ===========================================================================

const transferOwnershipInputSchema = z.object({
  userId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

type TransferOwnershipInput = z.input<typeof transferOwnershipInputSchema>

export async function transferOwnershipForFamily({
  data: rawData,
  familyId,
  actor,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: TransferOwnershipInput
  familyId: string
  actor: ActorContext
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedFamilyMember[]> {
  const data = transferOwnershipInputSchema.parse(rawData)
  if (data.userId === actor.id) {
    throw new MembershipForbiddenError("Cannot transfer ownership to yourself")
  }
  const requestHash = await hashCanonicalPayload({ userId: data.userId })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<
        SerializedFamilyMember[]
      >(tx, {
        endpoint: TRANSFER_OWNERSHIP_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay

      const self = await loadMemberByUserId(tx, familyId, actor.id)
      if (self.role !== "owner") {
        throw new MembershipForbiddenError(
          "Only an owner may transfer ownership"
        )
      }
      const target = await loadMemberByUserId(tx, familyId, data.userId)

      // Promote the target to owner FIRST so the family is never without one,
      // then demote self to admin. The DB last-owner trigger tolerates this
      // order (there are momentarily two owners).
      const promoted = await tx.familyMember.update({
        where: { id: target.id },
        data: { role: "owner" },
        select: MEMBER_SELECT,
      })
      const demoted = await tx.familyMember.update({
        where: { id: self.id },
        data: { role: "admin" },
        select: MEMBER_SELECT,
      })

      const serialized = [serializeMember(promoted), serializeMember(demoted)]
      await auditLogs(tx, auditCtx, [
        {
          action: "update",
          entityType: "FamilyMember",
          entityId: promoted.id,
          before: { userId: data.userId, role: target.role },
          after: { userId: promoted.userId, role: promoted.role },
        },
        {
          action: "update",
          entityType: "FamilyMember",
          entityId: demoted.id,
          before: { userId: actor.id, role: self.role },
          after: { userId: demoted.userId, role: demoted.role },
        },
      ])
      await persistIdempotentEndpointResponse(tx, {
        endpoint: TRANSFER_OWNERSHIP_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedFamilyMember[]>(tx, {
        endpoint: TRANSFER_OWNERSHIP_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const transferOwnershipFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ownership:transfer")])
  .inputValidator((data: TransferOwnershipInput) =>
    transferOwnershipInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await transferOwnershipForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
    })
  })
