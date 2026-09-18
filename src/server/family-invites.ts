import { createServerFn } from "@tanstack/react-start"
import type { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { auditLog, auditLogs, createAuditContext } from "./middleware/audit"
import {
  authMiddleware,
  requireCapability,
  scopedTenantTransaction,
  setTenantGuc,
} from "./middleware/with-family"
import { withSerializableRetry } from "./middleware/with-retry"
import type { FamilyRole } from "./middleware/authz"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import {
  isNameDedupConstraintError,
  isUniqueConstraintError,
  uuidV7Schema,
} from "./mutation-kit"
import {
  INVITE_TTL_DAYS,
  INVITE_TTL_MS,
  buildInviteAcceptUrl,
  generateInviteToken,
  hashInviteToken,
  normalizeInviteEmail,
  resolveInviteBaseUrl,
} from "./invite-token"
import type { FamilyInviteEmailInput } from "./email.server"
import { assertCanAssignRole, assertCanManageTarget } from "./family-members"

// =============================================================================
// ADR-0057 — Family invitation by email.
//
// Replaces the removed `addMemberForFamily` (email-existence oracle +
// non-consensual auto-join). An owner/admin invites an EMAIL; the recipient
// accepts explicitly, either as an existing account or by signing up through
// the link.
//
// `FamilyInvite` is deliberately NOT RLS-scoped (Family/User precedent — the
// accept lookup runs before the visitor is a member of anything), so tenant
// isolation here is enforced by hand:
//   - management paths (create/list/revoke/resend) run behind
//     `requireCapability("member:manage")` and every query carries an explicit
//     `familyId`;
//   - token paths (lookup/accept) are a bearer-capability model: possessing the
//     unguessable 256-bit token authorizes reading/accepting that one row, and
//     only sha256(token) is ever stored.
//
// Every mutation still follows the ledger-grade contract: interactive
// transaction, idempotency, append-only AuditLog in the same transaction.
// =============================================================================

export { INVITE_TTL_DAYS }

const CREATE_INVITE_ENDPOINT = "createFamilyInviteFn"
const REVOKE_INVITE_ENDPOINT = "revokeFamilyInviteFn"
const RESEND_INVITE_ENDPOINT = "resendFamilyInviteFn"

/** Name of the partial unique index enforcing one live invite per (family,email). */
const LIVE_INVITE_INDEX = "FamilyInvite_live_familyId_email_key"

const roleSchema = z.enum(["owner", "admin", "member", "viewer"])
const rawTokenSchema = z.string().trim().min(16).max(256)

// ---------------------------------------------------------------------------
// Typed errors. NOTE (PER-187): across the server-fn RPC boundary only
// `.message` survives, so every message here is written for the end user.
// ---------------------------------------------------------------------------

export class FamilyInviteError extends Error {
  override readonly name: string = "FamilyInviteError"
  readonly statusCode: number = 400
}

export type InviteUnavailableReason =
  | "not_found"
  | "expired"
  | "revoked"
  | "accepted"

const UNAVAILABLE_MESSAGES: Record<InviteUnavailableReason, string> = {
  not_found: "This invitation link is not valid.",
  expired:
    "This invitation has expired. Ask the family owner to send a new one.",
  revoked:
    "This invitation was cancelled. Ask the family owner to send a new one.",
  accepted: "This invitation has already been used.",
}

/** The token is unknown, expired, revoked, or already used. */
export class InviteUnavailableError extends FamilyInviteError {
  override readonly name = "InviteUnavailableError"
  override readonly statusCode = 410
  constructor(readonly reason: InviteUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason])
  }
}

/** The signed-in account's email is not the address the invite was sent to. */
export class InviteEmailMismatchError extends FamilyInviteError {
  override readonly name = "InviteEmailMismatchError"
  override readonly statusCode = 403
  constructor() {
    super(
      "This invitation was sent to a different email address. Sign in with the invited address to accept it."
    )
  }
}

/** The accepting user already belongs to a DIFFERENT family (single-family model). */
export class InviteFamilyConflictError extends FamilyInviteError {
  override readonly name = "InviteFamilyConflictError"
  override readonly statusCode = 409
  constructor() {
    super(
      "You already belong to another family. Leave that family before accepting this invitation."
    )
  }
}

