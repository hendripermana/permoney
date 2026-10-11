import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { calendarDateInZone } from "@/lib/budget-progress"
import {
  calendarMonthBounds,
  computeInsights,
  currentMonthInZone,
  type InsightAnchorGapRow,
  type InsightFlowRow,
  type InsightReport,
  type InsightTransferRow,
} from "@/lib/insights"
import { absMoney, decodeMoney } from "@/lib/money"
import { getFamilyBaseCurrency } from "./fx"
import {
  getFamilyTimezone,
  queryRange,
  subtractCalendarMonths,
} from "./reporting"
import {
  familyMiddleware,
  scopedTenantTransaction,
} from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"
import { collectAnchorChainGaps } from "./valuations"

// =============================================================================
// PER-227 — insights engine server seam.
//
// The read half of the household insights engine (see src/lib/insights.ts for
// the derivation contract): load the canonical rows for one family-tz month,
// then fold them through the pure registry. Computed-on-read — no new tables,
// no write-on-read, no periodic job (design pass on Linear PER-227). Read-only:
// one `scopedTenantTransaction` sets the transaction-scoped RLS GUCs
// (ADR-0036); `familyMiddleware` alone gates, since every role holds `*:read`.
//
// Window resolution mirrors the reporting engines: `month` is optional, and
// when omitted "this month" is resolved in the FAMILY's timezone, never the
// server's clock (ADR-0037 / PER-263); the same instant is passed to the fold
// so `since_payday` cuts its window in the same place. The ±2-day over-fetch
// bound is the shared `queryRange` from reporting.ts; the fold localizes each
// row's instant precisely, so over-fetching is harmless.
//
// Three loads, each for exactly one consumer:
//   1. transfer legs, window = the requested calendar month (`savings_flow`);
//   2. income rows, window = SIX months back — the payday anchor needs ≥3
//      monthly occurrences with family-tz-stable gaps, and the detector drops
//      a series whose last occurrence is more than two cadence bands (~70
//      days) old, so six months is comfortably sufficient;
//   3. expense rows, window = THREE months back — an anchor can be at most
//      ~70 days old (same detector guard), and three calendar months bound
//      that in every month-length case.
// =============================================================================

/** The flat projection both flow loads share. */
const FLOW_ROW_SELECT = {
  accountId: true,
  date: true,
  amount: true,
  baseAmount: true,
  currency: true,
  baseCurrency: true,
  fxRateScaled: true,
  isSplit: true,
  description: true,
  merchant: { select: { name: true } },
  splitEntries: { select: { amount: true } },
} as const

interface FlowRowSource {
  accountId: string
  date: Date
  amount: bigint
  baseAmount: bigint | null
  currency: string
  baseCurrency: string | null
  fxRateScaled: bigint | null
  isSplit: boolean
  description: string | null
  merchant: { name: string } | null
  splitEntries: Array<{ amount: bigint }>
}

function toFlowRow(row: FlowRowSource): InsightFlowRow {
  return {
    accountId: row.accountId,
    date: row.date,
    // Native magnitude: the detector compares per-occurrence amounts, and the
    // DB sign convention (negative expenses) must never leak into it.
    amount: row.amount < 0n ? -row.amount : row.amount,
    baseAmount: row.baseAmount,
    currency: row.currency,
    baseCurrency: row.baseCurrency,
    fxRateScaled: row.fxRateScaled,
    isSplit: row.isSplit,
    splitEntries: row.splitEntries,
    merchantName: row.merchant?.name ?? null,
    description: row.description,
  }
}

export const getInsightsInputSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM")
    .optional(),
})

export type GetInsightsInput = z.infer<typeof getInsightsInputSchema>

export async function getInsightsForFamily({
  data: rawData,
  familyId,
  userId,
  now = new Date(),
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: GetInsightsInput
  familyId: string
  userId: string
  /** The request instant. Injectable so integration tests can pin "today"
   * (payday windows are now-relative); production lets it default. */
  now?: Date
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<InsightReport> {
  const data = getInsightsInputSchema.parse(rawData)

  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
    const timezone = await getFamilyTimezone(tx, familyId)
    const month = data.month ?? currentMonthInZone(now, timezone)
    const bounds = calendarMonthBounds(month)
    const range = queryRange(bounds.start, bounds.end)
    const today = calendarDateInZone(now, timezone)
    const incomeRange = queryRange(subtractCalendarMonths(today, 6), today)
    const expenseRange = queryRange(subtractCalendarMonths(today, 3), today)

    // Only transfer legs are loaded: the cash-flow engine excludes
    // `type='transfer'` rows, and this engine consumes nothing else, so the
    // same money movement can never appear on both sides. `excluded` rows are
    // dropped exactly as the budget/cash-flow engines drop them; soft-deleted
    // rows never count.
    const transactions = await tx.transaction.findMany({
      where: {
        familyId,
        deletedAt: null,
        excluded: false,
        type: "transfer",
        date: range,
      },
      select: {
        id: true,
        date: true,
        baseAmount: true,
        account: { select: { accountSubtype: true } },
        toAccount: { select: { accountSubtype: true } },
        transferOut: {
          select: {
            id: true,
            purpose: true,
            outflowTransactionId: true,
            inflowTransactionId: true,
          },
        },
        transferIn: {
          select: {
            id: true,
            purpose: true,
            outflowTransactionId: true,
            inflowTransactionId: true,
          },
        },
      },
    })

    const incomeTransactions = await tx.transaction.findMany({
      where: {
        familyId,
        deletedAt: null,
        excluded: false,
        type: "income",
        date: incomeRange,
      },
      select: FLOW_ROW_SELECT,
    })

    const expenseTransactions = await tx.transaction.findMany({
      where: {
        familyId,
        deletedAt: null,
        excluded: false,
        type: "expense",
        date: expenseRange,
      },
      select: FLOW_ROW_SELECT,
    })

    const transferRows: InsightTransferRow[] = transactions.map((row) => {
      // A row is a leg of at most one Transfer pairing — `transferOut` when it
      // is the outflow leg, `transferIn` when it is the inflow leg.
      const transfer = row.transferOut ?? row.transferIn
      return {
        id: row.id,
        date: row.date,
        baseAmount: row.baseAmount,
        accountSubtype: row.account.accountSubtype,
        toAccountSubtype: row.toAccount?.accountSubtype ?? null,
        transferId: transfer?.id ?? null,
        transferPurpose: transfer?.purpose ?? null,
        transferOutflowTransactionId: transfer?.outflowTransactionId ?? null,
        transferInflowTransactionId: transfer?.inflowTransactionId ?? null,
      }
    })

    // PER-443 — every anchor-chain hole in the family, so each derivation can
    // mark its OWN window as partially recorded (the fold intersects + applies
    // the shared migration-softening rule; nothing is filtered here, so the
    // accounts badge, the dashboard banner and these cards can never disagree
    // about which gaps exist). Account-currency magnitudes: no FX conversion,
    // so a pending exchange rate can never suppress or distort a gap signal.
    const anchorGaps: InsightAnchorGapRow[] = (
      await collectAnchorChainGaps(tx, familyId)
    ).map((gap) => ({
      accountId: gap.accountId,
      accountName: gap.accountName,
      currency: gap.currency,
      fromDate: gap.fromDate,
      toDate: gap.toDate,
      amount: absMoney(decodeMoney(gap.drift)),
      fromSource: gap.fromSource,
      toSource: gap.toSource,
    }))

    return computeInsights({
      timezone,
      month,
      baseCurrency,
      now,
      transferRows,
      incomeRows: incomeTransactions.map(toFlowRow),
      expenseRows: expenseTransactions.map(toFlowRow),
      anchorGaps,
    })
  })
}

export const getInsightsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: GetInsightsInput) =>
    getInsightsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getInsightsForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
