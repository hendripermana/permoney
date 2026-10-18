import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { calendarDateInZone } from "@/lib/budget-progress"
import {
  calendarMonthBounds,
  computeInsights,
  currentMonthInZone,
  type InsightAccountRow,
  type InsightAnchorGapRow,
  type InsightFlowRow,
  type InsightFxRateRow,
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
// Loads, each for exactly one consumer, all sequential on the one
// interactive-transaction client (a transaction has a single connection, so
// awaiting them in order is the only correct shape — never Promise.all):
//   1. transfer legs, window = the requested calendar month (`savings_flow`);
//   2. income rows, window = SIX months back from today — the payday anchor
//      needs ≥3 monthly occurrences with family-tz-stable gaps, and the
//      detector drops a series whose last occurrence is more than two cadence
//      bands (~70 days) old, so six months is comfortably sufficient;
//   3. expense rows, window = SEVEN calendar months (month−6 → month end,
//      anchored to the REQUESTED month, not today) — the union all consumers
//      need: `emergency_fund` folds the trailing-six-complete-months burn
//      from them, `since_payday`'s window (anchor ≈ ≤70 days back through
//      today) is a subset whenever the requested month is current (the only
//      case that derivation runs), `recurring_bills` (slice #4) detects
//      series over the same span — at most six COMPLETE months can precede
//      the requested month, which is exactly its detection lookback — and
//      `spending_trend` (slice #5) compares the requested month against the
//      ONE month before it, comfortably inside the same span (no new load);
//   4. every family account, flat and UNFILTERED (soft-deleted AND archived
//      rows included — `emergency_fund`'s designated-savings predicate lives
//      in the pure fold, so the unit tests can prove it — the seam never
//      pre-filters);
//   5. the latest foreign→base rate per pair (`emergency_fund`) — the
//      `_max(asOfDate)`-per-pair groupBy + fetch shape of
//      `getLatestFxOverviewForFamily` (src/server/fx.ts), inlined inside this
//      transaction because that function opens its own, feeding the SAME
//      `buildLatestRateResolver` the net-worth cards use, so this card can
//      never disagree with net worth about a converted balance.
//   6. the first and last non-deleted ledger rows (`emergency_fund`,
//      `spending_trend`) — the
//      recorded-history span (Rule E, ADR-0059 PER-227 amendment) deciding
//      which trailing burn months count as COMPLETE, and (slice #5) whether
//      the comparison's previous month was recorded end-to-end at all.
//      `family.createdAt` is
//      unusable as a history proxy: a family can be created long before its
//      first row is recorded (integration seeds back-date rows), and rows can
//      post-date onboarding by months, so only the ledger itself can say what
//      was actually recorded.
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
    // Seven calendar months anchored to the REQUESTED month (month−6 → month
    // end): the union of `emergency_fund`'s burn lookback and
    // `since_payday`'s anchor window (see the header's load list).
    const expenseRange = queryRange(
      subtractCalendarMonths(`${month}-01`, 6),
      bounds.end
    )

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

    // PER-227 slice #3 — `emergency_fund`'s three loads. Accounts are loaded
    // UNFILTERED (soft-deleted AND archived rows included, class/subtype
    // untouched): the designated-savings predicate is a locked domain rule
    // that lives in the pure fold (src/lib/insights.ts), where the unit tests
    // can prove it. `status`/`archivedAt` ride along so the fold can exclude
    // archived (soft-closed) balances too. (The seam still orders by name for
    // a stable read order, but the counted-accounts listing's determinism is
    // the FOLD's local contract — it sorts internally.)
    const accountRows: InsightAccountRow[] = (
      await tx.account.findMany({
        where: { familyId },
        select: {
          id: true,
          name: true,
          accountClass: true,
          accountSubtype: true,
          currency: true,
          balance: true,
          status: true,
          archivedAt: true,
          deletedAt: true,
        },
        orderBy: { name: "asc" },
      })
    ).map((row) => ({
      id: row.id,
      name: row.name,
      accountClass: row.accountClass,
      accountSubtype: row.accountSubtype,
      currency: row.currency,
      nativeBalance: row.balance,
      status: row.status,
      archivedAt: row.archivedAt,
      deletedAt: row.deletedAt,
    }))

    // Latest foreign→base rate per directed pair — the SAME two-query shape
    // `getLatestFxOverviewForFamily` uses (src/server/fx.ts ~line 427):
    // `_max(asOfDate)` per pair via groupBy, then fetch only those rows,
    // instead of pulling the family's ENTIRE rate history and de-duplicating
    // in memory. Inlined (not reused) because that function opens its own
    // tenant transaction, which cannot nest inside this one; both queries run
    // sequentially on this transaction's single connection.
    // (debts.ts still pulls full history and dedupes in memory — the same
    // flaw, deliberately untouched here: out of scope for PER-227.)
    const latestFxDates = await tx.fxRateSnapshot.groupBy({
      by: ["fromCurrency", "toCurrency"],
      where: { familyId, toCurrency: baseCurrency },
      _max: { asOfDate: true },
    })
    const latestFxPairs = latestFxDates.flatMap((pair) =>
      pair._max.asOfDate === null
        ? []
        : [
            {
              fromCurrency: pair.fromCurrency,
              toCurrency: pair.toCurrency,
              asOfDate: pair._max.asOfDate,
            },
          ]
    )
    const fxRateRows: InsightFxRateRow[] =
      latestFxPairs.length === 0
        ? []
        : await tx.fxRateSnapshot.findMany({
            where: { familyId, OR: latestFxPairs },
            select: { fromCurrency: true, toCurrency: true, rateScaled: true },
          })

    // Rule E — the recorded-history span: family-tz dates of the first and
    // last non-deleted ledger rows (any type, excluded rows included — they
    // were still RECORDED; exclusion hides them from figures, never from
    // history). Two sequential findFirst queries; `null` when the family has
    // no rows at all (the derivation then skips — no confident average over
    // an unrecorded life).
    const firstLedgerRow = await tx.transaction.findFirst({
      where: { familyId, deletedAt: null },
      orderBy: { date: "asc" },
      select: { date: true },
    })
    const lastLedgerRow = await tx.transaction.findFirst({
      where: { familyId, deletedAt: null },
      orderBy: { date: "desc" },
      select: { date: true },
    })
    const historyRange =
      firstLedgerRow !== null && lastLedgerRow !== null
        ? {
            start: calendarDateInZone(firstLedgerRow.date, timezone),
            end: calendarDateInZone(lastLedgerRow.date, timezone),
          }
        : null

    return computeInsights({
      timezone,
      month,
      baseCurrency,
      now,
      transferRows,
      incomeRows: incomeTransactions.map(toFlowRow),
      expenseRows: expenseTransactions.map(toFlowRow),
      anchorGaps,
      accountRows,
      fxRateRows,
      historyRange,
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
