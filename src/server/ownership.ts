import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { holdingValueMinor, quantityToScaled } from "@/lib/holdings"
import type { OwnerRef } from "@/lib/ownership"
import { auditLog, type AuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import {
  isUniqueConstraintError,
  type RunInTenantTransaction,
} from "./mutation-kit"
import { TenantReferenceError } from "./validation/tenant-references"

// =============================================================================
// ADR-0058 D1 — owner resolution.
//
// A "person" is the existing `ZakatPayer` row. Ownership inputs (account
// owner, joint owner, holding owner) are `OwnerRef`s: `{ personId }` for an
// existing person, or `{ memberUserId }` for an ACTIVE member of this family
// who may not have a person row yet. `resolveOwnerRefWithinTx` turns either
// into a person id, get-or-creating the member's person INSIDE the caller's
// transaction — no backfill migration, no "add payer" chore before an owner
// can be assigned.
//
// One person per user is a durable DB invariant, not request timing:
// `ZakatPayer.linkedUserId` carries a UNIQUE index (ADR-0056 migration).
// Concurrent first-time resolutions of the same member therefore cannot mint
// two people; the loser is retried and finds the winner's row.
// =============================================================================

export const ownerRefSchema = z.union([
  z.object({ personId: z.string().min(1) }).strict(),
  z.object({ memberUserId: z.string().min(1) }).strict(),
])

export class OwnerMemberNotActiveError extends Error {
  override readonly name = "OwnerMemberNotActiveError"
  readonly statusCode = 404
  constructor(readonly memberUserId: string) {
    super(
      `User ${memberUserId} is not an active member of this family — only an ` +
        `active member can be assigned as an owner`
    )
  }
}

export class OwnerLinkConflictError extends Error {
  override readonly name = "OwnerLinkConflictError"
  readonly statusCode = 409
  constructor(readonly memberUserId: string) {
    super(
      `User ${memberUserId} is already linked to a person outside this family; ` +
        `unlink that person before assigning this member as an owner`
    )
  }
}

/** Two refs denote the same owner when they are structurally identical. */
export function ownerRefsEqual(a: OwnerRef, b: OwnerRef): boolean {
  if ("personId" in a && "personId" in b) return a.personId === b.personId
  if ("memberUserId" in a && "memberUserId" in b) {
    return a.memberUserId === b.memberUserId
  }
  return false
}

export interface ResolveOwnerRefContext {
  familyId: string
  auditCtx: AuditContext
}

/**
 * Resolves an `OwnerRef` to a person id inside the caller's tenant
 * transaction (RLS GUCs already set by `scopedTenantTransaction`).
 *
 * - `{ personId }`: must be a person of THIS family (foreign keys alone are
 *   not tenant isolation) else `TenantReferenceError`.
 * - `{ memberUserId }`: must be an ACTIVE member of THIS family else
 *   `OwnerMemberNotActiveError`; then the person linked to that user is
 *   returned, created (and audited) in this same transaction if absent.
 */
export async function resolveOwnerRefWithinTx(
  tx: TenantTransactionClient,
  { familyId, auditCtx }: ResolveOwnerRefContext,
  ref: OwnerRef,
  field: string
): Promise<string> {
  if ("personId" in ref) {
    const row = await tx.zakatPayer.findFirst({
      where: { id: ref.personId, familyId },
      select: { id: true },
    })
    if (!row) throw new TenantReferenceError(field, ref.personId, familyId)
    return row.id
  }

  const memberPerson = await getOrCreatePersonForActiveMember(
    tx,
    { familyId, auditCtx },
    ref.memberUserId,
    "owner_resolver"
  )
  if (memberPerson.created && memberPerson.wasFirstPerson) {
    // ADR-0056 default-behavior rule: with exactly ONE person, Zakat runs in
    // single-payer mode and counts EVERY account 100% toward that person. If
    // the first person on-demand-created were the spouse, the household
    // head's implicit "Me" would silently become the spouse. So the first
    // on-demand person is never created alone: the acting member (the
    // implicit "Me" until now) gets their own person in the same
    // transaction, which puts the family in multi-payer mode where untagged
    // accounts are excluded and listed, never mis-attributed.
    const actorId = auditCtx.session.user.id
    if (actorId !== ref.memberUserId) {
      await getOrCreatePersonForActiveMember(
        tx,
        { familyId, auditCtx },
        actorId,
        "owner_resolver_actor"
      )
    }
  }
  return memberPerson.id
}

interface MemberPerson {
  id: string
  /** This call created the row (it did not exist before). */
  created: boolean
  /** The family had no people at all before this call created one. */
  wasFirstPerson: boolean
}

async function getOrCreatePersonForActiveMember(
  tx: TenantTransactionClient,
  { familyId, auditCtx }: ResolveOwnerRefContext,
  memberUserId: string,
  source: "owner_resolver" | "owner_resolver_actor"
): Promise<MemberPerson> {
  const member = await tx.familyMember.findFirst({
    where: { familyId, userId: memberUserId, status: "active" },
    select: { user: { select: { name: true, email: true } } },
  })
  if (!member) throw new OwnerMemberNotActiveError(memberUserId)

  const existing = await tx.zakatPayer.findFirst({
    where: { familyId, linkedUserId: memberUserId },
    select: { id: true },
  })
  if (existing) {
    return { id: existing.id, created: false, wasFirstPerson: false }
  }

  const wasFirstPerson =
    (await tx.zakatPayer.count({ where: { familyId } })) === 0
  const displayName =
    member.user.name.trim() || member.user.email.split("@")[0] || "Member"
  // Native upsert on the unique `linkedUserId`: under Serializable a
  // concurrent first-time resolution surfaces as a serialization failure
  // (retried by `scopedTenantTransaction`) or a unique violation (retried by
  // `retryOnOwnerLinkRace`) — never as a second person for the same user.
  const created = await tx.zakatPayer.upsert({
    where: { linkedUserId: memberUserId },
    create: { familyId, displayName, linkedUserId: memberUserId },
    update: {},
    select: { id: true, familyId: true, displayName: true, linkedUserId: true },
  })
  if (created.familyId !== familyId) {
    throw new OwnerLinkConflictError(memberUserId)
  }
  await auditLog(tx, auditCtx, {
    action: "create",
    entityType: "ZakatPayer",
    entityId: created.id,
    after: {
      id: created.id,
      displayName: created.displayName,
      linkedUserId: created.linkedUserId,
      source,
    },
  })
  return { id: created.id, created: true, wasFirstPerson }
}

function isOwnerLinkRace(error: unknown): boolean {
  if (!isUniqueConstraintError(error)) return false
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  if (typeof target === "string") return target.includes("linkedUserId")
  if (Array.isArray(target)) {
    return target.some(
      (t) => typeof t === "string" && t.includes("linkedUserId")
    )
  }
  return false
}

/**
 * Re-runs `run` once when it lost a first-time member->person creation race
 * (unique violation on `linkedUserId`). The retry opens a fresh transaction
 * that finds the winner's row. Any other error propagates untouched.
 */
export async function retryOnOwnerLinkRace<T>(
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isOwnerLinkRace(error)) throw error
    return await run()
  }
}

