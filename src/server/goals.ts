import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  assertKnownCurrency,
  currentPriceMinor,
  decimalStringSchema,
  fetchActiveAccount,
  HoldingError,
  loadHoldingWithInstrument,
  positiveMinorDigitsSchema,
  type HoldingWithInstrument,
} from "./holdings"
import {
  quantityToScaled,
  scaledToQuantityString,
  unitsFromAmountScaled,
} from "@/lib/holdings"
import {
  auditLog,
  createAuditContext,
  type AuditContext,
} from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import {
  isUniqueConstraintError,
  uuidV7Schema,
  type RunInTenantTransaction,
} from "./mutation-kit"
import type { ServerActor } from "./valuations"

// =============================================================================
// Goal — broker-agnostic PURPOSE grouping (Bibit "Portofolio" / Betterment
// "Goals" / M1 "Pies" generalized), orthogonal to Account (custody/WHERE).
// See the `model Goal` comment in prisma/schema.prisma for the full rationale.
//
// Linking or reassigning an Account/Holding to a Goal is PURE relabeling —
// it changes no units, no cost basis, no cash, so it NEVER writes a ledger
// Transaction. Every mutation still writes an append-only AuditLog row
// (entityType "GoalAllocation"), read back through the typed, Zod-validated
// `listHoldingGoalHistoryForFamily` projection below — mirroring the existing
// Switch/Distribution "position event" pattern in src/server/holdings.ts —
// rather than a physical CQRS table, which would be premature infrastructure
// at this app's scale (a personal/family ledger, not a high-throughput system).
// =============================================================================

class GoalError extends HoldingError {}

const riskProfileSchema = z.enum(["conservative", "moderate", "aggressive"])

export interface SerializedGoal {
  id: string
  name: string
  description: string | null
  targetAmountMinor: string | null
  targetCurrency: string | null
  targetDate: string | null
  riskProfile: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

function serializeGoal(goal: {
  id: string
  name: string
  description: string | null
  targetAmountMinor: bigint | null
  targetCurrency: string | null
  targetDate: Date | null
  riskProfile: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): SerializedGoal {
  return {
    id: goal.id,
    name: goal.name,
    description: goal.description,
    targetAmountMinor: goal.targetAmountMinor?.toString() ?? null,
    targetCurrency: goal.targetCurrency,
    targetDate: goal.targetDate ? goal.targetDate.toISOString() : null,
    riskProfile: goal.riskProfile,
    archivedAt: goal.archivedAt ? goal.archivedAt.toISOString() : null,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  }
}

// =============================================================================
// CREATE GOAL
// =============================================================================

export const createGoalInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    targetAmountMinor: positiveMinorDigitsSchema.optional(),
    targetCurrency: z.string().optional(),
    targetDate: z.coerce.date().optional(),
    riskProfile: riskProfileSchema.optional(),
    idempotencyKey: uuidV7Schema,
  })
  .superRefine((data, ctx) => {
    if (Boolean(data.targetAmountMinor) !== Boolean(data.targetCurrency)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetCurrency"],
        message:
          "targetAmountMinor and targetCurrency must be provided together, or not at all",
      })
    }
  })
type CreateGoalInput = z.infer<typeof createGoalInputSchema>

const CREATE_GOAL_ENDPOINT = "createGoalFn"

export async function createGoalForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createGoalInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedGoal> {
  const data: CreateGoalInput = createGoalInputSchema.parse(rawData)
  if (data.targetCurrency) assertKnownCurrency(data.targetCurrency)

  const requestHash = await hashCanonicalPayload({
    name: data.name,
    description: data.description ?? null,
    targetAmountMinor: data.targetAmountMinor ?? null,
    targetCurrency: data.targetCurrency ?? null,
    targetDate: data.targetDate?.toISOString() ?? null,
    riskProfile: data.riskProfile ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedGoal>(
        tx,
        {
          endpoint: CREATE_GOAL_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      const created = await tx.goal.create({
        data: {
          familyId,
          name: data.name,
          description: data.description ?? null,
          targetAmountMinor: data.targetAmountMinor
            ? BigInt(data.targetAmountMinor)
            : null,
          targetCurrency: data.targetCurrency ?? null,
          targetDate: data.targetDate ?? null,
          riskProfile: data.riskProfile ?? null,
          createdById: user.id,
        },
      })
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Goal",
        entityId: created.id,
        after: serializeGoal(created),
      })

      const response = serializeGoal(created)
      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_GOAL_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedGoal>(tx, {
        endpoint: CREATE_GOAL_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const createGoalFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof createGoalInputSchema>) =>
    createGoalInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createGoalForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// ARCHIVE GOAL
// =============================================================================

const archiveGoalInputSchema = z.object({
  goalId: z.string().min(1),
})

export async function archiveGoalForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof archiveGoalInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedGoal> {
  const data = archiveGoalInputSchema.parse(rawData)
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })

  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const before = await tx.goal.findFirst({
      where: { id: data.goalId, familyId },
    })
    if (!before) {
      throw new GoalError(`Goal ${data.goalId} not found for this family`)
    }
    const updated = await tx.goal.update({
      where: { id: before.id },
      data: { archivedAt: new Date() },
    })
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "Goal",
      entityId: updated.id,
      before: serializeGoal(before),
      after: serializeGoal(updated),
    })
    return serializeGoal(updated)
  })
}

