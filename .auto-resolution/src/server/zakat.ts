import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { CURRENCIES, type CurrencyCode } from "@/lib/data/currencies"
import { absMoney } from "@/lib/money"
import {
  BSI_GOLD_QUOTE_CURRENCY,
  marketQuoteToHoldingPriceMinor,
} from "@/lib/market-data"
import {
  classifyZakatAccount,
  type ZakatAccountRef,
} from "@/lib/zakat-attribution"
import {
  computeZakatForPayers,
  type ZakatCalculationAccount,
  type ZakatPayerResult,
  type HaulRule,
} from "@/lib/zakat-calculation"
import { computeNisabValue, type NisabBasis } from "@/lib/zakat-nisab"
import { auditLog, createAuditContext } from "./middleware/audit"
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
import { TenantReferenceError } from "./validation/tenant-references"
import {
  isUniqueConstraintError,
  uuidV7Schema,
  type RunInTenantTransaction,
} from "./mutation-kit"

// =============================================================================
// ADR-0056 — Zakat Maal calculator: server layer.
// =============================================================================
//
// `getZakatSettingsFn` / `upsertZakatSettingsFn` / `listZakatPayersFn` /
// `createZakatPayerFn` / `deleteZakatPayerFn` / `setAccountZakatOwnershipFn`
// follow the exact tenant-scoping + idempotency + audit-log contract every
// other mutation in this codebase does (CLAUDE.md §5A; template:
// `src/server/transaction-reconciliation.ts`).
//
// `computeZakatFn` is DIFFERENT on purpose: it is a pure READ — it changes
// nothing, so it carries no idempotency key and writes no AuditLog row,
// exactly like `getCashFlowReportFn`/`getNetWorthSeriesFn`
// (src/server/reporting.ts). It is still fully tenant-scoped through the
// standard `familyMiddleware` + `scopedTenantTransaction` (RLS GUC) pattern.
// =============================================================================

const NISAB_BASIS_VALUES = ["gold", "silver"] as const
const HAUL_RULE_VALUES = ["jumhur_continuous", "hanafi_start_end"] as const

export class ZakatPayerNotFoundError extends Error {
  override readonly name = "ZakatPayerNotFoundError"
  readonly statusCode = 404
  constructor(readonly zakatPayerId: string) {
    super(`ZakatPayer ${zakatPayerId} not found for this family`)
  }
}

async function assertZakatPayerInFamily(
  tx: TenantTransactionClient,
  id: string,
  familyId: string,
  field: string
): Promise<void> {
  const row = await tx.zakatPayer.findFirst({
    where: { id, familyId },
    select: { id: true },
  })
  if (!row) throw new TenantReferenceError(field, id, familyId)
}

// -----------------------------------------------------------------------------
// ZakatSettings — get / upsert.
// -----------------------------------------------------------------------------

export interface SerializedZakatSettings {
  nisabBasis: NisabBasis
  haulRule: HaulRule
  hawlStartDate: string | null
}

const DEFAULT_ZAKAT_SETTINGS: SerializedZakatSettings = {
  nisabBasis: "gold",
  haulRule: "jumhur_continuous",
  hawlStartDate: null,
}

function serializeZakatSettings(row: {
  nisabBasis: string
  haulRule: string
  hawlStartDate: Date | null
}): SerializedZakatSettings {
  return {
    nisabBasis: row.nisabBasis as NisabBasis,
    haulRule: row.haulRule as HaulRule,
    hawlStartDate: row.hawlStartDate ? row.hawlStartDate.toISOString() : null,
  }
}

export async function getZakatSettingsForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedZakatSettings> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const row = await tx.zakatSettings.findUnique({ where: { familyId } })
    return row ? serializeZakatSettings(row) : DEFAULT_ZAKAT_SETTINGS
  })
}

export const getZakatSettingsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getZakatSettingsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

const UPSERT_ZAKAT_SETTINGS_ENDPOINT = "upsertZakatSettingsFn"

export const upsertZakatSettingsInputSchema = z.object({
  nisabBasis: z.enum(NISAB_BASIS_VALUES),
  haulRule: z.enum(HAUL_RULE_VALUES),
  hawlStartDate: z.coerce.date().nullable(),
  idempotencyKey: uuidV7Schema,
})