// -----------------------------------------------------------------------------
// Owner candidates — what the owner selects offer.
// -----------------------------------------------------------------------------

export interface OwnerCandidate {
  /** Reference to send back to the server when this candidate is chosen. */
  ref: OwnerRef
  displayName: string
  /** `member`: an active member with no person row yet (created on demand). */
  kind: "person" | "member"
  /** The person is linked to an active member of this family. */
  isMember: boolean
}

export interface OwnerCandidatesResult {
  activeMemberCount: number
  peopleCount: number
  candidates: OwnerCandidate[]
}

export async function listOwnerCandidatesForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<OwnerCandidatesResult> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const members = await tx.familyMember.findMany({
      where: { familyId, status: "active" },
      select: { userId: true, user: { select: { name: true, email: true } } },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    })
    const people = await tx.zakatPayer.findMany({
      where: { familyId },
      select: { id: true, displayName: true, linkedUserId: true },
      orderBy: { id: "asc" },
    })
    const activeMemberIds = new Set(members.map((m) => m.userId))
    const linkedMemberIds = new Set(
      people.flatMap((p) => (p.linkedUserId ? [p.linkedUserId] : []))
    )

    const candidates: OwnerCandidate[] = [
      // Members first (the household), whether or not they have a person yet.
      ...members.flatMap((m): OwnerCandidate[] => {
        if (linkedMemberIds.has(m.userId)) return []
        return [
          {
            ref: { memberUserId: m.userId },
            displayName: m.user.name.trim() || m.user.email,
            kind: "member",
            isMember: true,
          },
        ]
      }),
      ...people.map(
        (p): OwnerCandidate => ({
          ref: { personId: p.id },
          displayName: p.displayName,
          kind: "person",
          isMember:
            p.linkedUserId !== null && activeMemberIds.has(p.linkedUserId),
        })
      ),
    ]
    return {
      activeMemberCount: members.length,
      peopleCount: people.length,
      candidates,
    }
  })
}

export const listOwnerCandidatesFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await listOwnerCandidatesForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// Wealth-by-person inputs (ADR-0058 D3). A pure READ — derived on read, no
// persistence, no idempotency key or audit row (like `computeZakatFn` and the
// reporting reads). The attribution itself lives in `src/lib/wealth-by-person.ts`
// and runs client-side over the SAME account records the net-worth card uses;
// this only supplies what the account list does not carry: the people, and the
// value of every holding that has its own owner.
// -----------------------------------------------------------------------------

export interface WealthOwnershipInputs {
  people: Array<{ id: string; displayName: string }>
  /** Holdings WITH an owner only; value in the account's currency, minor units. */
  ownedHoldings: Array<{
    accountId: string
    ownerPersonId: string
    valueMinor: string
  }>
}

export async function getWealthOwnershipInputsForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<WealthOwnershipInputs> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const people = await tx.zakatPayer.findMany({
      where: { familyId },
      select: { id: true, displayName: true },
      orderBy: { id: "asc" },
    })
    const holdings = await tx.holding.findMany({
      where: { familyId, ownerPersonId: { not: null } },
      select: {
        accountId: true,
        ownerPersonId: true,
        quantity: true,
        avgUnitCostMinor: true,
        lastPriceMinor: true,
      },
      orderBy: { id: "asc" },
    })
    return {
      people,
      ownedHoldings: holdings.flatMap((h) =>
        h.ownerPersonId === null
          ? []
          : [
              {
                accountId: h.accountId,
                ownerPersonId: h.ownerPersonId,
                // Same value formula as `serializeHolding` (src/server/holdings.ts).
                valueMinor: holdingValueMinor(
                  quantityToScaled(h.quantity.toFixed(8)),
                  h.lastPriceMinor ?? h.avgUnitCostMinor
                ).toString(),
              },
            ]
      ),
    }
  })
}

export const getWealthOwnershipInputsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getWealthOwnershipInputsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