export const archiveGoalFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof archiveGoalInputSchema>) =>
    archiveGoalInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await archiveGoalForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// LIST GOALS — with each linked whole-Account and per-Holding allocation,
// current value computed from live data (never a stored snapshot).
// =============================================================================

export interface GoalAccountView {
  accountId: string
  accountName: string
  currency: string
  balanceMinor: string
}

export interface GoalHoldingAllocationView {
  holdingId: string
  accountId: string
  accountName: string
  instrumentName: string
  currency: string
  /** Units of this holding allocated to this Goal, decimal string. */
  quantity: string
  /** quantity × current price, minor units. */
  valueMinor: string
}

export interface GoalWithHoldingsView extends SerializedGoal {
  accounts: GoalAccountView[]
  holdingAllocations: GoalHoldingAllocationView[]
}

export async function listGoalsForFamily({
  familyId,
  userId,
  includeArchived = false,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  includeArchived?: boolean
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<GoalWithHoldingsView[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const goals = await tx.goal.findMany({
      where: { familyId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: "asc" },
      include: {
        accounts: { include: { account: true } },
        allocations: {
          include: {
            holding: { include: { instrument: true, account: true } },
          },
        },
      },
    })

    return goals.map((goal) => ({
      ...serializeGoal(goal),
      accounts: goal.accounts.map((link) => ({
        accountId: link.account.id,
        accountName: link.account.name,
        currency: link.account.currency,
        balanceMinor: link.account.balance.toString(),
      })),
      holdingAllocations: goal.allocations.map((allocation) => {
        const holding = allocation.holding
        const quantityScaled = quantityToScaled(allocation.quantity.toFixed(8))
        const valueMinor =
          (quantityScaled * currentPriceMinor(holding)) / 100_000_000n
        return {
          holdingId: holding.id,
          accountId: holding.account.id,
          accountName: holding.account.name,
          instrumentName: holding.instrument.name,
          currency: holding.account.currency,
          quantity: allocation.quantity.toFixed(8),
          valueMinor: valueMinor.toString(),
        }
      }),
    }))
  })
}

export const listGoalsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await listGoalsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// =============================================================================
// LINK / UNLINK a WHOLE ACCOUNT to a Goal
// =============================================================================

const linkAccountToGoalInputSchema = z.object({
  goalId: z.string().min(1),
  accountId: z.string().min(1),
})

export async function linkAccountToGoalForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof linkAccountToGoalInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<GoalAccountView> {
  const data = linkAccountToGoalInputSchema.parse(rawData)
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })

  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const goal = await tx.goal.findFirst({
      where: { id: data.goalId, familyId, archivedAt: null },
    })
    if (!goal) {
      throw new GoalError(`Goal ${data.goalId} not found for this family`)
    }
    const account = await fetchActiveAccount(
      tx,
      familyId,
      data.accountId,
      "Account"
    )

    const existing = await tx.goalAccount.findFirst({
      where: { accountId: account.id, familyId },
    })
    if (existing && existing.goalId !== goal.id) {
      throw new GoalError(
        `Account ${account.id} already belongs to a different Goal — unlink it first`
      )
    }

    const link =
      existing ??
      (await tx.goalAccount.create({
        data: { familyId, goalId: goal.id, accountId: account.id },
      }))
    if (!existing) {
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "GoalAllocation",
        entityId: link.id,
        after: {
          kind: "account_link",
          goalId: goal.id,
          goalName: goal.name,
          accountId: account.id,
          accountName: account.name,
        },
      })
    }

    return {
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
      balanceMinor: account.balance.toString(),
    }
  })
}