export async function upsertZakatSettingsForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof upsertZakatSettingsInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedZakatSettings> {
  const data = upsertZakatSettingsInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    nisabBasis: data.nisabBasis,
    haulRule: data.haulRule,
    hawlStartDate: data.hawlStartDate?.toISOString() ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedZakatSettings>(tx, {
          endpoint: UPSERT_ZAKAT_SETTINGS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const existing = await tx.zakatSettings.findUnique({
        where: { familyId },
      })
      const before = existing
        ? serializeZakatSettings(existing)
        : DEFAULT_ZAKAT_SETTINGS

      const row = await tx.zakatSettings.upsert({
        where: { familyId },
        create: {
          familyId,
          nisabBasis: data.nisabBasis,
          haulRule: data.haulRule,
          hawlStartDate: data.hawlStartDate,
        },
        update: {
          nisabBasis: data.nisabBasis,
          haulRule: data.haulRule,
          hawlStartDate: data.hawlStartDate,
        },
      })
      const after = serializeZakatSettings(row)

      await auditLog(tx, auditCtx, {
        action: existing ? "update" : "create",
        entityType: "ZakatSettings",
        entityId: row.id,
        before,
        after,
      })

      await persistIdempotentEndpointResponse(tx, {
        endpoint: UPSERT_ZAKAT_SETTINGS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: after,
      })
      return after
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedZakatSettings>(tx, {
        endpoint: UPSERT_ZAKAT_SETTINGS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const upsertZakatSettingsFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("settings:write")])
  .inputValidator((data: z.input<typeof upsertZakatSettingsInputSchema>) =>
    upsertZakatSettingsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await upsertZakatSettingsForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// ZakatPayer — list / create / delete.
// -----------------------------------------------------------------------------

export interface SerializedZakatPayer {
  id: string
  displayName: string
  linkedUserId: string | null
}

function serializeZakatPayer(row: {
  id: string
  displayName: string
  linkedUserId: string | null
}): SerializedZakatPayer {
  return {
    id: row.id,
    displayName: row.displayName,
    linkedUserId: row.linkedUserId,
  }
}

export async function listZakatPayersForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedZakatPayer[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const rows = await tx.zakatPayer.findMany({
      where: { familyId },
      orderBy: { id: "asc" },
    })
    return rows.map(serializeZakatPayer)
  })
}

export const listZakatPayersFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await listZakatPayersForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

const CREATE_ZAKAT_PAYER_ENDPOINT = "createZakatPayerFn"

export const createZakatPayerInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  idempotencyKey: uuidV7Schema,
})

export async function createZakatPayerForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createZakatPayerInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedZakatPayer> {
  const data = createZakatPayerInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    displayName: data.displayName,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedZakatPayer>(tx, {
          endpoint: CREATE_ZAKAT_PAYER_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const row = await tx.zakatPayer.create({
        data: { familyId, displayName: data.displayName },
      })
      const after = serializeZakatPayer(row)

      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "ZakatPayer",
        entityId: row.id,
        after,
      })

      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_ZAKAT_PAYER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: after,
      })
      return after
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedZakatPayer>(tx, {
        endpoint: CREATE_ZAKAT_PAYER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const createZakatPayerFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("settings:write")])
  .inputValidator((data: z.input<typeof createZakatPayerInputSchema>) =>
    createZakatPayerInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createZakatPayerForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

const RENAME_ZAKAT_PAYER_ENDPOINT = "renameZakatPayerFn"

export const renameZakatPayerInputSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1).max(120),
  idempotencyKey: uuidV7Schema,
})