/** The email already belongs to an ACTIVE member of the inviting family. */
export class InviteAlreadyMemberError extends FamilyInviteError {
  override readonly name = "InviteAlreadyMemberError"
  override readonly statusCode = 409
  constructor() {
    super("This email already belongs to a member of your family.")
  }
}

/** Management path: no such invite in this family (also for other families' ids). */
export class InviteNotFoundError extends FamilyInviteError {
  override readonly name = "InviteNotFoundError"
  override readonly statusCode = 404
  constructor() {
    super("Invitation not found.")
  }
}

/** Management path: the invite can no longer be changed (accepted or revoked). */
export class InviteNotPendingError extends FamilyInviteError {
  override readonly name = "InviteNotPendingError"
  override readonly statusCode = 409
  constructor(message = "This invitation is no longer pending.") {
    super(message)
  }
}

/** Two invites for the same (family, email) raced; the index rejected one. */
export class InviteConflictError extends FamilyInviteError {
  override readonly name = "InviteConflictError"
  override readonly statusCode = 409
  constructor() {
    super("Another invitation for this email is being created. Try again.")
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedFamilyInvite {
  id: string
  email: string
  role: string
  /** `expired` = still unrevoked/unaccepted but past `expiresAt` (resendable). */
  status: "pending" | "expired"
  invitedByName: string
  createdAt: string
  expiresAt: string
}

interface InviteRow {
  id: string
  email: string
  role: string
  createdAt: Date
  expiresAt: Date
  invitedBy: { name: string; email: string }
}

const INVITE_SELECT = {
  id: true,
  email: true,
  role: true,
  createdAt: true,
  expiresAt: true,
  invitedBy: { select: { name: true, email: true } },
} as const

function displayName(user: { name: string; email: string }): string {
  return user.name.trim() || user.email
}

function serializeInvite(row: InviteRow, now: Date): SerializedFamilyInvite {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.expiresAt.getTime() > now.getTime() ? "pending" : "expired",
    invitedByName: displayName(row.invitedBy),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

interface ActorContext {
  id: string
  role: FamilyRole
}

type RunInTenantTransaction = typeof scopedTenantTransaction
type SendInviteEmail = (input: FamilyInviteEmailInput) => Promise<void>

// Imported lazily so this module (client-reachable through the server-fn
// wrappers) never statically pulls the server-only `resend` SDK.
const defaultSendInviteEmail: SendInviteEmail = async (input) => {
  const { sendFamilyInviteEmail } = await import("./email.server")
  await sendFamilyInviteEmail(input)
}

async function enforceInviteRateLimit(userId: string): Promise<void> {
  const { checkInviteRateLimit } = await import("./middleware/rate-limit")
  await checkInviteRateLimit(userId)
}

// ===========================================================================
// CREATE
// ===========================================================================

const createInviteInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: roleSchema.default("member"),
  idempotencyKey: uuidV7Schema,
})

type CreateInviteInput = z.input<typeof createInviteInputSchema>

/**
 * Creates (or supersedes) an email invitation and sends the link.
 *
 * The response is UNIFORM: it never depends on whether the email already has a
 * Permoney account — that is the oracle fix. The only lookup against existing
 * users is tenant-scoped (is this email already an ACTIVE member of THIS
 * family?), which reveals nothing the inviter cannot see in their own member
 * list.
 *
 * Email delivery runs INSIDE the transaction on purpose (ADR-0057): a failed
 * send throws out of the transaction and rolls the invite row back, so a
 * "sent" invite always corresponds to an email that Resend accepted. The
 * converse — a commit failure AFTER a successful send — leaves a harmless dead
 * link, because the token hash it carried was never persisted. A serialization
 * retry likewise mints a fresh token and re-sends; the earlier link is dead.
 */
export async function createFamilyInviteForFamily({
  data: rawData,
  familyId,
  actor,
  acceptBaseUrl,
  runInTenantTransaction = scopedTenantTransaction,
  sendInviteEmail = defaultSendInviteEmail,
  now = () => new Date(),
}: {
  data: CreateInviteInput
  familyId: string
  actor: ActorContext
  /** Canonical origin the accept link is built on (see `resolveInviteBaseUrl`). */
  acceptBaseUrl: string
  runInTenantTransaction?: RunInTenantTransaction
  sendInviteEmail?: SendInviteEmail
  now?: () => Date
}): Promise<SerializedFamilyInvite> {
  const data = createInviteInputSchema.parse(rawData)
  const email = normalizeInviteEmail(data.email)
  // Only owners may mint admin/owner invites; admins may invite member/viewer.
  assertCanAssignRole(actor.role, data.role)
  await enforceInviteRateLimit(actor.id)

  const requestHash = await hashCanonicalPayload({ email, role: data.role })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedFamilyInvite>(tx, {
          endpoint: CREATE_INVITE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      // Tenant-scoped ONLY: a join through FamilyMember pinned to this family.
      // Never a global User lookup — account existence elsewhere is not
      // observable through this endpoint.
      const existingMember = await tx.familyMember.findFirst({
        where: {
          familyId,
          status: "active",
          user: { email: { equals: email, mode: "insensitive" } },
        },
        select: { id: true },
      })
      if (existingMember) throw new InviteAlreadyMemberError()

      const at = now()

      // Re-inviting an email supersedes any earlier live link — including an
      // expired-but-unrevoked one (the partial unique index counts it as live).
      const superseded = await tx.familyInvite.findMany({
        where: { familyId, email, acceptedAt: null, revokedAt: null },
        select: { id: true, expiresAt: true },
      })
      if (superseded.length > 0) {
        await tx.familyInvite.updateMany({
          where: { id: { in: superseded.map((invite) => invite.id) } },
          data: { revokedAt: at },
        })
        await auditLogs(
          tx,
          auditCtx,
          superseded.map((invite) => ({
            action: "update" as const,
            entityType: "FamilyInvite",
            entityId: invite.id,
            before: { email, revokedAt: null },
            after: { email, revokedAt: at, reason: "superseded" },
          }))
        )
      }

      // Sequential on purpose: one interactive-transaction connection, and
      // pg rejects overlapping queries on it (see with-family.ts).
      const family = await tx.family.findUniqueOrThrow({
        where: { id: familyId },
        select: { name: true },
      })
      const inviter = await tx.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: { name: true, email: true },
      })

      const rawToken = generateInviteToken()
      const invite = await tx.familyInvite.create({
        data: {
          familyId,
          email,
          role: data.role,
          tokenHash: await hashInviteToken(rawToken),
          invitedById: actor.id,
          expiresAt: new Date(at.getTime() + INVITE_TTL_MS),
        },
        select: INVITE_SELECT,
      })

      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "FamilyInvite",
        entityId: invite.id,
        before: null,
        after: {
          email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
      })

