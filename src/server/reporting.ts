import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  buildNetWorthSeries,
  generateSampleDates,
  type NetWorthPoint,
  type SeriesInterval,
} from "@/lib/net-worth"
import { getFamilyBaseCurrency } from "./fx"
import {
  familyMiddleware,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"

// =============================================================================
// PER-154 / ADR-0038 — Reporting engine: net-worth time series.
//
// Computed-on-read from canonical rows (no BalanceSnapshot table). For each
// sampled date the per-account NATIVE balance is derived (cash = opening anchor
// + Σ flow ≤ T; tracked = latest valuation ≤ T, carried forward) and normalized
// to the family base currency by as-of-date mark-to-market FX (greatest snapshot
// asOfDate ≤ T). The heavy lifting is the pure `buildNetWorthSeries` fold in
// `src/lib/net-worth.ts`, shared with the live `NetWorthInBaseCard` via
// `normalizeNetWorthAt`, so the series' last point == the card total.
//
// Read-only: no idempotency, no AuditLog. One `scopedTenantTransaction` sets the
// transaction-scoped RLS GUCs (app.family_id + app.user_id, ADR-0036), so tenant
// isolation is enforced at the database independently of the app layer. Every
// role — including `viewer` — holds `*:read`, so `familyMiddleware` alone gates.
// =============================================================================

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")

export const getNetWorthSeriesInputSchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    interval: z.enum(["day", "week", "month"]),
  })
  .superRefine((data, ctx) => {
    // Reuse the single source of truth for bounds (from ≤ to, ≤ MAX points).
    try {
      generateSampleDates(data.from, data.to, data.interval)
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: (error as Error).message,
      })
    }
  })

export type GetNetWorthSeriesInput = z.infer<
  typeof getNetWorthSeriesInputSchema
>

export interface SerializedNetWorthPoint {
  date: string
  netWorth: string
  assets: string
  liabilities: string
  unconverted: Array<{ currency: string; native: string }>
  isPartial: boolean
}

export interface NetWorthSeriesResult {
  baseCurrency: string
  timezone: string
  from: string
  to: string
  interval: SeriesInterval
  points: SerializedNetWorthPoint[]
}

function serializePoint(point: NetWorthPoint): SerializedNetWorthPoint {
  return {
    date: point.date,
    netWorth: point.netWorth.toString(),
    assets: point.assets.toString(),
    liabilities: point.liabilities.toString(),
    unconverted: point.unconverted.map((entry) => ({
      currency: entry.currency,
      native: entry.native.toString(),
    })),
    isPartial: point.isPartial,
  }
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// Generous inclusive upper bound: `to` + 2 days UTC covers any family timezone
// offset (±14h). The fold localizes each transaction instant precisely, so
// over-fetching at most a day's rows is harmless.
function queryUpperBound(to: string): Date {
  const startOfTo = Date.parse(`${to}T00:00:00.000Z`)
  return new Date(startOfTo + 2 * 24 * 60 * 60 * 1000)
}

export async function getNetWorthSeriesForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: GetNetWorthSeriesInput
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<NetWorthSeriesResult> {
  const data = getNetWorthSeriesInputSchema.parse(rawData)
  const upperBound = queryUpperBound(data.to)

  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
    const timezone = await getFamilyTimezone(tx, familyId)

    // Four queries total — never one per sample date (ADR-0038 §7).
    const [accounts, valuations, transactions, snapshots] = await Promise.all([
      tx.account.findMany({
        where: { familyId },
        select: {
          id: true,
          accountClass: true,
          balanceSource: true,
          currency: true,
        },
      }),
      tx.valuation.findMany({
        where: { familyId, deletedAt: null, valuationDate: { lt: upperBound } },
        select: {
          accountId: true,
          value: true,
          valuationDate: true,
          type: true,
        },
      }),
      tx.transaction.findMany({
        where: { familyId, deletedAt: null, date: { lt: upperBound } },
        select: { accountId: true, amount: true, date: true },
      }),
      tx.fxRateSnapshot.findMany({
        where: {
          familyId,
          toCurrency: baseCurrency,
          asOfDate: { lt: upperBound },
        },
        select: { fromCurrency: true, rateScaled: true, asOfDate: true },
      }),
    ])

    const points = buildNetWorthSeries({
      baseCurrency,
      timezone,
      from: data.from,
      to: data.to,
      interval: data.interval,
      accounts,
      valuations: valuations.map((row) => ({
        accountId: row.accountId,
        value: row.value,
        valuationDate: toDateOnly(row.valuationDate),
        type: row.type,
      })),
      transactions: transactions.map((row) => ({
        accountId: row.accountId,
        amount: row.amount,
        date: row.date,
      })),
      snapshots: snapshots.map((row) => ({
        fromCurrency: row.fromCurrency,
        rateScaled: row.rateScaled,
        asOfDate: toDateOnly(row.asOfDate),
      })),
    })

    return {
      baseCurrency,
      timezone,
      from: data.from,
      to: data.to,
      interval: data.interval,
      points: points.map(serializePoint),
    }
  })
}

async function getFamilyTimezone(
  tx: TenantTransactionClient,
  familyId: string
): Promise<string> {
  const family = await tx.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { timezone: true },
  })
  return family.timezone
}

export const getNetWorthSeriesFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: GetNetWorthSeriesInput) =>
    getNetWorthSeriesInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getNetWorthSeriesForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
