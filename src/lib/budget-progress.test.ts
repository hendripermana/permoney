import { describe, expect, test } from "vite-plus/test"
import { encodeRate } from "@/lib/fx"
import {
  calendarDateInZone,
  computeBudgetProgress,
  foldRolloverCarry,
  transactionInPeriod,
  type BudgetLedgerRowInput,
  type BudgetPeriodInput,
} from "./budget-progress"

// ADR-0037 §3/§4 — the pure actual-vs-budget engine. Actuals ride the
// materialized `baseAmount`; splits use the parent's stored rate; FX-pending is
// excluded + counted; uncategorized is its own line; period membership is by
// family-tz calendar date.

const JUNE: BudgetPeriodInput = {
  start: "2026-06-01",
  end: "2026-06-30",
  timezone: "Asia/Jakarta",
}

// A non-split expense already converted to base (signed negative).
function expense(
  categoryId: string | null,
  baseAmount: bigint | null,
  date = new Date("2026-06-15T03:00:00.000Z")
): BudgetLedgerRowInput {
  return {
    type: "expense",
    currency: "IDR",
    baseCurrency: baseAmount === null ? null : "IDR",
    fxRateScaled: baseAmount === null ? null : encodeRate("1"),
    baseAmount,
    date,
    isSplit: false,
    categoryId,
    splitEntries: [],
  }
}

// A non-split reimbursement/refund income row already converted to base
// (signed positive) — PER-260 / ADR-0055.
function reimbursement(
  categoryId: string | null,
  baseAmount: bigint | null,
  date = new Date("2026-06-15T03:00:00.000Z")
): BudgetLedgerRowInput {
  return {
    type: "income",
    currency: "IDR",
    baseCurrency: baseAmount === null ? null : "IDR",
    fxRateScaled: baseAmount === null ? null : encodeRate("1"),
    baseAmount,
    date,
    isSplit: false,
    categoryId,
    splitEntries: [],
  }
}

describe("computeBudgetProgress — basic over/under/exact", () => {
  test("under, exact, and over budget per category", () => {
    const result = computeBudgetProgress({
      allocations: [
        { categoryId: "food", allocatedAmount: 100_000n },
        { categoryId: "rent", allocatedAmount: 500_000n },
        { categoryId: "fun", allocatedAmount: 50_000n },
      ],
      transactions: [
        expense("food", -40_000n),
        expense("food", -20_000n), // food actual 60k < 100k => under
        expense("rent", -500_000n), // exact
        expense("fun", -75_000n), // over
      ],
      period: JUNE,
    })

    const food = result.categories.find((c) => c.categoryId === "food")
    expect(food?.actualAmount).toBe(60_000n)
    expect(food?.remainingAmount).toBe(40_000n)
    expect(food?.isOver).toBe(false)

    const rent = result.categories.find((c) => c.categoryId === "rent")
    expect(rent?.remainingAmount).toBe(0n)
    expect(rent?.isOver).toBe(false) // exact is not over

    const fun = result.categories.find((c) => c.categoryId === "fun")
    expect(fun?.actualAmount).toBe(75_000n)
    expect(fun?.remainingAmount).toBe(-25_000n)
    expect(fun?.isOver).toBe(true)

    expect(result.totals.allocatedAmount).toBe(650_000n)
    expect(result.totals.actualAmount).toBe(635_000n)
    expect(result.totals.remainingAmount).toBe(15_000n)
    expect(result.totals.pendingTransactionCount).toBe(0)
  })

  test("budgeted category with zero spend reports full remaining", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(0n)
    expect(result.categories[0]?.remainingAmount).toBe(100_000n)
    expect(result.categories[0]?.isOver).toBe(false)
  })
})

