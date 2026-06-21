/**
 * Cash-flow / income-statement engine — the pure income-vs-expense + cash-flow
 * core (PER-155 / R2). =========================================================
 *
 * Single source of truth for "what flowed in and out over a period, by category
 * and by merchant, and as a trend." A PURE function over already-fetched ledger
 * rows: no DB, no I/O, no `now`. The flow value basis is each transaction's
 * frozen, materialized base-currency projection (`baseAmount`, ADR-0035 /
 * ADR-0038 §2) — never re-resolved here — so historical periods are stable as
 * later FX rates arrive.
 *
 * Counting rules (consistent with the budget engine, `budget-progress.ts`):
 *   - Only flow rows are passed in: `type ∈ {income, expense}`. Transfers
 *     (`funds_movement`/`cc_payment`/`loan_payment`/`liability_draw`) are
 *     `type='transfer'` and excluded UPSTREAM by the server query — they are
 *     movements, not flow. `liability_interest`/`liability_fee`/`fx_fee` are
 *     genuine `type='expense'` finance costs and DO count; keying on `type`
 *     means they can never be dropped by mistake. (See docs/liability-semantics.)
 *   - Income vs expense is taken from `type`; magnitudes are positive, `net =
 *     income − expense ≡ Σ signed base` by construction.
 *   - Splits contribute per child `categoryId`/`merchantId` (the parent's are
 *     null); the child's base is the parent's stored rate applied to the child's
 *     native amount (`convertMinor`), so the children reconcile with the parent
 *     `baseAmount`. The child's income/expense sign comes from the parent type.
 *   - FX-pending rows (`baseAmount === null`, or a split whose parent is pending)
 *     are EXCLUDED from base totals and counted separately (`unconvertedCount`)
 *     so the UI can badge "N unconverted" — never silently zeroed.
 *   - `categoryId === null` (resp. `merchantId === null`) is the read-only
 *     uncategorized / no-merchant line.
 *   - Period membership and trend bucketing use the transaction's calendar date
 *     in the FAMILY timezone (ADR-0037 / R1 convention), not raw UTC.
 *
 * Amounts in and out are signed `bigint` minor units; `income`/`expense` are
 * reported as positive magnitudes, `net` is signed.
 */

import type { CurrencyCode } from "@/lib/data/currencies"
import { calendarDateInZone } from "./budget-progress"
import { convertMinor } from "./fx"

export const MAX_CASH_FLOW_BUCKETS = 366

export type CashFlowInterval = "day" | "week" | "month"

// ---- inputs -----------------------------------------------------------------

export interface CashFlowSplitEntryInput {
  categoryId: string | null
  merchantId: string | null
  /** Positive native minor units (parent currency). */
  amount: bigint
}

export interface CashFlowLedgerRowInput {
  /** Already filtered to flow rows by the server query. */
  type: "income" | "expense"
  /** Native currency of the transaction. */
  currency: string
  /** Family base currency captured at write time; null when FX-pending. */
  baseCurrency: string | null
  /** 1e12-scaled rate used at write time; null when FX-pending. */
  fxRateScaled: bigint | null
  /** Materialized base projection (signed); null when FX-pending. */
  baseAmount: bigint | null
  /** Wall-clock instant of the transaction (stored UTC). */
  date: Date
  isSplit: boolean
  /** Null when split (lives on children) or genuinely uncategorized. */
  categoryId: string | null
  /** Null when split (lives on children) or genuinely merchant-less. */
  merchantId: string | null
  splitEntries: CashFlowSplitEntryInput[]
}

export interface CashFlowReportInput {
  /** Inclusive range bounds as family-tz calendar dates (YYYY-MM-DD). */
  from: string
  to: string
  interval: CashFlowInterval
  /** IANA timezone, e.g. "Asia/Jakarta". */
  timezone: string
  transactions: ReadonlyArray<CashFlowLedgerRowInput>
}

// ---- outputs ----------------------------------------------------------------

