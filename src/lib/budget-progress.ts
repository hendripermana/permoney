/**
 * Budget progress — the pure actual-vs-budget engine (ADR-0037 §3/§4).
 * =============================================================================
 *
 * This is the single source of truth for "how much did I spend against this
 * budget." It is a PURE function over already-fetched ledger rows: no DB, no
 * I/O, no date "now". Actuals are derived from each transaction's materialized
 * base-currency projection (`baseAmount`, ADR-0035) — never re-resolved here —
 * so historical periods are stable.
 *
 * Counting rules (ADR-0037 §3), all enforced here:
 *   - Only expense rows are passed in (the server query filters type/excluded/
 *     deleted); each contributes to its own category.
 *   - Splits contribute per child `categoryId`; the split child's base value is
 *     the parent's stored rate applied to the child's native amount
 *     (`convertMinor`), consistent with how the parent's `baseAmount` was made.
 *   - Exact-category match, no parent/child rollup.
 *   - FX-pending rows (`baseAmount === null`, or a split whose parent is pending)
 *     are EXCLUDED from base totals and counted separately so the UI can badge
 *     "N unconverted" — never silently zeroed.
 *   - `categoryId === null` spend is the read-only "uncategorized" line; it is
 *     never counted against an allocation.
 *   - Period membership is resolved by the transaction's calendar date in the
 *     FAMILY timezone (not raw UTC), so a 23:30 WIB Jun-30 row counts in June.
 *
 * Amounts are signed `bigint` minor units coming in (expense `baseAmount` is
 * negative); `actualAmount` is reported as a positive magnitude.
 */

import type { CurrencyCode } from "@/lib/data/currencies"
import { convertMinor } from "./fx"

export interface BudgetAllocationInput {
  categoryId: string
  /** Base-currency minor units, >= 0. */
  allocatedAmount: bigint
}

export interface BudgetSplitEntryInput {
  categoryId: string | null
  /** Positive native minor units (parent currency). */
  amount: bigint
}

export interface BudgetLedgerRowInput {
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
  splitEntries: BudgetSplitEntryInput[]
}

export interface BudgetPeriodInput {
  /** Inclusive period bounds as calendar dates (YYYY-MM-DD), family-tz anchored. */
  start: string
  end: string
  /** IANA timezone, e.g. "Asia/Jakarta". */
  timezone: string
}

export interface BudgetProgressInput {
  allocations: BudgetAllocationInput[]
  transactions: BudgetLedgerRowInput[]
  period: BudgetPeriodInput
}

export interface BudgetCategoryProgress {
  categoryId: string
  /** Base-currency minor units, >= 0. */
  allocatedAmount: bigint
  /** Positive base magnitude actually spent. */
  actualAmount: bigint
  /** `allocated - actual` (signed; negative => over budget). */
  remainingAmount: bigint
  isOver: boolean
  /** FX-pending contributions touching this category (excluded from actual). */
  pendingCount: number
}

export interface BudgetUncategorizedProgress {
  actualAmount: bigint
  pendingCount: number
}

export interface BudgetProgressTotals {
  allocatedAmount: bigint
  /** Sum of budgeted-category actuals only. */
  actualAmount: bigint
  remainingAmount: bigint
  isOver: boolean
  /** Distinct FX-pending transactions in the period (the period-level badge). */
  pendingTransactionCount: number
}

export interface BudgetProgress {
  categories: BudgetCategoryProgress[]
  uncategorized: BudgetUncategorizedProgress
  totals: BudgetProgressTotals
}

interface Bucket {
  actualAmount: bigint
  pendingCount: number
}

function emptyBucket(): Bucket {
  return { actualAmount: 0n, pendingCount: 0 }
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value
}

/** Calendar date (YYYY-MM-DD) of `date` as seen in `timeZone`. */
export function calendarDateInZone(date: Date, timeZone: string): string {
  // en-CA renders ISO-ordered YYYY-MM-DD, which compares lexicographically.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

/** Inclusive membership of a wall-clock instant in a family-tz date window. */
export function transactionInPeriod(
  date: Date,
  period: BudgetPeriodInput
): boolean {
  const cd = calendarDateInZone(date, period.timezone)
  return cd >= period.start && cd <= period.end
}

/** Base-currency contribution (positive magnitude) of one split child. */
function splitChildBase(
  row: BudgetLedgerRowInput,
  entry: BudgetSplitEntryInput
): bigint {
  // Parent guaranteed non-pending by the caller (baseCurrency/fxRateScaled set).
  const base = convertMinor(
    entry.amount,
    row.currency as CurrencyCode,
    row.baseCurrency as CurrencyCode,
    row.fxRateScaled as bigint
  )
  return absBigInt(base as bigint)
}

/**
 * Compute actual-vs-budget for one period. Pure; safe to unit-test exhaustively.
 */
export function computeBudgetProgress(
  input: BudgetProgressInput
): BudgetProgress {
  const { allocations, transactions, period } = input

  const perCategory = new Map<string, Bucket>()
  const uncategorized = emptyBucket()
  let pendingTransactionCount = 0

  const bucketFor = (categoryId: string | null): Bucket => {
    if (categoryId === null) return uncategorized
    let bucket = perCategory.get(categoryId)
    if (!bucket) {
      bucket = emptyBucket()
      perCategory.set(categoryId, bucket)
    }
    return bucket
  }

  for (const row of transactions) {
    if (!transactionInPeriod(row.date, period)) continue

    if (row.isSplit) {
      const parentPending =
        row.baseAmount === null ||
        row.fxRateScaled === null ||
        row.baseCurrency === null
      if (parentPending) pendingTransactionCount += 1
      for (const entry of row.splitEntries) {
        const bucket = bucketFor(entry.categoryId)
        if (parentPending) {
          bucket.pendingCount += 1
        } else {
          bucket.actualAmount += splitChildBase(row, entry)
        }
      }
      continue
    }

    const bucket = bucketFor(row.categoryId)
    if (row.baseAmount === null) {
      pendingTransactionCount += 1
      bucket.pendingCount += 1
    } else {
      bucket.actualAmount += absBigInt(row.baseAmount)
    }
  }

  let totalAllocated = 0n
  let totalActual = 0n
  const categories: BudgetCategoryProgress[] = allocations.map((allocation) => {
    const bucket = perCategory.get(allocation.categoryId) ?? emptyBucket()
    const remaining = allocation.allocatedAmount - bucket.actualAmount
    totalAllocated += allocation.allocatedAmount
    totalActual += bucket.actualAmount
    return {
      categoryId: allocation.categoryId,
      allocatedAmount: allocation.allocatedAmount,
      actualAmount: bucket.actualAmount,
      remainingAmount: remaining,
      isOver: bucket.actualAmount > allocation.allocatedAmount,
      pendingCount: bucket.pendingCount,
    }
  })

  return {
    categories,
    uncategorized: {
      actualAmount: uncategorized.actualAmount,
      pendingCount: uncategorized.pendingCount,
    },
    totals: {
      allocatedAmount: totalAllocated,
      actualAmount: totalActual,
      remainingAmount: totalAllocated - totalActual,
      isOver: totalActual > totalAllocated,
      pendingTransactionCount,
    },
  }
}
