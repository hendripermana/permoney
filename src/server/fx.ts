import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { CurrencyCode } from "@/lib/data/currencies"
import { IDENTITY_RATE, convertMinor, decodeRate, encodeRate } from "@/lib/fx"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"

// =============================================================================
// PER-147 / ADR-0035 — Currency, FX rate snapshots, and base-currency projection.
//
// `FxRateSnapshot` is a dated, tenant-scoped, directed `from -> to` rate store
// (canonical use `foreign -> base`). Reporting normalizes every native amount to
// the family base currency (`Family.currency`) through these snapshots, and each
// `Transaction`/`Valuation` row MATERIALIZES its base projection
// (`baseAmount`/`baseCurrency`/`fxRateScaled`) at write time as derived,
// rebuildable state (ADR-0035 §4/§7). FX data never blocks a native ledger
// write: when no rate resolves, the projection is left NULL ("FX-pending") and a
// rebuild backfills it once a rate is seeded.
//
// Every write runs the ledger mutation contract: interactive `prisma.$transaction`
// with the `app.family_id` RLS GUC, tenant scoping, and append-only `AuditLog`.
// Snapshot writes are idempotent by their natural key
// (familyId, fromCurrency, toCurrency, asOfDate).
// =============================================================================

export class FxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FxError"
  }
}

interface ServerActor {
  id: string
}

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3,5}$/, "currency must be a 3–5 letter ISO-like code")

const fxSourceSchema = z.enum(["manual", "seed", "provider"])

export const upsertFxRateSnapshotInputSchema = z
  .object({
    fromCurrency: currencyCodeSchema,
    toCurrency: currencyCodeSchema,
    // Human decimal rate ("16250.75"); validated/scaled via encodeRate.
    rate: z.string().trim().min(1),
    asOfDate: z.coerce.date(),
    source: fxSourceSchema.optional(),
  })
  .refine((d) => d.fromCurrency !== d.toCurrency, {
    message: "fromCurrency and toCurrency must differ",
    path: ["toCurrency"],
  })
type UpsertFxRateSnapshotInput = z.infer<typeof upsertFxRateSnapshotInputSchema>

export const listFxRateSnapshotsInputSchema = z.object({
  fromCurrency: currencyCodeSchema.optional(),
  toCurrency: currencyCodeSchema.optional(),
})

export const rebuildFxProjectionsInputSchema = z.object({
  fromCurrency: currencyCodeSchema.optional(),
  onOrAfterDate: z.coerce.date().optional(),
})

export const setBaseCurrencyInputSchema = z.object({
  currency: currencyCodeSchema,
})

export interface SerializedFxRateSnapshot {
  id: string
  fromCurrency: string
  toCurrency: string
  rate: string
  rateScaled: string
  asOfDate: string
  source: string
}

export interface FxRebuildResult {
  baseCurrency: string
  transactionsUpdated: number
  valuationsUpdated: number
}

export interface SetBaseCurrencyResult {
  previousCurrency: string
  baseCurrency: string
  rebuilt: FxRebuildResult
}

interface BaseProjection {
  baseAmount: bigint | null
  baseCurrency: string | null
  fxRateScaled: bigint | null
  fxRateSnapshotId: string | null
}

const PENDING_PROJECTION: BaseProjection = {
  baseAmount: null,
  baseCurrency: null,
  fxRateScaled: null,
  fxRateSnapshotId: null,
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function serializeSnapshot(snapshot: {
  id: string
  fromCurrency: string
  toCurrency: string
  rateScaled: bigint
  asOfDate: Date
  source: string
}): SerializedFxRateSnapshot {
  return {
    id: snapshot.id,
    fromCurrency: snapshot.fromCurrency,
    toCurrency: snapshot.toCurrency,
    rate: decodeRate(snapshot.rateScaled),
    rateScaled: snapshot.rateScaled.toString(),
    asOfDate: toDateOnly(snapshot.asOfDate),
    source: snapshot.source,
  }
}

// =============================================================================
// Shared helpers — base currency, snapshot resolution, projection materialization
// =============================================================================

export async function getFamilyBaseCurrency(
  tx: TenantTransactionClient,
  familyId: string
): Promise<string> {
  const family = await tx.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { currency: true },
  })
  return family.currency
}