export interface CashFlowAmounts {
  /** Positive base magnitude that flowed in. */
  income: bigint
  /** Positive base magnitude that flowed out. */
  expense: bigint
  /** Signed: `income − expense`. */
  net: bigint
  /** FX-pending contributions excluded from the figures above. */
  unconvertedCount: number
}

export interface CashFlowCategoryGroup extends CashFlowAmounts {
  categoryId: string | null
}

export interface CashFlowMerchantGroup extends CashFlowAmounts {
  merchantId: string | null
}

export interface CashFlowSeriesBucket extends CashFlowAmounts {
  periodStart: string
  periodEnd: string
  isPartial: boolean
}

export interface CashFlowReport {
  totals: CashFlowAmounts
  byCategory: CashFlowCategoryGroup[]
  byMerchant: CashFlowMerchantGroup[]
  series: CashFlowSeriesBucket[]
}

// ---- bucket generation (pure calendar math) ---------------------------------

export interface CashFlowBucket {
  periodStart: string
  periodEnd: string
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number)
  return { year, month, day }
}

function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Advance a YYYY-MM-DD by one interval step (start of the next bucket). */
function stepDate(date: string, interval: CashFlowInterval): string {
  const { year, month, day } = parseDate(date)
  if (interval === "day") return formatUtc(Date.UTC(year, month - 1, day + 1))
  if (interval === "week") return formatUtc(Date.UTC(year, month - 1, day + 7))
  // month: advance one calendar month, clamping the day to the new month's last.
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()
  return formatUtc(Date.UTC(nextYear, nextMonth - 1, Math.min(day, lastDay)))
}

/** The calendar date one day before `date` (inclusive bucket end). */
function dayBefore(date: string): string {
  const { year, month, day } = parseDate(date)
  return formatUtc(Date.UTC(year, month - 1, day - 1))
}

/**
 * Contiguous, gap-free `[periodStart, periodEnd]` buckets (YYYY-MM-DD) stepped
 * by `interval` across `[from, to]`. The first bucket starts at `from`; the last
 * bucket's end is clamped to `to`. Throws `RangeError` when `from > to` or the
 * bucket count would exceed `MAX_CASH_FLOW_BUCKETS` (strict, bounded contract).
 */
export function generateCashFlowBuckets(
  from: string,
  to: string,
  interval: CashFlowInterval
): CashFlowBucket[] {
  if (from > to) {
    throw new RangeError(`cash-flow: from (${from}) must be <= to (${to})`)
  }
  const buckets: CashFlowBucket[] = []
  let cursor = from
  while (cursor <= to) {
    const nextStart = stepDate(cursor, interval)
    const end = nextStart > to ? to : dayBefore(nextStart)
    buckets.push({ periodStart: cursor, periodEnd: end })
    if (buckets.length > MAX_CASH_FLOW_BUCKETS) {
      throw new RangeError(
        `cash-flow exceeds ${MAX_CASH_FLOW_BUCKETS} buckets; narrow the range or widen the interval`
      )
    }
    cursor = nextStart
  }
  return buckets
}

// ---- the fold ---------------------------------------------------------------

interface Accumulator {
  income: bigint
  expense: bigint
  unconvertedCount: number
}

function emptyAccumulator(): Accumulator {
  return { income: 0n, expense: 0n, unconvertedCount: 0 }
}

/** Add one signed base contribution (positive => income, negative => expense). */
function addContribution(acc: Accumulator, signedBase: bigint): void {
  if (signedBase >= 0n) acc.income += signedBase
  else acc.expense += -signedBase
}