      await sendInviteEmail({
        to: email,
        familyName: family.name,
        inviterName: displayName(inviter),
        acceptUrl: buildInviteAcceptUrl(acceptBaseUrl, rawToken),
        expiresInDays: INVITE_TTL_DAYS,
      })

      const serialized = serializeInvite(invite, at)
      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_INVITE_ENDPOINT,
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
    if (isNameDedupConstraintError(error, LIVE_INVITE_INDEX)) {
      throw new InviteConflictError()
    }
    if (!isUniqueConstraintError(error)) throw error
    const replay = await runInTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedFamilyInvite>(tx, {
        endpoint: CREATE_INVITE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const createFamilyInviteFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("member:manage")])
  .inputValidator((data: CreateInviteInput) =>
    createInviteInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const { getRequest } = await import("@tanstack/react-start/server")
    return await createFamilyInviteForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
      acceptBaseUrl: resolveInviteBaseUrl(getRequest().url),
    })
  })

// ===========================================================================
// LIST (pending + expired-unrevoked)
// ===========================================================================

export async function listFamilyInvitesForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
  now = () => new Date(),
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
  now?: () => Date
}): Promise<SerializedFamilyInvite[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    // Explicit familyId: FamilyInvite has no RLS, this WHERE IS the isolation.
    const rows = await tx.familyInvite.findMany({
      where: { familyId, acceptedAt: null, revokedAt: null },
      select: INVITE_SELECT,
      orderBy: { createdAt: "desc" },
    })
    const at = now()
    return rows.map((row) => serializeInvite(row, at))
  })
}