describe("computeBudgetProgress — multi-currency summation", () => {
  test("sums already-materialized base amounts regardless of native currency", () => {
    // Two rows in different native currencies, both projected to IDR base.
    const usdRow: BudgetLedgerRowInput = {
      type: "expense",
      currency: "USD",
      baseCurrency: "IDR",
      fxRateScaled: encodeRate("16250"),
      baseAmount: -162_500_000n, // $100 -> Rp 1,625,000
      date: new Date("2026-06-10T03:00:00.000Z"),
      isSplit: false,
      categoryId: "food",
      splitEntries: [],
    }
    const idrRow = expense("food", -2_500_000n) // Rp 25,000

    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 200_000_000n }],
      transactions: [usdRow, idrRow],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(165_000_000n)
  })
})

describe("computeBudgetProgress — splits via the parent's stored rate", () => {
  test("each split child converts at the parent rate and buckets to its category", () => {
    const parent: BudgetLedgerRowInput = {
      type: "expense",
      currency: "USD",
      baseCurrency: "IDR",
      fxRateScaled: encodeRate("16250"),
      baseAmount: -162_500_000n, // $100 total
      date: new Date("2026-06-12T03:00:00.000Z"),
      isSplit: true,
      categoryId: null,
      splitEntries: [
        { categoryId: "food", amount: 6_000n }, // $60
        { categoryId: "fun", amount: 4_000n }, // $40
      ],
    }
    const result = computeBudgetProgress({
      allocations: [
        { categoryId: "food", allocatedAmount: 200_000_000n },
        { categoryId: "fun", allocatedAmount: 200_000_000n },
      ],
      transactions: [parent],
      period: JUNE,
    })
    const food = result.categories.find((c) => c.categoryId === "food")
    const fun = result.categories.find((c) => c.categoryId === "fun")
    expect(food?.actualAmount).toBe(97_500_000n) // $60 * 16250
    expect(fun?.actualAmount).toBe(65_000_000n) // $40 * 16250
    // Children sum to the parent's base magnitude (no proportional drift).
    expect((food?.actualAmount ?? 0n) + (fun?.actualAmount ?? 0n)).toBe(
      162_500_000n
    )
  })
})

describe("computeBudgetProgress — FX-pending handling", () => {
  test("pending non-split row is excluded from actual and counted", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [expense("food", -40_000n), expense("food", null)],
      period: JUNE,
    })
    const food = result.categories[0]
    expect(food?.actualAmount).toBe(40_000n) // pending one excluded, not zeroed in
    expect(food?.pendingCount).toBe(1)
    expect(result.totals.pendingTransactionCount).toBe(1)
  })

  test("split with a pending parent counts each child as pending, no actual", () => {
    const parent: BudgetLedgerRowInput = {
      type: "expense",
      currency: "USD",
      baseCurrency: null,
      fxRateScaled: null,
      baseAmount: null,
      date: new Date("2026-06-12T03:00:00.000Z"),
      isSplit: true,
      categoryId: null,
      splitEntries: [
        { categoryId: "food", amount: 6_000n },
        { categoryId: "fun", amount: 4_000n },
      ],
    }
    const result = computeBudgetProgress({
      allocations: [
        { categoryId: "food", allocatedAmount: 100_000n },
        { categoryId: "fun", allocatedAmount: 100_000n },
      ],
      transactions: [parent],
      period: JUNE,
    })
    expect(result.categories.every((c) => c.actualAmount === 0n)).toBe(true)
    expect(result.categories.every((c) => c.pendingCount === 1)).toBe(true)
    // One transaction, counted once at the period level despite two children.
    expect(result.totals.pendingTransactionCount).toBe(1)
  })
})