/** Largest bucket index whose periodStart <= cd. Buckets are ascending. */
function findBucketIndex(buckets: CashFlowBucket[], cd: string): number {
  let lo = 0
  let hi = buckets.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (buckets[mid].periodStart <= cd) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** Positive base magnitude of one split child via the parent's stored rate. */
function splitChildBase(
  row: CashFlowLedgerRowInput,
  entry: CashFlowSplitEntryInput
): bigint {
  // Caller guarantees the parent is non-pending (rate + base currency present).
  const base = convertMinor(
    entry.amount,
    row.currency as CurrencyCode,
    row.baseCurrency as CurrencyCode,
    row.fxRateScaled as bigint
  ) as bigint
  return base < 0n ? -base : base
}

function finalize(acc: Accumulator): CashFlowAmounts {
  return {
    income: acc.income,
    expense: acc.expense,
    net: acc.income - acc.expense,
    unconvertedCount: acc.unconvertedCount,
  }
}

/** Deterministic group ordering: real ids ascending, the null line last. */
function compareNullableId(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

/**
 * Compute the income/expense + cash-flow report for one range. Pure; safe to
 * unit-test exhaustively. Single pass over the rows; `O(rows · log buckets)`.
 */
export function computeCashFlowReport(
  input: CashFlowReportInput
): CashFlowReport {
  const buckets = generateCashFlowBuckets(input.from, input.to, input.interval)

  const totals = emptyAccumulator()
  const bucketAcc = buckets.map(emptyAccumulator)
  const byCategory = new Map<string | null, Accumulator>()
  const byMerchant = new Map<string | null, Accumulator>()

  const categoryAcc = (id: string | null): Accumulator => {
    let acc = byCategory.get(id)
    if (!acc) {
      acc = emptyAccumulator()
      byCategory.set(id, acc)
    }
    return acc
  }
  const merchantAcc = (id: string | null): Accumulator => {
    let acc = byMerchant.get(id)
    if (!acc) {
      acc = emptyAccumulator()
      byMerchant.set(id, acc)
    }
    return acc
  }

  for (const row of input.transactions) {
    const cd = calendarDateInZone(row.date, input.timezone)
    if (cd < input.from || cd > input.to) continue
    const bucket = bucketAcc[findBucketIndex(buckets, cd)]

    if (row.isSplit) {
      const parentPending =
        row.baseAmount === null ||
        row.fxRateScaled === null ||
        row.baseCurrency === null
      if (parentPending) {
        // One distinct pending transaction at the period/bucket level; a flagged
        // contribution at each touched category/merchant line.
        totals.unconvertedCount += 1
        bucket.unconvertedCount += 1
        for (const entry of row.splitEntries) {
          categoryAcc(entry.categoryId).unconvertedCount += 1
          merchantAcc(entry.merchantId).unconvertedCount += 1
        }
        continue
      }
      for (const entry of row.splitEntries) {
        const magnitude = splitChildBase(row, entry)
        const signed = row.type === "expense" ? -magnitude : magnitude
        addContribution(totals, signed)
        addContribution(bucket, signed)
        addContribution(categoryAcc(entry.categoryId), signed)
        addContribution(merchantAcc(entry.merchantId), signed)
      }
      continue
    }

    if (row.baseAmount === null) {
      totals.unconvertedCount += 1
      bucket.unconvertedCount += 1
      categoryAcc(row.categoryId).unconvertedCount += 1
      merchantAcc(row.merchantId).unconvertedCount += 1
      continue
    }

    addContribution(totals, row.baseAmount)
    addContribution(bucket, row.baseAmount)
    addContribution(categoryAcc(row.categoryId), row.baseAmount)
    addContribution(merchantAcc(row.merchantId), row.baseAmount)
  }

  return {
    totals: finalize(totals),
    byCategory: [...byCategory.entries()]
      .sort(([a], [b]) => compareNullableId(a, b))
      .map(([categoryId, acc]) => ({ categoryId, ...finalize(acc) })),
    byMerchant: [...byMerchant.entries()]
      .sort(([a], [b]) => compareNullableId(a, b))
      .map(([merchantId, acc]) => ({ merchantId, ...finalize(acc) })),
    series: buckets.map((bucket, index) => ({
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      ...finalize(bucketAcc[index]),
      isPartial: bucketAcc[index].unconvertedCount > 0,
    })),
  }
}