export const linkAccountToGoalFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof linkAccountToGoalInputSchema>) =>
    linkAccountToGoalInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await linkAccountToGoalForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

const unlinkAccountFromGoalInputSchema = z.object({
  accountId: z.string().min(1),
})

export async function unlinkAccountFromGoalForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof unlinkAccountFromGoalInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<{ accountId: string }> {
  const data = unlinkAccountFromGoalInputSchema.parse(rawData)
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })

  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const link = await tx.goalAccount.findFirst({
      where: { accountId: data.accountId, familyId },
      include: { goal: true, account: true },
    })
    if (!link) {
      throw new GoalError(`Account ${data.accountId} is not linked to any Goal`)
    }
    await tx.goalAccount.delete({ where: { id: link.id } })
    await auditLog(tx, auditCtx, {
      action: "delete",
      entityType: "GoalAllocation",
      entityId: link.id,
      before: {
        kind: "account_link",
        goalId: link.goalId,
        goalName: link.goal.name,
        accountId: link.accountId,
        accountName: link.account.name,
      },
      after: null,
    })
    return { accountId: link.accountId }
  })
}

export const unlinkAccountFromGoalFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof unlinkAccountFromGoalInputSchema>) =>
    unlinkAccountFromGoalInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await unlinkAccountFromGoalForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// REASSIGN a PARTIAL Holding allocation between Goals (or to/from unassigned)
// =============================================================================
//
// "Unassigned" is modeled as the ABSENCE of a GoalHoldingAllocation row for a
// given holding, never an explicit row — so `fromGoalId`/`toGoalId` accept
// null to mean "the unallocated pool". Input is quantity OR a Rupiah amount
// (converted to units at the holding's CURRENT price, same pattern as
// recordSwitchWithinTx) — the stored state is always the resulting unit
// split, never a Rupiah snapshot, so both goals' values float naturally with
// NAV afterward.
//
// CONSERVATION INVARIANT: SUM(quantity) across a holding's allocations must
// never exceed Holding.quantity. Enforced here (not a DB trigger) and
// integration-tested against real Postgres.

export const reassignHoldingAllocationInputSchema = z
  .object({
    holdingId: z.string().min(1),
    // null = "the unassigned pool" (no GoalHoldingAllocation row).
    fromGoalId: z.string().min(1).nullable(),
    toGoalId: z.string().min(1).nullable(),
    quantity: decimalStringSchema.optional(),
    amount: positiveMinorDigitsSchema.optional(),
    idempotencyKey: uuidV7Schema,
  })
  .superRefine((data, ctx) => {
    if ((data.quantity !== undefined) === (data.amount !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Provide exactly one of quantity or amount",
      })
    }
    if (data.fromGoalId === data.toGoalId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toGoalId"],
        message: "fromGoalId and toGoalId must differ",
      })
    }
  })
type ReassignHoldingAllocationInput = z.infer<
  typeof reassignHoldingAllocationInputSchema
>

export interface ReassignHoldingAllocationResult {
  holdingId: string
  fromGoalId: string | null
  toGoalId: string | null
  /** Units moved, decimal string. */
  movedQuantity: string
  /** Remaining unallocated units on this holding after the move, decimal string. */
  unallocatedQuantity: string
}

const REASSIGN_HOLDING_ALLOCATION_ENDPOINT = "reassignHoldingAllocationFn"

async function loadAllocationsForHolding(
  tx: TenantTransactionClient,
  familyId: string,
  holdingId: string
) {
  return await tx.goalHoldingAllocation.findMany({
    where: { holdingId, familyId },
  })
}