describe("computeBudgetProgress — reimbursement/refund netting (PER-260)", () => {
  test("0% reimbursed: full spend counts, matches ordinary expense behavior", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 500_000n }],
      transactions: [expense("food", -319_000n)],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(319_000n)
  })

  test("partial reimbursement nets against the same category's spent figure", () => {
    // Dinner Rp180,500 (expense), family covers Rp180,000 (reimbursement
    // assigned the SAME expense category) — real burden Rp500.
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 200_000n }],
      transactions: [
        expense("food", -180_500n),
        reimbursement("food", 180_000n),
      ],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(500n)
    expect(result.categories[0]?.remainingAmount).toBe(199_500n)
    expect(result.categories[0]?.isOver).toBe(false)
  })

  test("100% refund of a cancelled order nets the category's spend to zero", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "shopping", allocatedAmount: 500_000n }],
      transactions: [
        expense("shopping", -300_000n),
        reimbursement("shopping", 300_000n),
      ],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(0n)
  })

  test("split-bill reimbursement across multiple payers nets against one category", () => {
    // Pay Apple One Rp319,000 (expense), 4 friends pay back Rp254,450 total
    // across several reimbursement rows — real burden Rp64,550.
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "subscriptions", allocatedAmount: 400_000n }],
      transactions: [
        expense("subscriptions", -319_000n),
        reimbursement("subscriptions", 63_612n),
        reimbursement("subscriptions", 63_613n),
        reimbursement("subscriptions", 63_612n),
        reimbursement("subscriptions", 63_613n),
      ],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(64_550n)
  })

  test("reimbursement exceeding original spend nets to a negative actual (net inflow)", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [expense("food", -50_000n), reimbursement("food", 80_000n)],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(-30_000n)
    expect(result.categories[0]?.isOver).toBe(false)
  })

  test("pending (FX-unresolved) reimbursement is excluded from actual and counted", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [expense("food", -40_000n), reimbursement("food", null)],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(40_000n)
    expect(result.categories[0]?.pendingCount).toBe(1)
  })
})

describe("computeBudgetProgress — uncategorized + unbudgeted", () => {
  test("null-category spend goes to the uncategorized line, never an allocation", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [expense(null, -30_000n), expense(null, null)],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(0n)
    expect(result.uncategorized.actualAmount).toBe(30_000n)
    expect(result.uncategorized.pendingCount).toBe(1)
  })

  test("categorized but unbudgeted spend is not counted in totals or uncategorized", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [expense("entertainment", -90_000n)],
      period: JUNE,
    })
    expect(result.totals.actualAmount).toBe(0n)
    expect(result.uncategorized.actualAmount).toBe(0n)
  })
})

describe("period membership — family-timezone calendar date", () => {
  test("calendarDateInZone resolves to the family-local date", () => {
    // 2026-06-30 23:30 Asia/Jakarta (UTC+7) == 16:30Z.
    expect(
      calendarDateInZone(new Date("2026-06-30T16:30:00.000Z"), "Asia/Jakarta")
    ).toBe("2026-06-30")
    // 2026-07-01 00:00 Asia/Jakarta == previous day 17:00Z.
    expect(
      calendarDateInZone(new Date("2026-06-30T17:00:00.000Z"), "Asia/Jakarta")
    ).toBe("2026-07-01")
  })

  test("late-night June 30 WIB counts in June; just-past-midnight does not", () => {
    expect(
      transactionInPeriod(new Date("2026-06-30T16:30:00.000Z"), JUNE)
    ).toBe(true)
    expect(
      transactionInPeriod(new Date("2026-06-30T17:00:00.000Z"), JUNE)
    ).toBe(false)
  })

  test("computeBudgetProgress excludes out-of-period rows", () => {
    const result = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [
        expense("food", -40_000n, new Date("2026-06-30T16:30:00.000Z")), // in June (WIB)
        expense("food", -99_000n, new Date("2026-06-30T17:00:00.000Z")), // July (WIB)
      ],
      period: JUNE,
    })
    expect(result.categories[0]?.actualAmount).toBe(40_000n)
  })
})

