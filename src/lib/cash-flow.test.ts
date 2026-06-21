import { describe, expect, test } from "vite-plus/test"
import { convertMinor, encodeRate, IDENTITY_RATE } from "./fx"
import {
  MAX_CASH_FLOW_BUCKETS,
  computeCashFlowReport,
  generateCashFlowBuckets,
  type CashFlowLedgerRowInput,
} from "./cash-flow"

// =============================================================================
// PER-155 / R2 — pure income-statement / cash-flow engine.
//
// All math is Prisma-free and exercised here without a database (the real
// Postgres boundary — transfer exclusion, RLS, split persistence — is proven in
// tests/integration/cash-flow-report.integration.ts). Flow value basis is the
// frozen per-row `baseAmount` (ADR-0038 §2); split children re-derive base from
// the parent's stored rate, exactly as budget-progress does.
// =============================================================================

const TZ = "UTC"
const D = (iso: string) => new Date(iso)

const expenseRow = (
  partial: Partial<CashFlowLedgerRowInput> & { baseAmount: bigint | null }
): CashFlowLedgerRowInput => ({
  type: "expense",
  currency: "IDR",
  baseCurrency: partial.baseAmount === null ? null : "IDR",
  fxRateScaled: partial.baseAmount === null ? null : IDENTITY_RATE,
  date: D("2026-06-15T00:00:00.000Z"),
  isSplit: false,
  categoryId: null,
  merchantId: null,
  splitEntries: [],
  ...partial,
})

const incomeRow = (
  partial: Partial<CashFlowLedgerRowInput> & { baseAmount: bigint | null }
): CashFlowLedgerRowInput =>
  expenseRow({ ...partial, type: "income" }) as CashFlowLedgerRowInput

const report = (transactions: CashFlowLedgerRowInput[]) =>
  computeCashFlowReport({
    from: "2026-06-01",
    to: "2026-06-30",
    interval: "month",
    timezone: TZ,
    transactions,
  })

const cat = (r: ReturnType<typeof report>, id: string | null) =>
  r.byCategory.find((g) => g.categoryId === id)
const merchant = (r: ReturnType<typeof report>, id: string | null) =>
  r.byMerchant.find((g) => g.merchantId === id)

describe("computeCashFlowReport — aggregation", () => {
  test("separates income and expense; net = income − expense", () => {
    const r = report([
      incomeRow({ baseAmount: 200_000n, categoryId: "salary" }),
      expenseRow({
        baseAmount: -50_000n,
        categoryId: "food",
        merchantId: "m1",
      }),
      expenseRow({ baseAmount: -30_000n, categoryId: "fun", merchantId: "m2" }),
    ])

    expect(r.totals.income).toBe(200_000n)
    expect(r.totals.expense).toBe(80_000n)
    expect(r.totals.net).toBe(120_000n)
    expect(r.totals.net).toBe(r.totals.income - r.totals.expense)
  })

  test("groups by category and by merchant independently", () => {
    const r = report([
      incomeRow({ baseAmount: 200_000n, categoryId: "salary" }),
      expenseRow({
        baseAmount: -50_000n,
        categoryId: "food",
        merchantId: "m1",
      }),
      expenseRow({
        baseAmount: -30_000n,
        categoryId: "food",
        merchantId: "m2",
      }),
    ])

    expect(cat(r, "food")?.expense).toBe(80_000n)
    expect(cat(r, "food")?.income).toBe(0n)
    expect(cat(r, "salary")?.income).toBe(200_000n)
    expect(merchant(r, "m1")?.expense).toBe(50_000n)
    expect(merchant(r, "m2")?.expense).toBe(30_000n)
    // income row had no merchant: it lands in the read-only no-merchant line.
    expect(merchant(r, null)?.income).toBe(200_000n)
  })

  test("null categoryId is the read-only uncategorized line", () => {
    const r = report([
      expenseRow({ baseAmount: -25_000n, categoryId: null, merchantId: "m1" }),
    ])
    expect(cat(r, null)?.expense).toBe(25_000n)
  })

  test("the series totals reconcile with the range totals (decomposition)", () => {
    const r = computeCashFlowReport({
      from: "2026-06-01",
      to: "2026-08-31",
      interval: "month",
      timezone: TZ,
      transactions: [
        incomeRow({ baseAmount: 100_000n, date: D("2026-06-10T00:00:00Z") }),
        expenseRow({ baseAmount: -40_000n, date: D("2026-07-10T00:00:00Z") }),
        expenseRow({ baseAmount: -10_000n, date: D("2026-08-10T00:00:00Z") }),
      ],
    })
    const sum = (pick: (b: { income: bigint; expense: bigint }) => bigint) =>
      r.series.reduce((acc, b) => acc + pick(b), 0n)
    expect(sum((b) => b.income)).toBe(r.totals.income)
    expect(sum((b) => b.expense)).toBe(r.totals.expense)
    // Each series bucket is itself net-consistent.
    for (const b of r.series) expect(b.net).toBe(b.income - b.expense)
  })
})

describe("computeCashFlowReport — split attribution", () => {
  test("split children attribute to their own category and merchant", () => {
    const r = report([
      expenseRow({
        baseAmount: -100_000n,
        isSplit: true,
        categoryId: null,
        merchantId: null,
        splitEntries: [
          { categoryId: "food", merchantId: "m1", amount: 60_000n },
          { categoryId: "fun", merchantId: null, amount: 40_000n },
        ],
      }),
    ])
    expect(cat(r, "food")?.expense).toBe(60_000n)
    expect(cat(r, "fun")?.expense).toBe(40_000n)
    expect(merchant(r, "m1")?.expense).toBe(60_000n)
    expect(merchant(r, null)?.expense).toBe(40_000n)
    expect(r.totals.expense).toBe(100_000n)
  })

  test("split children take their income/expense sign from the parent type", () => {
    const r = report([
      incomeRow({
        baseAmount: 90_000n,
        isSplit: true,
        categoryId: null,
        splitEntries: [
          { categoryId: "salary", merchantId: null, amount: 50_000n },
          { categoryId: "bonus", merchantId: null, amount: 40_000n },
        ],
      }),
    ])
    expect(cat(r, "salary")?.income).toBe(50_000n)
    expect(cat(r, "bonus")?.income).toBe(40_000n)
    expect(r.totals.income).toBe(90_000n)
    expect(r.totals.expense).toBe(0n)
  })
})

describe("computeCashFlowReport — multi-currency via frozen baseAmount", () => {
  test("non-split foreign row uses its stored baseAmount verbatim", () => {
    const usdConverted = convertMinor(
      1_000n,
      "USD",
      "IDR",
      encodeRate("16000")
    ) as bigint
    const r = report([
      expenseRow({
        currency: "USD",
        baseCurrency: "IDR",
        fxRateScaled: encodeRate("16000"),
        baseAmount: -usdConverted, // signed, frozen at write time
        categoryId: "food",
      }),
    ])
    expect(cat(r, "food")?.expense).toBe(usdConverted)
    expect(r.totals.expense).toBe(usdConverted)
  })

  test("split children re-derive base from the parent's stored rate (sums to parent)", () => {
    const rate = encodeRate("16000")
    const parentBase = -(convertMinor(1_000n, "USD", "IDR", rate) as bigint)
    const r = report([
      expenseRow({
        currency: "USD",
        baseCurrency: "IDR",
        fxRateScaled: rate,
        baseAmount: parentBase,
        isSplit: true,
        categoryId: null,
        splitEntries: [
          { categoryId: "food", merchantId: null, amount: 600n },
          { categoryId: "fun", merchantId: null, amount: 400n },
        ],
      }),
    ])
    const food = convertMinor(600n, "USD", "IDR", rate)
    const fun = convertMinor(400n, "USD", "IDR", rate)
    expect(cat(r, "food")?.expense).toBe(food)
    expect(cat(r, "fun")?.expense).toBe(fun)
    expect(food + fun).toBe(-parentBase) // children reconcile with parent base
  })
})

describe("computeCashFlowReport — FX-pending", () => {
  test("a pending row is excluded from totals and flagged, never zeroed", () => {
    const r = report([
      expenseRow({ baseAmount: -50_000n, categoryId: "food" }),
      expenseRow({
        currency: "USD",
        baseAmount: null, // FX-pending
        categoryId: "food",
      }),
    ])
    expect(r.totals.expense).toBe(50_000n) // pending USD excluded, not zeroed
    expect(r.totals.unconvertedCount).toBe(1)
    expect(cat(r, "food")?.expense).toBe(50_000n)
    expect(cat(r, "food")?.unconvertedCount).toBe(1)
    expect(r.series.some((b) => b.isPartial)).toBe(true)
  })

  test("a split whose parent is FX-pending flags every child, counts the tx once", () => {
    const r = report([
      expenseRow({
        currency: "USD",
        baseAmount: null,
        fxRateScaled: null,
        baseCurrency: null,
        isSplit: true,
        splitEntries: [
          { categoryId: "food", merchantId: null, amount: 600n },
          { categoryId: "fun", merchantId: null, amount: 400n },
        ],
      }),
    ])
    expect(r.totals.expense).toBe(0n)
    expect(r.totals.unconvertedCount).toBe(1) // one distinct pending transaction
    expect(cat(r, "food")?.unconvertedCount).toBe(1)
    expect(cat(r, "fun")?.unconvertedCount).toBe(1)
  })
})

describe("computeCashFlowReport — period bucketing (family timezone)", () => {
  test("places a row by its family-tz calendar date, not raw UTC", () => {
    // 2026-06-30 19:00 UTC == 2026-07-01 02:00 in Asia/Jakarta (+07).
    const r = computeCashFlowReport({
      from: "2026-07-01",
      to: "2026-07-01",
      interval: "day",
      timezone: "Asia/Jakarta",
      transactions: [
        expenseRow({
          baseAmount: -10_000n,
          date: D("2026-06-30T19:00:00.000Z"),
        }),
      ],
    })
    expect(r.totals.expense).toBe(10_000n)
    expect(r.series).toHaveLength(1)
    expect(r.series[0].expense).toBe(10_000n)
  })

  test("rows outside [from,to] (family-tz) do not count", () => {
    const r = report([
      expenseRow({ baseAmount: -10_000n, date: D("2026-05-31T00:00:00Z") }),
      expenseRow({ baseAmount: -20_000n, date: D("2026-07-01T00:00:00Z") }),
    ])
    expect(r.totals.expense).toBe(0n)
  })
})

describe("generateCashFlowBuckets", () => {
  test("daily buckets are contiguous single days covering [from,to]", () => {
    const buckets = generateCashFlowBuckets("2026-06-01", "2026-06-03", "day")
    expect(buckets).toEqual([
      { periodStart: "2026-06-01", periodEnd: "2026-06-01" },
      { periodStart: "2026-06-02", periodEnd: "2026-06-02" },
      { periodStart: "2026-06-03", periodEnd: "2026-06-03" },
    ])
  })

  test("the final bucket is clamped to `to`", () => {
    const buckets = generateCashFlowBuckets("2026-06-01", "2026-06-10", "week")
    expect(buckets).toEqual([
      { periodStart: "2026-06-01", periodEnd: "2026-06-07" },
      { periodStart: "2026-06-08", periodEnd: "2026-06-10" },
    ])
  })

  test("from > to throws", () => {
    expect(() =>
      generateCashFlowBuckets("2026-06-10", "2026-06-01", "day")
    ).toThrow(RangeError)
  })

  test(`more than ${MAX_CASH_FLOW_BUCKETS} buckets throws`, () => {
    expect(() =>
      generateCashFlowBuckets("2026-01-01", "2027-12-31", "day")
    ).toThrow(RangeError)
  })
})