export const listFamilyInvitesFn = createServerFn({ method: "GET" })
  .middleware([requireCapability("member:manage")])
  .handler(async ({ context }) => {
    return await listFamilyInvitesForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// REVOKE
// ===========================================================================

const revokeInviteInputSchema = z.object({
  inviteId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

type RevokeInviteInput = z.input<typeof revokeInviteInputSchema>

export interface RevokeInviteResult {
  success: boolean
  inviteId: string
}

export async function revokeFamilyInviteForFamily({
  data: rawData,
  familyId,
  actor,
  runInTenantTransaction = scopedTenantTransaction,
  now = () => new Date(),
}: {
  data: RevokeInviteInput
  familyId: string
  actor: ActorContext
  runInTenantTransaction?: RunInTenantTransaction
  now?: () => Date
}): Promise<RevokeInviteResult> {
  const data = revokeInviteInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({ inviteId: data.inviteId })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<RevokeInviteResult>(
        tx,
        {
          endpoint: REVOKE_INVITE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      // Scoped by familyId: another family's invite id is indistinguishable
      // from a nonexistent one.
      const invite = await tx.familyInvite.findFirst({
        where: { id: data.inviteId, familyId },
        select: {
          id: true,
          email: true,
          role: true,
          acceptedAt: true,
          revokedAt: true,
        },
      })
      if (!invite) throw new InviteNotFoundError()
      if (invite.acceptedAt) {
        throw new InviteNotPendingError(
          "This invitation was already accepted and cannot be cancelled."
        )
      }
      assertCanManageTarget(actor.role, invite.role as FamilyRole)

      const result: RevokeInviteResult = {
        success: true,
        inviteId: invite.id,
      }
      // Idempotent: re-revoking an already-revoked invite is a no-op success.
      if (!invite.revokedAt) {
        const at = now()
        await tx.familyInvite.update({
          where: { id: invite.id },
          data: { revokedAt: at },
        })
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "FamilyInvite",
          entityId: invite.id,
          before: { email: invite.email, revokedAt: null },
          after: { email: invite.email, revokedAt: at, reason: "revoked" },
        })
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: REVOKE_INVITE_ENDPOINT,
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
    const replay = await runInTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<RevokeInviteResult>(tx, {
        endpoint: REVOKE_INVITE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const revokeFamilyInviteFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("member:manage")])
  .inputValidator((data: RevokeInviteInput) =>
    revokeInviteInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await revokeFamilyInviteForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
    })
  })

// ===========================================================================
// RESEND (regenerates the token + expiry; the old link dies)
// ===========================================================================

const resendInviteInputSchema = revokeInviteInputSchema

type ResendInviteInput = z.input<typeof resendInviteInputSchema>

export async function resendFamilyInviteForFamily({
  data: rawData,
  familyId,
  actor,
  acceptBaseUrl,
  runInTenantTransaction = scopedTenantTransaction,
  sendInviteEmail = defaultSendInviteEmail,
  now = () => new Date(),
}: {
  data: ResendInviteInput
  familyId: string
  actor: ActorContext
  acceptBaseUrl: string
  runInTenantTransaction?: RunInTenantTransaction
  sendInviteEmail?: SendInviteEmail
  now?: () => Date
}): Promise<SerializedFamilyInvite> {
  const data = resendInviteInputSchema.parse(rawData)
  await enforceInviteRateLimit(actor.id)

  const requestHash = await hashCanonicalPayload({ inviteId: data.inviteId })
  const auditCtx = await createAuditContext(
    { user: { id: actor.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, actor.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedFamilyInvite>(tx, {
          endpoint: RESEND_INVITE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const existing = await tx.familyInvite.findFirst({
        where: { id: data.inviteId, familyId },
        select: {
          id: true,
          email: true,
          role: true,
          acceptedAt: true,
          revokedAt: true,
          expiresAt: true,
        },
      })
      if (!existing) throw new InviteNotFoundError()
      if (existing.acceptedAt || existing.revokedAt) {
        throw new InviteNotPendingError(
          "Only a pending invitation can be re-sent. Create a new invitation instead."
        )
      }
      assertCanManageTarget(actor.role, existing.role as FamilyRole)

      const at = now()
      const rawToken = generateInviteToken()
      const invite = await tx.familyInvite.update({
        where: { id: existing.id },
        data: {
          tokenHash: await hashInviteToken(rawToken),
          expiresAt: new Date(at.getTime() + INVITE_TTL_MS),
        },
        select: INVITE_SELECT,
      })
      const family = await tx.family.findUniqueOrThrow({
        where: { id: familyId },
        select: { name: true },
      })

      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "FamilyInvite",
        entityId: invite.id,
        before: { email: existing.email, expiresAt: existing.expiresAt },
        after: {
          email: invite.email,
          expiresAt: invite.expiresAt,
          reason: "resent",
        },
      })

      // Inside the transaction on purpose — see createFamilyInviteForFamily.
      // A failed send rolls the token rotation back, so the previously emailed
      // link keeps working rather than being killed by an email that never left.
      await sendInviteEmail({
        to: invite.email,
        familyName: family.name,
        inviterName: displayName(invite.invitedBy),
        acceptUrl: buildInviteAcceptUrl(acceptBaseUrl, rawToken),
        expiresInDays: INVITE_TTL_DAYS,
      })

      const serialized = serializeInvite(invite, at)
      await persistIdempotentEndpointResponse(tx, {
        endpoint: RESEND_INVITE_ENDPOINT,
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
    const replay = await runInTenantTransaction(familyId, actor.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedFamilyInvite>(tx, {
        endpoint: RESEND_INVITE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const resendFamilyInviteFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("member:manage")])
  .inputValidator((data: ResendInviteInput) =>
    resendInviteInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const { getRequest } = await import("@tanstack/react-start/server")
    return await resendFamilyInviteForFamily({
      data,
      familyId: context.familyId,
      actor: { id: context.user.id, role: context.role },
      acceptBaseUrl: resolveInviteBaseUrl(getRequest().url),
    })
  })

// ===========================================================================
// TOKEN LOOKUP (public — bearer capability)
// ===========================================================================

export type InviteLookup =
  | {
      status: "valid"
      email: string
      role: string
      familyName: string
      inviterName: string
      expiresAt: string
    }
  | { status: InviteUnavailableReason }

/**
 * Resolves a raw token to its invite's public state. `familyId` is returned
 * separately (never sent to the browser) so the server fn can compute the
 * viewer's conflict state.
 */
export async function lookupFamilyInviteByToken(
  client: Pick<PrismaClient, "familyInvite">,
  rawToken: string,
  now: Date = new Date()
): Promise<{ invite: InviteLookup; familyId: string | null }> {
  const invite = await client.familyInvite.findUnique({
    where: { tokenHash: await hashInviteToken(rawToken) },
    select: {
      familyId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      family: { select: { name: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  })
  if (!invite) return { invite: { status: "not_found" }, familyId: null }
  const unavailable = classifyInvite(invite, now)
  if (unavailable) {
    return { invite: { status: unavailable }, familyId: invite.familyId }
  }
  return {
    familyId: invite.familyId,
    invite: {
      status: "valid",
      email: invite.email,
      role: invite.role,
      familyName: invite.family.name,
      inviterName: displayName(invite.invitedBy),
      expiresAt: invite.expiresAt.toISOString(),
    },
  }
}

function classifyInvite(
  invite: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null },
  now: Date
): Exclude<InviteUnavailableReason, "not_found"> | null {
  if (invite.acceptedAt) return "accepted"
  if (invite.revokedAt) return "revoked"
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired"
  return null
}

const lookupInviteInputSchema = z.object({ token: rawTokenSchema })

export interface InviteViewer {
  authenticated: boolean
  /** The signed-in account's own email (never anyone else's). */
  email: string | null
  emailMatches: boolean
  /** Signed in, matching email, but already in a DIFFERENT family. */
  familyConflict: boolean
}

// POST (not GET): a server-fn GET carries its payload in the URL, and the raw
// token must stay out of access logs and browser history beyond the page URL
// the invitee already opened.
export const getInviteByTokenFn = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string }) =>
    lookupInviteInputSchema.parse(data)
  )
  .handler(
    async ({
      data,
    }): Promise<{ invite: InviteLookup; viewer: InviteViewer }> => {
      const [{ getRequest }, { checkRateLimit }, { prisma }, { getSession }] =
        await Promise.all([
          import("@tanstack/react-start/server"),
          import("./middleware/rate-limit"),
          import("./db.server"),
          import("./middleware/session"),
        ])
      // Unauthenticated endpoint: throttle per client IP (30 / 15 min).
      await checkRateLimit(getRequest(), undefined, "invite_lookup")

      const { invite, familyId } = await lookupFamilyInviteByToken(
        prisma,
        data.token
      )
      const session = await getSession()
      const viewerEmail = session?.user.email ?? null
      const emailMatches =
        invite.status === "valid" &&
        viewerEmail !== null &&
        normalizeInviteEmail(viewerEmail) === normalizeInviteEmail(invite.email)
      const viewerFamilyId = (
        session?.user as { familyId?: string | null } | undefined
      )?.familyId
      return {
        invite,
        viewer: {
          authenticated: session !== null,
          email: viewerEmail,
          emailMatches,
          familyConflict:
            emailMatches && !!viewerFamilyId && viewerFamilyId !== familyId,
        },
      }
    }
  )

// ===========================================================================
// ACCEPT (shared core: existing-account accept + post-signup accept)
// ===========================================================================

export interface AcceptFamilyInviteResult {
  familyId: string
  role: string
  /** True when the invite was already accepted by this user (a replay: no writes). */
  alreadyAccepted: boolean
}

interface LockedUser {
  id: string
  email: string
  familyId: string | null
}

interface LockedInvite {
  id: string
  familyId: string
  email: string
  role: string
  createdAt: Date
  invitedById: string
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
}

/**
 * The single accept implementation, used by `acceptFamilyInviteFn` (existing
 * account) and by `applyInviteAfterSignup` (fresh account). It takes only a
 * `userId` and re-reads that user's email from the locked DB row, so neither
 * caller can assert an email it does not actually hold.
 *
 * One serializable transaction (mirrors `initializeOnboardingForUser`): lock the
 * user row, lock the invite row, validate, set the tenant GUC to the INVITE's
 * family, upsert the FamilyMember active, point `User.familyId` at it, stamp
 * `acceptedAt`, and write the AuditLog rows.
 *
 * Replay-safety is state-based rather than key-based: the invite row is locked
 * and stamped `acceptedAt`, so a second accept (double click, retry, two tabs)
 * finds it accepted; if the same user is already the active member it returns
 * `alreadyAccepted: true` without writing anything, otherwise the link is dead.
 * `idempotencyKey`, when supplied, is recorded on the audit rows only.
 */
export async function acceptFamilyInviteForUser(
  client: PrismaClient,
  {
    userId,
    rawToken,
    idempotencyKey,
    now = () => new Date(),
  }: {
    userId: string
    rawToken: string
    idempotencyKey?: string | null
    now?: () => Date
  }
): Promise<AcceptFamilyInviteResult> {
  const token = rawTokenSchema.parse(rawToken)
  const tokenHash = await hashInviteToken(token)
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId: null } },
    idempotencyKey ?? null
  )

  return await withSerializableRetry(client, async (tx) => {
    const users = await tx.$queryRaw<LockedUser[]>`
      SELECT id, email, "familyId"
      FROM "User"
      WHERE id = ${userId}
      FOR UPDATE
    `
    const user = users[0]
    if (!user) {
      throw Object.assign(new Error("User not found"), {
        code: "USER_NOT_FOUND",
        status: 404,
      })
    }

    const invites = await tx.$queryRaw<LockedInvite[]>`
      SELECT id, "familyId", email, role, "createdAt", "invitedById",
             "expiresAt", "acceptedAt", "revokedAt"
      FROM "FamilyInvite"
      WHERE "tokenHash" = ${tokenHash}
      FOR UPDATE
    `
    const invite = invites[0]
    if (!invite) throw new InviteUnavailableError("not_found")

    if (
      normalizeInviteEmail(user.email) !== normalizeInviteEmail(invite.email)
    ) {
      throw new InviteEmailMismatchError()
    }

    // The invite's family scopes everything below (FamilyMember + AuditLog RLS).
    await setTenantGuc(tx, invite.familyId, user.id)

    const existingMember = await tx.familyMember.findUnique({
      where: {
        familyId_userId: { familyId: invite.familyId, userId: user.id },
      },
      select: { id: true, role: true, status: true },
    })
    const isActiveMember = existingMember?.status === "active"

    if (invite.acceptedAt) {
      if (isActiveMember && user.familyId === invite.familyId) {
        return {
          familyId: invite.familyId,
          role: existingMember.role,
          alreadyAccepted: true,
        }
      }
      throw new InviteUnavailableError("accepted")
    }

    const at = now()
    const unavailable = classifyInvite(invite, at)
    if (unavailable) throw new InviteUnavailableError(unavailable)

    // Single-family-per-user: joining a second family is refused, honestly.
    if (user.familyId && user.familyId !== invite.familyId) {
      throw new InviteFamilyConflictError()
    }

    // An already-ACTIVE member keeps their current role (an invite must never
    // silently up- or down-grade someone who is already in); otherwise the
    // membership row is created or re-activated with the invited role.
    const member = isActiveMember
      ? existingMember
      : await tx.familyMember.upsert({
          where: {
            familyId_userId: { familyId: invite.familyId, userId: user.id },
          },
          update: {
            role: invite.role,
            status: "active",
            revokedAt: null,
            joinedAt: at,
            invitedById: invite.invitedById,
          },
          create: {
            familyId: invite.familyId,
            userId: user.id,
            role: invite.role,
            status: "active",
            invitedAt: invite.createdAt,
            joinedAt: at,
            invitedById: invite.invitedById,
          },
          select: { id: true, role: true, status: true },
        })

    if (user.familyId !== invite.familyId) {
      await tx.user.update({
        where: { id: user.id },
        data: { familyId: invite.familyId },
      })
    }
    await tx.familyInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: at },
    })

    await auditLogs(tx, auditCtx, [
      ...(isActiveMember
        ? []
        : [
            {
              action: existingMember
                ? ("update" as const)
                : ("create" as const),
              entityType: "FamilyMember",
              entityId: member.id,
              familyId: invite.familyId,
              before: existingMember
                ? { role: existingMember.role, status: existingMember.status }
                : null,
              after: { userId: user.id, role: member.role, status: "active" },
            },
          ]),
      ...(user.familyId === invite.familyId
        ? []
        : [
            {
              action: "update" as const,
              entityType: "User",
              entityId: user.id,
              familyId: invite.familyId,
              before: { familyId: user.familyId },
              after: { familyId: invite.familyId },
            },
          ]),
      {
        action: "update" as const,
        entityType: "FamilyInvite",
        entityId: invite.id,
        familyId: invite.familyId,
        before: { email: invite.email, acceptedAt: null },
        after: { email: invite.email, acceptedAt: at, reason: "accepted" },
      },
    ])

    return {
      familyId: invite.familyId,
      role: member.role,
      alreadyAccepted: false,
    }
  })
}

const acceptInviteInputSchema = z.object({
  token: rawTokenSchema,
  idempotencyKey: uuidV7Schema.optional(),
})

type AcceptInviteInput = z.input<typeof acceptInviteInputSchema>

// Needs a session but NOT an existing membership (the accepting user may have
// no family yet), so this is `authMiddleware`, never `familyMiddleware`.
export const acceptFamilyInviteFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: AcceptInviteInput) =>
    acceptInviteInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const { prisma } = await import("./db.server")
    return await acceptFamilyInviteForUser(prisma, {
      userId: context.user.id,
      rawToken: data.token,
      idempotencyKey: data.idempotencyKey,
    })
  })

/**
 * Signup glue: try to apply an invite to a freshly created account. NEVER
 * throws and never blocks signup — a token that is stale, mismatched with the
 * signup email, or otherwise unusable is ignored and the caller proceeds as a
 * normal signup (the invite, if still live, can be accepted later from the
 * link). Returns whether the invite was actually applied.
 */
export async function applyInviteAfterSignup(
  client: PrismaClient,
  { userId, rawToken }: { userId: string; rawToken: string }
): Promise<boolean> {
  try {
    await acceptFamilyInviteForUser(client, { userId, rawToken })
    return true
  } catch (error) {
    if (
      !(error instanceof FamilyInviteError) &&
      !(error instanceof z.ZodError)
    ) {
      // Unexpected failure: surface the class only — never the token.
      console.error(
        "[family-invites] applying an invite after signup failed unexpectedly:",
        error instanceof Error ? error.name : "unknown error"
      )
    }
    return false
  }
}