// ADR-0037 §2 follow-up (PER-278) — rollover is additive: `allocatedAmount`
// keeps reporting the raw per-period fact; `rolledOverAmount` /
// `effectiveAllocatedAmount` / `remainingAmount` / `isOver` react to the
// caller-resolved carry-in.
describe("computeBudgetProgress — rolledOverAmount is additive", () => {
  test("omitting rolledOverAmount is identical to passing 0n", () => {
    const withoutField = computeBudgetProgress({
      allocations: [{ categoryId: "food", allocatedAmount: 100_000n }],
      transactions: [expense("food", -60_000n)],
      period: JUNE,
    })
    const withZero = computeBudgetProgress({
      allocations: [
        { categoryId: "food", allocatedAmount: 100_000n, rolledOverAmount: 0n },
      ],
      transactions: [expense("food", -60_000n)],
      period: JUNE,
    })
    expect(withoutField.categories[0]).toEqual(withZero.categories[0])
    expect(withoutField.categories[0]?.rolledOverAmount).toBe(0n)
    expect(withoutField.categories[0]?.effectiveAllocatedAmount).toBe(100_000n)
  })

  test("a carry-in extends effective allocation and remaining, without changing the raw allocatedAmount", () => {
    const result = computeBudgetProgress({
      allocations: [
        {
          categoryId: "food",
          allocatedAmount: 100_000n,
          rolledOverAmount: 50_000n,
        },
      ],
      transactions: [expense("food", -120_000n)],
      period: JUNE,
    })
    const food = result.categories[0]
    expect(food?.allocatedAmount).toBe(100_000n) // raw fact, untouched
    expect(food?.rolledOverAmount).toBe(50_000n)
    expect(food?.effectiveAllocatedAmount).toBe(150_000n)
    expect(food?.actualAmount).toBe(120_000n)
    expect(food?.remainingAmount).toBe(30_000n) // 150k - 120k, not 100k - 120k
    expect(food?.isOver).toBe(false) // would be true against the raw 100k
    expect(result.totals.allocatedAmount).toBe(100_000n)
    expect(result.totals.rolledOverAmount).toBe(50_000n)
    expect(result.totals.remainingAmount).toBe(30_000n)
    expect(result.totals.isOver).toBe(false)
  })
})

// PER-278 / ADR-0037 §2 follow-up — verified against Sure's real
// `Budget::RolloverCalculator#leftover_for`: only a surplus rolls forward,
// compounding across a contiguous run of periods.
describe("foldRolloverCarry", () => {
  test("no prior periods carries nothing (chain seeding)", () => {
    expect(foldRolloverCarry([])).toBe(0n)
  })

  test("a single surplus period carries its leftover forward", () => {
    // allocated 100k, spent 60k -> 40k surplus carries in.
    expect(
      foldRolloverCarry([{ allocatedAmount: 100_000n, actualAmount: 60_000n }])
    ).toBe(40_000n)
  })

  test("an overspend never carries forward as a negative", () => {
    // allocated 100k, spent 150k -> would be -50k; clamped to 0, NOT -50k.
    // This is the corrected behavior vs. ADR-0037's original placeholder
    // ("an overspend carries a negative amount forward") — Sure's real
    // production code (and YNAB) never auto-carries debt; overspend is
    // resolved within the same period via Move Allocation.
    expect(
      foldRolloverCarry([{ allocatedAmount: 100_000n, actualAmount: 150_000n }])
    ).toBe(0n)
  })

  test("surpluses compound across a contiguous carryover run", () => {
    // Jan: 100k alloc, 60k spent -> 40k surplus.
    // Feb: 100k alloc + 40k carry = 140k effective, 90k spent -> 50k surplus.
    // Mar carry-in should be 50k.
    const carry = foldRolloverCarry([
      { allocatedAmount: 100_000n, actualAmount: 60_000n },
      { allocatedAmount: 100_000n, actualAmount: 90_000n },
    ])
    expect(carry).toBe(50_000n)
  })

  test("an overspend period resets the running carry to zero mid-chain", () => {
    // Jan: 40k surplus. Feb: 100k + 40k = 140k effective, 200k spent -> -60k,
    // clamped to 0. Mar carry-in is 0, not a negative 60k debt, and not the
    // stale 40k from Jan either.
    const carry = foldRolloverCarry([
      { allocatedAmount: 100_000n, actualAmount: 60_000n },
      { allocatedAmount: 100_000n, actualAmount: 200_000n },
    ])
    expect(carry).toBe(0n)
  })
})
