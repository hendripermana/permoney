import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  calendarMonthBounds,
  computeInsights,
  currentMonthInZone,
  type InsightReport,
  type InsightTransferRow,
} from "@/lib/insights"
import { getFamilyBaseCurrency } from "./fx"
import { getFamilyTimezone, queryRange } from "./reporting"
import {
  familyMiddleware,
  scopedTenantTransaction,
} from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"

// =============================================================================
// PER-227 — insights engine server seam.
//
// The read half of the household insights engine (see src/lib/insights.ts for
// the derivation contract): load the canonical transfer legs for one
// family-tz calendar month, then fold them through the pure registry.
// Computed-on-read — no new tables, no write-on-read, no periodic job
// (design pass on Linear PER-227). Read-only: one `scopedTenantTransaction`
// sets the transaction-scoped RLS GUCs (ADR-0036); `familyMiddleware` alone
// gates, since every role holds `*:read`.
//
// Window resolution mirrors the reporting engines: `month` is optional, and
// when omitted "this month" is resolved in the FAMILY's timezone, never the
// server's clock (ADR-0037 / PER-263). The ±2-day over-fetch bound is the
// shared `queryRange` from reporting.ts; the fold localizes each row's instant
// precisely, so over-fetching is harmless.
// =============================================================================

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
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: GetInsightsInput
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<InsightReport> {
  const data = getInsightsInputSchema.parse(rawData)

  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
    const timezone = await getFamilyTimezone(tx, familyId)
    const month = data.month ?? currentMonthInZone(new Date(), timezone)
    const bounds = calendarMonthBounds(month)
    const range = queryRange(bounds.start, bounds.end)

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

    return computeInsights({ timezone, month, baseCurrency, transferRows })
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