async function reassignHoldingAllocationWithinTx(
  tx: TenantTransactionClient,
  {
    data,
    familyId,
    auditCtx,
  }: {
    data: ReassignHoldingAllocationInput
    familyId: string
    auditCtx: AuditContext
  }
): Promise<ReassignHoldingAllocationResult> {
  const holding: HoldingWithInstrument = await loadHoldingWithInstrument(
    tx,
    familyId,
    data.holdingId
  )
  const holdingUnitsScaled = quantityToScaled(holding.quantity.toFixed(8))

  const allocations = await loadAllocationsForHolding(tx, familyId, holding.id)
  const allocatedScaled = allocations.reduce(
    (sum, row) => sum + quantityToScaled(row.quantity.toFixed(8)),
    0n
  )
  const unallocatedScaled = holdingUnitsScaled - allocatedScaled

  let unitsToMoveScaled: bigint
  if (data.quantity !== undefined) {
    try {
      unitsToMoveScaled = quantityToScaled(data.quantity)
    } catch (error) {
      throw new GoalError(
        `quantity is not a valid amount: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else {
    unitsToMoveScaled = unitsFromAmountScaled(
      BigInt(data.amount ?? "0"),
      currentPriceMinor(holding)
    )
  }
  if (unitsToMoveScaled <= 0n) {
    throw new GoalError("Quantity to reassign must be greater than zero")
  }

  // ---- Validate + debit the SOURCE side ----
  let fromRow: (typeof allocations)[number] | null = null
  if (data.fromGoalId === null) {
    if (unitsToMoveScaled > unallocatedScaled) {
      throw new GoalError(
        `Only ${scaledToQuantityString(unallocatedScaled)} units of this holding are unassigned; cannot move ${scaledToQuantityString(unitsToMoveScaled)}`
      )
    }
  } else {
    fromRow = allocations.find((row) => row.goalId === data.fromGoalId) ?? null
    if (!fromRow) {
      throw new GoalError(
        `Goal ${data.fromGoalId} has no allocation on holding ${holding.id}`
      )
    }
    const fromScaled = quantityToScaled(fromRow.quantity.toFixed(8))
    if (unitsToMoveScaled > fromScaled) {
      throw new GoalError(
        `Only ${scaledToQuantityString(fromScaled)} units are allocated to that Goal; cannot move ${scaledToQuantityString(unitsToMoveScaled)}`
      )
    }
    const remainingScaled = fromScaled - unitsToMoveScaled
    if (remainingScaled === 0n) {
      await tx.goalHoldingAllocation.delete({ where: { id: fromRow.id } })
    } else {
      await tx.goalHoldingAllocation.update({
        where: { id: fromRow.id },
        data: { quantity: scaledToQuantityString(remainingScaled) },
      })
    }
  }

  // ---- Credit the DESTINATION side ----
  if (data.toGoalId !== null) {
    const toGoal = await tx.goal.findFirst({
      where: { id: data.toGoalId, familyId, archivedAt: null },
    })
    if (!toGoal) {
      throw new GoalError(`Goal ${data.toGoalId} not found for this family`)
    }
    const existingTo = allocations.find((row) => row.goalId === data.toGoalId)
    if (existingTo) {
      const existingScaled = quantityToScaled(existingTo.quantity.toFixed(8))
      await tx.goalHoldingAllocation.update({
        where: { id: existingTo.id },
        data: {
          quantity: scaledToQuantityString(existingScaled + unitsToMoveScaled),
        },
      })
    } else {
      await tx.goalHoldingAllocation.create({
        data: {
          familyId,
          goalId: data.toGoalId,
          holdingId: holding.id,
          quantity: scaledToQuantityString(unitsToMoveScaled),
        },
      })
    }
  }

  // Re-derive the final unallocated total from scratch (never incremental
  // bookkeeping) so a bug elsewhere can never silently drift this number.
  const finalAllocations = await loadAllocationsForHolding(
    tx,
    familyId,
    holding.id
  )
  const finalAllocatedScaled = finalAllocations.reduce(
    (sum, row) => sum + quantityToScaled(row.quantity.toFixed(8)),
    0n
  )
  const finalUnallocatedScaled = holdingUnitsScaled - finalAllocatedScaled
  if (finalUnallocatedScaled < 0n) {
    // Conservation invariant guard — must be unreachable given the checks
    // above, but fail loud rather than silently persist an impossible state.
    throw new GoalError(
      `Invariant violated: allocations (${scaledToQuantityString(finalAllocatedScaled)}) exceed holding quantity (${scaledToQuantityString(holdingUnitsScaled)})`
    )
  }

  await auditLog(tx, auditCtx, {
    action: "update",
    entityType: "GoalAllocation",
    entityId: holding.id,
    after: {
      kind: "holding_reassign",
      holdingId: holding.id,
      instrumentName: holding.instrument.name,
      fromGoalId: data.fromGoalId,
      toGoalId: data.toGoalId,
      movedUnitsScaled: unitsToMoveScaled.toString(),
    },
  })

  return {
    holdingId: holding.id,
    fromGoalId: data.fromGoalId,
    toGoalId: data.toGoalId,
    movedQuantity: scaledToQuantityString(unitsToMoveScaled),
    unallocatedQuantity: scaledToQuantityString(finalUnallocatedScaled),
  }
}

export async function reassignHoldingAllocationForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof reassignHoldingAllocationInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<ReassignHoldingAllocationResult> {
  const data: ReassignHoldingAllocationInput =
    reassignHoldingAllocationInputSchema.parse(rawData)

  const requestHash = await hashCanonicalPayload({
    holdingId: data.holdingId,
    fromGoalId: data.fromGoalId,
    toGoalId: data.toGoalId,
    quantity: data.quantity ?? null,
    amount: data.amount ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<ReassignHoldingAllocationResult>(
          tx,
          {
            endpoint: REASSIGN_HOLDING_ALLOCATION_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
      if (replay) return replay

      const response = await reassignHoldingAllocationWithinTx(tx, {
        data,
        familyId,
        auditCtx,
      })

      await persistIdempotentEndpointResponse(tx, {
        endpoint: REASSIGN_HOLDING_ALLOCATION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<ReassignHoldingAllocationResult>(tx, {
        endpoint: REASSIGN_HOLDING_ALLOCATION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const reassignHoldingAllocationFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator(
    (data: z.input<typeof reassignHoldingAllocationInputSchema>) =>
      reassignHoldingAllocationInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await reassignHoldingAllocationForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// CONTEXTUAL ACTIVITY — "when was this holding last moved between Goals?"
// Typed, Zod-validated read of the AuditLog "GoalAllocation" rows for one
// holding (query-time projection, not a persisted table — see file header).
// =============================================================================

const goalAllocationAuditPayloadSchema = z
  .object({
    kind: z.literal("holding_reassign"),
    holdingId: z.string(),
    instrumentName: z.string(),
    fromGoalId: z.string().nullable(),
    toGoalId: z.string().nullable(),
    movedUnitsScaled: z.string(),
  })
  .passthrough()

export interface HoldingGoalHistoryItem {
  date: string
  fromGoalId: string | null
  fromGoalName: string | null
  toGoalId: string | null
  toGoalName: string | null
  movedQuantity: string
}

export async function listHoldingGoalHistoryForFamily({
  holdingId,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  holdingId: string
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<HoldingGoalHistoryItem[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const rows = await tx.auditLog.findMany({
      where: { familyId, entityType: "GoalAllocation", entityId: holdingId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, afterJson: true },
    })

    const goalIds = new Set<string>()
    const parsed = rows.flatMap((row) => {
      const result = goalAllocationAuditPayloadSchema.safeParse(row.afterJson)
      if (!result.success) return []
      if (result.data.fromGoalId) goalIds.add(result.data.fromGoalId)
      if (result.data.toGoalId) goalIds.add(result.data.toGoalId)
      return [{ createdAt: row.createdAt, payload: result.data }]
    })

    const goals = await tx.goal.findMany({
      where: { id: { in: [...goalIds] }, familyId },
      select: { id: true, name: true },
    })
    const goalNameById = new Map(goals.map((g) => [g.id, g.name]))

    return parsed.map(({ createdAt, payload }) => ({
      date: createdAt.toISOString(),
      fromGoalId: payload.fromGoalId,
      fromGoalName: payload.fromGoalId
        ? (goalNameById.get(payload.fromGoalId) ?? null)
        : null,
      toGoalId: payload.toGoalId,
      toGoalName: payload.toGoalId
        ? (goalNameById.get(payload.toGoalId) ?? null)
        : null,
      movedQuantity: scaledToQuantityString(BigInt(payload.movedUnitsScaled)),
    }))
  })
}

const listHoldingGoalHistoryInputSchema = z.object({
  holdingId: z.string().min(1),
})

export const listHoldingGoalHistoryFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.input<typeof listHoldingGoalHistoryInputSchema>) =>
    listHoldingGoalHistoryInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await listHoldingGoalHistoryForFamily({
      holdingId: data.holdingId,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