/**
 * Resolve the dated rate for `from -> to` as of `onOrBefore` (greatest
 * `asOfDate <= onOrBefore`). Returns null when no snapshot exists.
 */
async function resolveSnapshot(
  tx: TenantTransactionClient,
  familyId: string,
  fromCurrency: string,
  toCurrency: string,
  onOrBefore: Date
): Promise<{ id: string; rateScaled: bigint } | null> {
  const snapshot = await tx.fxRateSnapshot.findFirst({
    where: {
      familyId,
      fromCurrency,
      toCurrency,
      asOfDate: { lte: onOrBefore },
    },
    orderBy: { asOfDate: "desc" },
    select: { id: true, rateScaled: true },
  })
  return snapshot
}

/**
 * Compute the base-currency projection for a single native amount on a date.
 * Identity when `currency === baseCurrency`; converted when a snapshot resolves;
 * otherwise FX-pending (all NULL). ADR-0035 §4.
 */
export async function computeBaseProjectionForAmount(
  tx: TenantTransactionClient,
  familyId: string,
  params: { amount: bigint; currency: string; date: Date; baseCurrency: string }
): Promise<BaseProjection> {
  const { amount, currency, date, baseCurrency } = params
  if (currency === baseCurrency) {
    return {
      baseAmount: amount,
      baseCurrency,
      fxRateScaled: IDENTITY_RATE,
      fxRateSnapshotId: null,
    }
  }
  const snapshot = await resolveSnapshot(
    tx,
    familyId,
    currency,
    baseCurrency,
    date
  )
  if (!snapshot) return { ...PENDING_PROJECTION }
  const baseAmount = convertMinor(
    amount,
    currency as CurrencyCode,
    baseCurrency as CurrencyCode,
    snapshot.rateScaled
  )
  return {
    baseAmount,
    baseCurrency,
    fxRateScaled: snapshot.rateScaled,
    fxRateSnapshotId: snapshot.id,
  }
}

function projectionsEqual(
  a: BaseProjection,
  b: {
    baseAmount: bigint | null
    baseCurrency: string | null
    fxRateScaled: bigint | null
    fxRateSnapshotId: string | null
  }
): boolean {
  return (
    a.baseAmount === b.baseAmount &&
    a.baseCurrency === b.baseCurrency &&
    a.fxRateScaled === b.fxRateScaled &&
    a.fxRateSnapshotId === b.fxRateSnapshotId
  )
}

// =============================================================================
// UPSERT FX RATE SNAPSHOT (manual / seed)
// =============================================================================

export async function upsertFxRateSnapshotForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof upsertFxRateSnapshotInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedFxRateSnapshot> {
  const data: UpsertFxRateSnapshotInput =
    upsertFxRateSnapshotInputSchema.parse(rawData)

  let rateScaled: bigint
  try {
    rateScaled = encodeRate(data.rate)
  } catch (error) {
    throw new FxError(
      `Invalid FX rate ${JSON.stringify(data.rate)}: ${(error as Error).message}`
    )
  }

  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })
  const source = data.source ?? "manual"

  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const baseCurrency = await getFamilyBaseCurrency(tx, familyId)

    const existing = await tx.fxRateSnapshot.findUnique({
      where: {
        fx_rate_snapshot_unique: {
          familyId,
          fromCurrency: data.fromCurrency,
          toCurrency: data.toCurrency,
          asOfDate: data.asOfDate,
        },
      },
    })

    const snapshot = await tx.fxRateSnapshot.upsert({
      where: {
        fx_rate_snapshot_unique: {
          familyId,
          fromCurrency: data.fromCurrency,
          toCurrency: data.toCurrency,
          asOfDate: data.asOfDate,
        },
      },
      create: {
        familyId,
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency,
        rateScaled,
        asOfDate: data.asOfDate,
        source,
        createdById: user.id,
      },
      update: { rateScaled, source },
    })
    const serialized = serializeSnapshot(snapshot)

    // Audit only when the stored value actually changed (idempotent no-op replay
    // of the same key+value writes nothing).
    if (!existing || existing.rateScaled !== rateScaled) {
      await auditLog(tx, auditCtx, {
        action: existing ? "update" : "create",
        entityType: "FxRateSnapshot",
        entityId: snapshot.id,
        before: existing ? serializeSnapshot(existing) : undefined,
        after: serialized,
      })

      // Scoped rebuild: only rows in this `from` currency are affected, from the
      // snapshot date onward (older rows resolve to earlier snapshots). Also
      // re-resolves any FX-pending rows in this currency.
      if (data.toCurrency === baseCurrency) {
        await rebuildProjectionsWithinTx(tx, familyId, baseCurrency, auditCtx, {
          fromCurrency: data.fromCurrency,
        })
      }
    }

    return serialized
  })
}

export const upsertFxRateSnapshotFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.input<typeof upsertFxRateSnapshotInputSchema>) =>
    upsertFxRateSnapshotInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await upsertFxRateSnapshotForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// LIST FX RATE SNAPSHOTS
// =============================================================================

export async function listFxRateSnapshotsForFamily({
  data,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.infer<typeof listFxRateSnapshotsInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedFxRateSnapshot[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const rows = await tx.fxRateSnapshot.findMany({
      where: {
        familyId,
        ...(data.fromCurrency ? { fromCurrency: data.fromCurrency } : {}),
        ...(data.toCurrency ? { toCurrency: data.toCurrency } : {}),
      },
      orderBy: [
        { fromCurrency: "asc" },
        { toCurrency: "asc" },
        { asOfDate: "desc" },
      ],
    })
    return rows.map(serializeSnapshot)
  })
}

export const listFxRateSnapshotsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof listFxRateSnapshotsInputSchema>) =>
    listFxRateSnapshotsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await listFxRateSnapshotsForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

export interface FxOverview {
  baseCurrency: string
  rates: SerializedFxRateSnapshot[]
}

export async function getFxOverviewForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<FxOverview> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
    const rows = await tx.fxRateSnapshot.findMany({
      where: { familyId },
      orderBy: [
        { fromCurrency: "asc" },
        { toCurrency: "asc" },
        { asOfDate: "desc" },
      ],
    })
    return { baseCurrency, rates: rows.map(serializeSnapshot) }
  })
}

export const getFxOverviewFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getFxOverviewForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// =============================================================================
// REBUILD BASE PROJECTIONS (derived, rebuildable — ADR-0035 §4)
// =============================================================================

