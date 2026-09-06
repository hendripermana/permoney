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
 *   - Only expense rows, PLUS reimbursement/refund income rows (PER-260 /
 *     ADR-0055), are passed in (the server query filters type+kind/excluded/
 *     deleted); each contributes to its own category. A reimbursement row's
 *     magnitude is SUBTRACTED from that category's "spent" figure instead of
 *     added — the same net-against-category-spend rule `cash-flow.ts` already
 *     applies to its `byCategory` groups, so the Spending report and Budget
 *     progress never disagree about the same underlying transactions.
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
 *
 * PER-278 / ADR-0037 §2 follow-up — rollover is ADDITIVE to this engine, not a
 * replacement: the ledger-read loop below (actual spend per category) is
 * byte-for-byte unchanged. `rolledOverAmount` is an optional carry-in the
 * caller resolves ahead of time (`foldRolloverCarry`, server-side, by walking
 * the category's chain of preceding periods) and passes in per allocation. It
 * folds into `remainingAmount`/`isOver` as `allocatedAmount + rolledOverAmount
 * - actualAmount`, while `allocatedAmount` itself keeps reporting the raw
 * per-period fact untouched. Every existing caller that omits the field gets
 * identical output to before rollover existed (0n is the default).
 */

import type { CurrencyCode } from "@/lib/data/currencies"
import { convertMinor } from "./fx"

export interface BudgetAllocationInput {
  categoryId: string
  /** Base-currency minor units, >= 0. */
  allocatedAmount: bigint
  /**
   * Carry-in from prior periods, already resolved by the caller
   * (`foldRolloverCarry`) over the category's chain of preceding periods.
   * Base-currency minor units, >= 0 — a deficit never carries forward (see
   * `foldRolloverCarry`). Omit or pass 0n for a category whose
   * `rolloverPolicy` is `"none"`.
   */
  rolledOverAmount?: bigint
}

export interface BudgetSplitEntryInput {
  categoryId: string | null
  /** Positive native minor units (parent currency). */
  amount: bigint
}

export interface BudgetLedgerRowInput {
  /**
   * "expense" contributes its magnitude to the category's spent figure;
   * "income" is ONLY valid for a reimbursement/refund row (PER-260) and
   * SUBTRACTS its magnitude instead — the server query only ever selects
   * type="income" rows of kind="reimbursement" alongside type="expense".
   */
  type: "expense" | "income"
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
  /** Base-currency minor units, >= 0. The raw per-period fact — never
   * includes rollover (see `rolledOverAmount`/`effectiveAllocatedAmount`). */
  allocatedAmount: bigint
  /**
   * Carry-in from prior periods (>= 0; 0n when `rolloverPolicy` is `"none"`
   * or there is nothing to carry). Echoes `BudgetAllocationInput.rolledOverAmount`.
   */
  rolledOverAmount: bigint
  /** `allocatedAmount + rolledOverAmount` — what this category actually has
   * to spend this period. Use this (not `allocatedAmount`) for envelope UI. */
  effectiveAllocatedAmount: bigint
  /**
   * Net base magnitude actually spent: expense magnitude minus any
   * reimbursement/refund magnitude netted against this category (PER-260).
   * Normally >= 0; can go negative if reimbursements in the period exceed
   * spending in the category (net inflow) — mirrors what the Spending report
   * would show as a negative net-expense for the same category.
   */
  actualAmount: bigint
  /** `effectiveAllocatedAmount - actual` (signed; negative => over budget). */
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
  /** Raw sum of per-period allocations — never includes rollover. */
  allocatedAmount: bigint
  /** Sum of `rolledOverAmount` across categories. */
  rolledOverAmount: bigint
  /** Sum of budgeted-category actuals only. */
  actualAmount: bigint
  /** `(allocatedAmount + rolledOverAmount) - actualAmount`. */
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

    // PER-260: a reimbursement (type="income") nets AGAINST the category's
    // spent figure instead of adding to it — subtract its magnitude. An
    // ordinary expense row still adds, unchanged.
    const sign = row.type === "income" ? -1n : 1n

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
          bucket.actualAmount += sign * splitChildBase(row, entry)
        }
      }
      continue
    }

    const bucket = bucketFor(row.categoryId)
    if (row.baseAmount === null) {
      pendingTransactionCount += 1
      bucket.pendingCount += 1
    } else {
      bucket.actualAmount += sign * absBigInt(row.baseAmount)
    }
  }

  let totalAllocated = 0n
  let totalRolledOver = 0n
  let totalActual = 0n
  const categories: BudgetCategoryProgress[] = allocations.map((allocation) => {
    const bucket = perCategory.get(allocation.categoryId) ?? emptyBucket()
    const rolledOverAmount = allocation.rolledOverAmount ?? 0n
    const effectiveAllocatedAmount =
      allocation.allocatedAmount + rolledOverAmount
    const remaining = effectiveAllocatedAmount - bucket.actualAmount
    totalAllocated += allocation.allocatedAmount
    totalRolledOver += rolledOverAmount
    totalActual += bucket.actualAmount
    return {
      categoryId: allocation.categoryId,
      allocatedAmount: allocation.allocatedAmount,
      rolledOverAmount,
      effectiveAllocatedAmount,
      actualAmount: bucket.actualAmount,
      remainingAmount: remaining,
      isOver: bucket.actualAmount > effectiveAllocatedAmount,
      pendingCount: bucket.pendingCount,
    }
  })

  const totalEffectiveAllocated = totalAllocated + totalRolledOver

  return {
    categories,
    uncategorized: {
      actualAmount: uncategorized.actualAmount,
      pendingCount: uncategorized.pendingCount,
    },
    totals: {
      allocatedAmount: totalAllocated,
      rolledOverAmount: totalRolledOver,
      actualAmount: totalActual,
      remainingAmount: totalEffectiveAllocated - totalActual,
      isOver: totalActual > totalEffectiveAllocated,
      pendingTransactionCount,
    },
  }
}

/**
 * Folds a category's chain of PRECEDING periods (oldest → newest, up to but
 * excluding the period we want a carry-in for) into that carry-in amount.
 *
 * PER-278 / ADR-0037 §2 follow-up — resolved algorithm, verified against
 * Sure's real `Budget::RolloverCalculator` (`we-promise/sure`), not just the
 * paraphrase in ADR-0037's original placeholder text:
 *
 *   - **Only a surplus rolls forward.** `carryOut = max(0, allocated + carryIn
 *     - actual)`. This corrects ADR-0037 §2's speculative draft ("an
 *     overspend carries a negative amount forward") — Sure's actual
 *     production code does the opposite: "v1 only carries a surplus, a
 *     negative balance stops at the month it happened in"
 *     (`budget/rollover_calculator.rb#leftover_for`). An overspend is a
 *     same-period problem the user resolves via Move Allocation ("roll with
 *     the punches"), never automatic carried debt — this also matches YNAB's
 *     real behavior, which the original draft got wrong.
 *   - **Every period in `periods` must have `rolloverPolicy === "carryover"`.**
 *     The caller (`resolveRolloverCarryIn`, `src/server/budgets.ts`) walks a
 *     category's periods newest → oldest and stops at the first period whose
 *     `rolloverPolicy` is `"none"` — that period's own surplus never left it
 *     ("switching the toggle off has to stop the money in both directions",
 *     same source) — so only the CONTIGUOUS trailing run of `"carryover"`
 *     periods before the target period is ever passed in here.
 *   - **Gaps are the caller's concern, not this function's.** A month the
 *     family never budgeted (no `Budget` row, or no `BudgetCategory` row for
 *     this category) is not "budgeted at zero" — Sure's chain "crosses it
 *     untouched" rather than resetting the carry. The caller simply omits gap
 *     periods from `periods` (it only queries periods where a `BudgetCategory`
 *     row exists for this category), so this function never needs to special-
 *     case a gap.
 *   - **Compounds.** A run of surpluses accumulates period over period (this
 *     is the whole point of an envelope: unspent money keeps stacking until
 *     spent or moved away), matching Sure's forward chain pass.
 *
 * Deliberately simpler than Sure in one respect: Sure also handles parent/
 * subcategory ring-fencing when folding a chain. Permoney's budget model has
 * no category rollup this slice (ADR-0037 §3.3), so that entire branch does
 * not exist here — nothing to port.
 */
export function foldRolloverCarry(
  periods: { allocatedAmount: bigint; actualAmount: bigint }[]
): bigint {
  let carry = 0n
  for (const period of periods) {
    const effective = period.allocatedAmount + carry
    const leftover = effective - period.actualAmount
    carry = leftover > 0n ? leftover : 0n
  }
  return carry
}