export async function renameZakatPayerForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof renameZakatPayerInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedZakatPayer> {
  const data = renameZakatPayerInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    id: data.id,
    displayName: data.displayName,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedZakatPayer>(tx, {
          endpoint: RENAME_ZAKAT_PAYER_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const existing = await tx.zakatPayer.findFirst({
        where: { id: data.id, familyId },
      })
      if (!existing) throw new ZakatPayerNotFoundError(data.id)

      const row = await tx.zakatPayer.update({
        where: { id: data.id },
        data: { displayName: data.displayName },
      })
      const before = serializeZakatPayer(existing)
      const after = serializeZakatPayer(row)

      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "ZakatPayer",
        entityId: row.id,
        before,
        after,
      })

      await persistIdempotentEndpointResponse(tx, {
        endpoint: RENAME_ZAKAT_PAYER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: after,
      })
      return after
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedZakatPayer>(tx, {
        endpoint: RENAME_ZAKAT_PAYER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const renameZakatPayerFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("settings:write")])
  .inputValidator((data: z.input<typeof renameZakatPayerInputSchema>) =>
    renameZakatPayerInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await renameZakatPayerForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

const DELETE_ZAKAT_PAYER_ENDPOINT = "deleteZakatPayerFn"

export const deleteZakatPayerInputSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

export interface DeleteZakatPayerResult {
  id: string
  untaggedAccountIds: string[]
}

/**
 * Deletes a `ZakatPayer`. DESIGN CHOICE (documented, per the ticket's "use
 * your judgment" instruction): deletion is NEVER blocked, even when the
 * payer has tagged accounts. `Account.zakatPayerId`/`zakatJointPayerId` are
 * `onDelete: SetNull` specifically so a payer can be removed without
 * touching any ledger data — the affected accounts simply become untagged
 * again (falling back to "excluded until re-tagged" once 2+ payers remain,
 * or "100% the sole remaining payer's" if this deletion drops the family
 * back to one payer — ADR-0056's default-behavior rule). Blocking deletion
 * would fight that design intent for no real safety benefit (nothing
 * financial is lost — Zakat tags carry no balance/audit history of their
 * own). The audit row still records exactly which accounts were untagged,
 * so the change is fully traceable.
 */
export async function deleteZakatPayerForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof deleteZakatPayerInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<DeleteZakatPayerResult> {
  const data = deleteZakatPayerInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({ id: data.id })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<DeleteZakatPayerResult>(tx, {
          endpoint: DELETE_ZAKAT_PAYER_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const existing = await tx.zakatPayer.findFirst({
        where: { id: data.id, familyId },
      })
      if (!existing) throw new ZakatPayerNotFoundError(data.id)

      const affectedAccounts = await tx.account.findMany({
        where: {
          familyId,
          OR: [{ zakatPayerId: data.id }, { zakatJointPayerId: data.id }],
        },
        select: { id: true },
      })

      await tx.zakatPayer.delete({ where: { id: data.id } })

      const result: DeleteZakatPayerResult = {
        id: data.id,
        untaggedAccountIds: affectedAccounts.map((a) => a.id),
      }

      await auditLog(tx, auditCtx, {
        action: "delete",
        entityType: "ZakatPayer",
        entityId: data.id,
        before: serializeZakatPayer(existing),
        after: result,
      })

      await persistIdempotentEndpointResponse(tx, {
        endpoint: DELETE_ZAKAT_PAYER_ENDPOINT,
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
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<DeleteZakatPayerResult>(tx, {
        endpoint: DELETE_ZAKAT_PAYER_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const deleteZakatPayerFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("settings:write")])
  .inputValidator((data: z.input<typeof deleteZakatPayerInputSchema>) =>
    deleteZakatPayerInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await deleteZakatPayerForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// Account zakat-ownership tagging.
// -----------------------------------------------------------------------------

const SET_ACCOUNT_ZAKAT_OWNERSHIP_ENDPOINT = "setAccountZakatOwnershipFn"

export const setAccountZakatOwnershipInputSchema = z
  .object({
    accountId: z.string().min(1),
    zakatPayerId: z.string().min(1).nullable(),
    zakatJointPayerId: z.string().min(1).nullable().optional().default(null),
    zakatJointSharePercent: z
      .number()
      .int()
      .min(1)
      .max(99)
      .nullable()
      .optional()
      .default(null),
    idempotencyKey: uuidV7Schema,
  })
  .refine(
    (d) =>
      (d.zakatJointPayerId === null) === (d.zakatJointSharePercent === null),
    {
      message:
        "zakatJointPayerId and zakatJointSharePercent must be set together",
      path: ["zakatJointSharePercent"],
    }
  )
  .refine((d) => d.zakatJointPayerId === null || d.zakatPayerId !== null, {
    message: "a joint co-owner requires a primary zakatPayerId",
    path: ["zakatPayerId"],
  })
  .refine(
    (d) =>
      d.zakatPayerId === null ||
      d.zakatJointPayerId === null ||
      d.zakatPayerId !== d.zakatJointPayerId,
    {
      message: "an account cannot be jointly owned by the same payer twice",
      path: ["zakatJointPayerId"],
    }
  )

export interface SerializedAccountZakatOwnership {
  accountId: string
  zakatPayerId: string | null
  zakatJointPayerId: string | null
  zakatJointSharePercent: number | null
}

export async function setAccountZakatOwnershipForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof setAccountZakatOwnershipInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedAccountZakatOwnership> {
  const data = setAccountZakatOwnershipInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload(data)
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedAccountZakatOwnership>(
          tx,
          {
            endpoint: SET_ACCOUNT_ZAKAT_OWNERSHIP_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
      if (replay) return replay

      // PER-94 tenant-reference validation: the account AND both payer ids
      // must belong to THIS family — foreign keys alone are not tenant
      // isolation (CLAUDE.md §5A). The composite DB FKs are the backstop;
      // this is the typed, pre-write guard.
      const account = await tx.account.findFirst({
        where: { id: data.accountId, familyId, deletedAt: null },
        select: {
          id: true,
          zakatPayerId: true,
          zakatJointPayerId: true,
          zakatJointSharePercent: true,
        },
      })
      if (!account) {
        throw new TenantReferenceError("accountId", data.accountId, familyId)
      }
      if (data.zakatPayerId !== null) {
        await assertZakatPayerInFamily(
          tx,
          data.zakatPayerId,
          familyId,
          "zakatPayerId"
        )
      }
      if (data.zakatJointPayerId !== null) {
        await assertZakatPayerInFamily(
          tx,
          data.zakatJointPayerId,
          familyId,
          "zakatJointPayerId"
        )
      }

      const before: SerializedAccountZakatOwnership = {
        accountId: account.id,
        zakatPayerId: account.zakatPayerId,
        zakatJointPayerId: account.zakatJointPayerId,
        zakatJointSharePercent: account.zakatJointSharePercent,
      }

      const updated = await tx.account.update({
        where: { id: data.accountId },
        data: {
          zakatPayerId: data.zakatPayerId,
          zakatJointPayerId: data.zakatJointPayerId,
          zakatJointSharePercent: data.zakatJointSharePercent,
        },
        select: {
          id: true,
          zakatPayerId: true,
          zakatJointPayerId: true,
          zakatJointSharePercent: true,
        },
      })
      const after: SerializedAccountZakatOwnership = {
        accountId: updated.id,
        zakatPayerId: updated.zakatPayerId,
        zakatJointPayerId: updated.zakatJointPayerId,
        zakatJointSharePercent: updated.zakatJointSharePercent,
      }

      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "Account",
        entityId: account.id,
        before,
        after,
      })

      await persistIdempotentEndpointResponse(tx, {
        endpoint: SET_ACCOUNT_ZAKAT_OWNERSHIP_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: after,
      })
      return after
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedAccountZakatOwnership>(tx, {
        endpoint: SET_ACCOUNT_ZAKAT_OWNERSHIP_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const setAccountZakatOwnershipFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("account:write")])
  .inputValidator((data: z.input<typeof setAccountZakatOwnershipInputSchema>) =>
    setAccountZakatOwnershipInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await setAccountZakatOwnershipForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// computeZakatFn — the read-only calculation endpoint.
// -----------------------------------------------------------------------------

export interface SerializedZakatBreakdownEntry {
  accountId: string
  accountName: string
  kind: "cash" | "receivable" | "credit" | "loan"
  attributedAmountMinor: string
  note?: string
}

export interface SerializedZakatPayerResult {
  payer: { id: string; displayName: string }
  eligible: boolean
  hawlAnniversaryDate: string
  snapshotNetWealthMinor: string
  nisabValueMinor: string
  nisabBasis: NisabBasis
  zakatOwedMinor: string
  hawlBrokenAt: string | null
  assetsIncluded: SerializedZakatBreakdownEntry[]
  debtDeducted: SerializedZakatBreakdownEntry[]
  unattributedAccountIds: string[]
}

export type ComputeZakatResult =
  | { status: "hawl_not_set" }
  | {
      status: "price_unavailable"
      nisabBasis: NisabBasis
      reason: string
    }
  | {
      status: "ok"
      nisabBasis: NisabBasis
      haulRule: HaulRule
      currency: string
      nisabValueMinor: string
      hawlStartDate: string
      payers: SerializedZakatPayerResult[]
    }

function serializePayerResult(
  result: ZakatPayerResult
): SerializedZakatPayerResult {
  return {
    payer: result.payer,
    eligible: result.eligible,
    hawlAnniversaryDate: result.hawlAnniversaryDate.toISOString(),
    snapshotNetWealthMinor: result.snapshotNetWealthMinor.toString(),
    nisabValueMinor: result.nisabValueMinor.toString(),
    nisabBasis: result.nisabBasis,
    zakatOwedMinor: result.zakatOwedMinor.toString(),
    hawlBrokenAt: result.hawlBrokenAt
      ? result.hawlBrokenAt.toISOString()
      : null,
    assetsIncluded: result.assetsIncluded.map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName,
      kind: a.kind,
      attributedAmountMinor: a.attributedAmountMinor.toString(),
    })),
    debtDeducted: result.debtDeducted.map((d) => ({
      accountId: d.accountId,
      accountName: d.accountName,
      kind: d.kind,
      attributedAmountMinor: d.attributedAmountMinor.toString(),
      note: d.note,
    })),
    unattributedAccountIds: result.unattributedAccountIds,
  }
}

/**
 * Resolve `nisabValueMinor` for the family's chosen `nisabBasis`, or a
 * structured "price not available" reason. Gold is priced from the existing
 * BSI feed (`ensureBsiGoldInstrument` / `market-data.server.ts`, PER-235).
 * Silver has NO price source in this codebase yet (checked directly against
 * `market-data.server.ts` and the schema before writing this) — the ADR
 * explicitly allows shipping the silver OPTION without blocking the whole
 * feature on building a new market-data source, as long as it fails
 * gracefully rather than crashing or silently mis-pricing. Cross-currency
 * (family currency other than IDR) is likewise "not yet available", mirroring
 * the same-currency constraint `refreshHoldingPricesForFamily` already
 * enforces for holdings (PER-238) — FX-converted nisab is a later slice.
 */
async function resolveNisabValueMinor(
  tx: TenantTransactionClient,
  basis: NisabBasis,
  currency: string
): Promise<{ nisabValueMinor: bigint } | { reason: string }> {
  if (basis === "silver") {
    return {
      reason:
        "Silver price tracking is not yet available in Permoney — the silver nisab option will unlock automatically once a silver price source is added.",
    }
  }
  if (currency !== BSI_GOLD_QUOTE_CURRENCY) {
    return {
      reason: `Gold nisab pricing is only available for ${BSI_GOLD_QUOTE_CURRENCY} families today (this family's currency is ${currency}).`,
    }
  }
  const { ensureBsiGoldInstrument } = await import("./market-data.server")
  const instrumentId = await ensureBsiGoldInstrument(tx)
  const quote = await tx.marketQuote.findFirst({
    where: { marketInstrumentId: instrumentId },
    orderBy: { asOf: "desc" },
    select: { price: true, priceScale: true },
  })
  if (!quote) {
    return {
      reason:
        "No gold price has been fetched yet — try again after the next gold price refresh.",
    }
  }
  const currencyDef = CURRENCIES[currency as CurrencyCode]
  const pricePerGramMinor = marketQuoteToHoldingPriceMinor({
    kind: "metal",
    priceScaled: quote.price,
    priceScale: quote.priceScale,
    minorUnitConversion: BigInt(currencyDef.minorUnitConversion),
  })
  return { nisabValueMinor: computeNisabValue("gold", pricePerGramMinor) }
}

export async function computeZakatForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
  now = new Date(),
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
  now?: Date
}): Promise<ComputeZakatResult> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const [family, settingsRow, payerRows] = await Promise.all([
      tx.family.findUniqueOrThrow({
        where: { id: familyId },
        select: { currency: true },
      }),
      tx.zakatSettings.findUnique({ where: { familyId } }),
      tx.zakatPayer.findMany({ where: { familyId }, orderBy: { id: "asc" } }),
    ])

    const settings = settingsRow
      ? serializeZakatSettings(settingsRow)
      : DEFAULT_ZAKAT_SETTINGS
    if (settings.hawlStartDate === null) {
      return { status: "hawl_not_set" }
    }

    const priceResolution = await resolveNisabValueMinor(
      tx,
      settings.nisabBasis,
      family.currency
    )
    if ("reason" in priceResolution) {
      return {
        status: "price_unavailable",
        nisabBasis: settings.nisabBasis,
        reason: priceResolution.reason,
      }
    }

    // ADR-0056 default-behavior rule: zero-or-one ZakatPayer needs no
    // tagging at all — synthesize an implicit single payer so the
    // single-person household (the vast majority) gets a correct result
    // without ever visiting Zakat settings.
    const payers =
      payerRows.length > 0
        ? payerRows.map(serializeZakatPayer)
        : [{ id: "__implicit__", displayName: "Saya", linkedUserId: null }]

    const accountRows = await tx.account.findMany({
      where: { familyId, deletedAt: null },
      select: {
        id: true,
        name: true,
        accountClass: true,
        accountType: true,
        balance: true,
        currency: true,
        zakatPayerId: true,
        zakatJointPayerId: true,
        zakatJointSharePercent: true,
      },
    })
    const inScope = accountRows.filter(
      (a) => classifyZakatAccount(a) !== "out_of_scope"
    )
    const inScopeIds = inScope.map((a) => a.id)

    // Every in-scope account's OWN ledger: rows where it is either side of
    // the transaction. Slice 1's account kinds (CASH/DEPOSITORY/E_WALLET/
    // RECEIVABLE/CREDIT/LOAN) are ALWAYS balanceSource="transaction_flow"
    // and never valuation-linked, so `transferIncoming` (which only matters
    // for a valuation-linked dual-leg transfer, PER-247/ADR-0048) is always
    // `null` here — deliberately not queried via the `Transfer` table.
    const txnRows =
      inScopeIds.length > 0
        ? await tx.transaction.findMany({
            where: {
              familyId,
              deletedAt: null,
              OR: [
                { accountId: { in: inScopeIds } },
                { toAccountId: { in: inScopeIds } },
              ],
            },
            select: {
              id: true,
              date: true,
              createdAt: true,
              amount: true,
              type: true,
              kind: true,
              accountId: true,
              toAccountId: true,
              description: true,
            },
          })
        : []

    const txnsByAccount = new Map<string, typeof txnRows>()
    for (const id of inScopeIds) txnsByAccount.set(id, [])
    for (const t of txnRows) {
      if (t.accountId && txnsByAccount.has(t.accountId)) {
        txnsByAccount.get(t.accountId)!.push(t)
      }
      if (t.toAccountId && txnsByAccount.has(t.toAccountId)) {
        txnsByAccount.get(t.toAccountId)!.push(t)
      }
    }

    const calculationAccounts: ZakatCalculationAccount[] = inScope.map(
      (a): ZakatCalculationAccount => ({
        id: a.id,
        name: a.name,
        accountClass: a.accountClass,
        accountType: a.accountType,
        balance: a.balance,
        zakatPayerId: a.zakatPayerId,
        zakatJointPayerId: a.zakatJointPayerId,
        zakatJointSharePercent: a.zakatJointSharePercent,
        transactions: (txnsByAccount.get(a.id) ?? []).map((t) => ({
          date: t.date,
          createdAt: t.createdAt,
          // `Transaction.amount` is SIGNED in the database (CLAUDE.md §5A:
          // negative for expense/transfer-out, positive for income/transfer-
          // in). `signedDeltaForAccount` (reused by the bigint daily-series
          // walk in zakat-calculation.ts) expects the AnalyticsTxn
          // convention instead — an ABSOLUTE magnitude, with `type` alone
          // carrying the sign — exactly like every other server-side
          // `serializeTransaction` call site (`absMoney(...)`) already does
          // before handing rows to client/analytics code. Skipping this
          // once produced a real bug here: an expense's stored-negative
          // amount was double-negated by `signedDeltaForAccount`'s `-amount`
          // branch, making it ADD to the balance instead of subtracting.
          amount: absMoney(t.amount),
          type: t.type,
          kind: t.kind,
          accountId: t.accountId,
          toAccountId: t.toAccountId,
          transferIncoming: null,
          description: t.description,
        })),
      })
    )

    const results = computeZakatForPayers({
      settings: {
        nisabBasis: settings.nisabBasis,
        haulRule: settings.haulRule,
        hawlStartDate: new Date(settings.hawlStartDate as string),
      },
      payers,
      accounts: calculationAccounts,
      nisabValueMinor: priceResolution.nisabValueMinor,
      now,
    })

    return {
      status: "ok",
      nisabBasis: settings.nisabBasis,
      haulRule: settings.haulRule,
      currency: family.currency,
      nisabValueMinor: priceResolution.nisabValueMinor.toString(),
      hawlStartDate: settings.hawlStartDate as string,
      payers: results.map(serializePayerResult),
    }
  })
}

export const computeZakatFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await computeZakatForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// Re-exported so UI code can narrow `ZakatAccountRef`-shaped data without
// importing the pure lib module directly for this one type.
export type { ZakatAccountRef }