async function rebuildProjectionsWithinTx(
  tx: TenantTransactionClient,
  familyId: string,
  baseCurrency: string,
  auditCtx: Awaited<ReturnType<typeof createAuditContext>>,
  scope?: { fromCurrency?: string; onOrAfterDate?: Date }
): Promise<FxRebuildResult> {
  // Transactions: recompute baseAmount for every active row (scoped by native
  // currency / date when provided). currency === base resolves to identity.
  const transactions = await tx.transaction.findMany({
    where: {
      familyId,
      deletedAt: null,
      ...(scope?.fromCurrency ? { currency: scope.fromCurrency } : {}),
      ...(scope?.onOrAfterDate ? { date: { gte: scope.onOrAfterDate } } : {}),
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      date: true,
      baseAmount: true,
      baseCurrency: true,
      fxRateScaled: true,
      fxRateSnapshotId: true,
    },
  })

  let transactionsUpdated = 0
  for (const row of transactions) {
    const next = await computeBaseProjectionForAmount(tx, familyId, {
      amount: row.amount,
      currency: row.currency,
      date: row.date,
      baseCurrency,
    })
    if (projectionsEqual(next, row)) continue
    await tx.transaction.update({
      where: { id: row.id },
      data: {
        baseAmount: next.baseAmount,
        baseCurrency: next.baseCurrency,
        fxRateScaled: next.fxRateScaled,
        fxRateSnapshotId: next.fxRateSnapshotId,
      },
    })
    transactionsUpdated += 1
  }

  // Valuations: same projection, keyed off valuationDate.
  const valuations = await tx.valuation.findMany({
    where: {
      familyId,
      deletedAt: null,
      ...(scope?.fromCurrency ? { currency: scope.fromCurrency } : {}),
      ...(scope?.onOrAfterDate
        ? { valuationDate: { gte: scope.onOrAfterDate } }
        : {}),
    },
    select: {
      id: true,
      value: true,
      currency: true,
      valuationDate: true,
      baseValue: true,
      baseCurrency: true,
      fxRateScaled: true,
      fxRateSnapshotId: true,
    },
  })

  let valuationsUpdated = 0
  for (const row of valuations) {
    const next = await computeBaseProjectionForAmount(tx, familyId, {
      amount: row.value,
      currency: row.currency,
      date: row.valuationDate,
      baseCurrency,
    })
    const current = {
      baseAmount: row.baseValue,
      baseCurrency: row.baseCurrency,
      fxRateScaled: row.fxRateScaled,
      fxRateSnapshotId: row.fxRateSnapshotId,
    }
    if (projectionsEqual(next, current)) continue
    await tx.valuation.update({
      where: { id: row.id },
      data: {
        baseValue: next.baseAmount,
        baseCurrency: next.baseCurrency,
        fxRateScaled: next.fxRateScaled,
        fxRateSnapshotId: next.fxRateSnapshotId,
      },
    })
    valuationsUpdated += 1
  }

  const result: FxRebuildResult = {
    baseCurrency,
    transactionsUpdated,
    valuationsUpdated,
  }

  if (transactionsUpdated > 0 || valuationsUpdated > 0) {
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "FxProjectionRebuild",
      entityId: familyId,
      after: { ...result, scope: scope ?? null },
    })
  }
  return result
}

export async function rebuildFxProjectionsForFamily({
  data,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.infer<typeof rebuildFxProjectionsInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<FxRebuildResult> {
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })
  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
    return await rebuildProjectionsWithinTx(
      tx,
      familyId,
      baseCurrency,
      auditCtx,
      {
        fromCurrency: data.fromCurrency,
        onOrAfterDate: data.onOrAfterDate,
      }
    )
  })
}

export const rebuildFxProjectionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof rebuildFxProjectionsInputSchema>) =>
    rebuildFxProjectionsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await rebuildFxProjectionsForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// SET BASE CURRENCY (audited + full rebuild)
// =============================================================================

export async function setBaseCurrencyForFamily({
  data,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.infer<typeof setBaseCurrencyInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SetBaseCurrencyResult> {
  const parsed = setBaseCurrencyInputSchema.parse(data)
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })

  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const previousCurrency = await getFamilyBaseCurrency(tx, familyId)
    if (previousCurrency === parsed.currency) {
      const rebuilt = await rebuildProjectionsWithinTx(
        tx,
        familyId,
        previousCurrency,
        auditCtx
      )
      return { previousCurrency, baseCurrency: previousCurrency, rebuilt }
    }

    await tx.family.update({
      where: { id: familyId },
      data: { currency: parsed.currency },
    })
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "Family",
      entityId: familyId,
      before: { currency: previousCurrency },
      after: { currency: parsed.currency },
    })

    // Base changed: every base projection must be recomputed (ADR-0035 §1/§4).
    const rebuilt = await rebuildProjectionsWithinTx(
      tx,
      familyId,
      parsed.currency,
      auditCtx
    )
    return {
      previousCurrency,
      baseCurrency: parsed.currency,
      rebuilt,
    }
  })
}

export const setBaseCurrencyFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof setBaseCurrencyInputSchema>) =>
    setBaseCurrencyInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await setBaseCurrencyForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })
