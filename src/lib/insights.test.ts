import { describe, expect, test } from "vite-plus/test"
import { RATE_SCALE } from "./fx"
import {
  calendarMonthBounds,
  computeInsights,
  currentMonthInZone,
  EMERGENCY_FUND_INSIGHT_ID,
  INSIGHTS_ENGINE_VERSION,
  RECURRING_BILLS_INSIGHT_ID,
  resolvePaydayAnchor,
  SAVINGS_FLOW_INSIGHT_ID,
  shiftCalendarMonth,
  SINCE_PAYDAY_INSIGHT_ID,
  SPENDING_TREND_INSIGHT_ID,
  type InsightAccountRow,
  type InsightAnchorGapRow,
  type InsightContextInput,
  type InsightFlowRow,
  type InsightFxRateRow,
  type InsightReport,
  type InsightTransferRow,
} from "./insights"
import { buildLatestRateResolver, normalizeNetWorthAt } from "./net-worth"

const JUNE = "2026-06"

/** Mid-June in Asia/Jakarta — the injected clock for the transfer-only tests
 * (`savings_flow` never reads it; `since_payday` deterministically skips). */
const DEFAULT_NOW = new Date("2026-06-15T03:00:00.000Z")

function leg(
  overrides: Partial<InsightTransferRow> & { id: string }
): InsightTransferRow {
  return {
    date: new Date("2026-06-15T03:00:00.000Z"),
    baseAmount: 100_000n,
    accountSubtype: "checking",
    toAccountSubtype: "savings",
    transferId: null,
    transferPurpose: null,
    transferOutflowTransactionId: null,
    transferInflowTransactionId: null,
    ...overrides,
  }
}

/** The two canonical legs of a classic dual-leg transfer, from `fromSubtype`
 * to `toSubtype` (outflow first, exactly as the ledger writes them). The
 * canonical "saved" amount is the INFLOW leg's base projection. */
function classicTransfer(opts: {
  transferId: string
  savedBase: bigint | null
  fromSubtype?: string
  toSubtype?: string
  purpose?: string | null
  date?: Date
}): InsightTransferRow[] {
  const outflowId = `${opts.transferId}-out`
  const inflowId = `${opts.transferId}-in`
  const fromSubtype = opts.fromSubtype ?? "checking"
  const toSubtype = opts.toSubtype ?? "savings"
  const purpose = opts.purpose ?? null
  const date = opts.date ?? new Date("2026-06-15T03:00:00.000Z")
  return [
    leg({
      id: outflowId,
      date,
      // The outflow leg's frozen projection is the negative source amount.
      baseAmount: opts.savedBase === null ? null : -opts.savedBase,
      accountSubtype: fromSubtype,
      toAccountSubtype: toSubtype,
      transferId: opts.transferId,
      transferPurpose: purpose,
      transferOutflowTransactionId: outflowId,
      transferInflowTransactionId: inflowId,
    }),
    leg({
      id: inflowId,
      date,
      baseAmount: opts.savedBase,
      accountSubtype: toSubtype,
      toAccountSubtype: fromSubtype,
      transferId: opts.transferId,
      transferPurpose: purpose,
      transferOutflowTransactionId: outflowId,
      transferInflowTransactionId: inflowId,
    }),
  ]
}

/** One flow-row projection; `baseAmount` mirrors the native amount unless the
 * caller overrides it (pass `null` for FX-pending). */
function flowRow(
  overrides: Partial<InsightFlowRow> & { amount: bigint }
): InsightFlowRow {
  const { amount, ...rest } = overrides
  return {
    accountId: "account-1",
    date: new Date("2026-06-10T03:00:00.000Z"),
    amount,
    baseAmount: amount,
    currency: "IDR",
    baseCurrency: "IDR",
    fxRateScaled: 1_000_000_000_000n,
    isSplit: false,
    splitEntries: [],
    merchantName: null,
    description: "row",
    ...rest,
  }
}

function incomeRow(opts: {
  date: string
  amountMinor: bigint
  description?: string
  baseAmountMinor?: bigint | null
}): InsightFlowRow {
  return flowRow({
    date: new Date(opts.date),
    amount: opts.amountMinor,
    baseAmount:
      opts.baseAmountMinor === undefined
        ? opts.amountMinor
        : opts.baseAmountMinor,
    description: opts.description ?? "income",
  })
}

/** Production-shaped expense: native magnitude positive, frozen `baseAmount`
 * negative (the ledger's sign convention for expense rows). */
function expenseRow(opts: {
  date: string
  amountMinor: bigint
  description?: string
  baseAmountMinor?: bigint | null
}): InsightFlowRow {
  return flowRow({
    date: new Date(opts.date),
    amount: opts.amountMinor,
    baseAmount:
      opts.baseAmountMinor === undefined
        ? -opts.amountMinor
        : opts.baseAmountMinor,
    description: opts.description ?? "expense",
  })
}

/** A monthly salary series on `day` at `hourUtc:00Z` (03:00Z = 10:00 WIB). */
function salarySeries(opts: {
  months: ReadonlyArray<string>
  amountMinor?: bigint
  description?: string
  day?: number
  hourUtc?: number
}): InsightFlowRow[] {
  const day = String(opts.day ?? 25).padStart(2, "0")
  const hour = String(opts.hourUtc ?? 3).padStart(2, "0")
  return opts.months.map((month) =>
    incomeRow({
      date: `${month}-${day}T${hour}:00:00.000Z`,
      amountMinor: opts.amountMinor ?? 20_000_000n,
      description: opts.description ?? "Monthly salary",
    })
  )
}

interface ReportOptions {
  transferRows?: ReadonlyArray<InsightTransferRow>
  incomeRows?: ReadonlyArray<InsightFlowRow>
  expenseRows?: ReadonlyArray<InsightFlowRow>
  anchorGaps?: ReadonlyArray<InsightAnchorGapRow>
  accountRows?: ReadonlyArray<InsightAccountRow>
  fxRateRows?: ReadonlyArray<InsightFxRateRow>
  historyRange?: { start: string; end: string } | null
  month?: string
  timezone?: string
  now?: Date
}

/** The full-input entry point; the transfer-only `report` below delegates. */
function buildReport(options: ReportOptions = {}) {
  return computeInsights({
    timezone: options.timezone ?? "Asia/Jakarta",
    month: options.month ?? JUNE,
    baseCurrency: "IDR",
    now: options.now ?? DEFAULT_NOW,
    transferRows: options.transferRows ?? [],
    incomeRows: options.incomeRows ?? [],
    expenseRows: options.expenseRows ?? [],
    anchorGaps: options.anchorGaps ?? [],
    accountRows: options.accountRows ?? [],
    fxRateRows: options.fxRateRows ?? [],
    historyRange: options.historyRange ?? null,
  })
}

function report(
  rows: ReadonlyArray<InsightTransferRow>,
  month = JUNE,
  timezone = "Asia/Jakarta"
) {
  return buildReport({ transferRows: rows, month, timezone })
}

function metricValue(
  rows: ReadonlyArray<InsightTransferRow>,
  key: string,
  month = JUNE
) {
  const insight = report(rows, month).insights[0]
  return insight?.metrics.find((metric) => metric.key === key)?.value
}

/** One named insight's metric (reports may carry several insights now). */
function insightMetric(
  result: InsightReport,
  insightId: string,
  key: string
): string | undefined {
  return result.insights
    .find((insight) => insight.id === insightId)
    ?.metrics.find((metric) => metric.key === key)?.value
}

/** One named insight card from a report. */
function byId(result: InsightReport, id: string) {
  return result.insights.find((insight) => insight.id === id)
}

describe("calendarMonthBounds", () => {
  test("resolves a 30-day month", () => {
    expect(calendarMonthBounds("2026-06")).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    })
  })

  test("resolves a 28-day February", () => {
    expect(calendarMonthBounds("2026-02")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    })
  })

  test("resolves a leap-year February", () => {
    expect(calendarMonthBounds("2028-02")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    })
  })

  test("rejects a malformed month", () => {
    expect(() => calendarMonthBounds("2026-6")).toThrow(/YYYY-MM/)
    expect(() => calendarMonthBounds("not-a-month")).toThrow(/YYYY-MM/)
  })

  test("rejects an out-of-range month", () => {
    expect(() => calendarMonthBounds("2026-13")).toThrow(/out of range/)
  })
})

describe("currentMonthInZone", () => {
  test("cuts the month in the family timezone, not UTC", () => {
    // 2026-06-30T20:00Z is still June in UTC but already July 1st in Jakarta.
    const instant = new Date("2026-06-30T20:00:00.000Z")
    expect(currentMonthInZone(instant, "UTC")).toBe("2026-06")
    expect(currentMonthInZone(instant, "Asia/Jakarta")).toBe("2026-07")
  })
})

describe("computeInsights — savings_flow", () => {
  /** The card-specific skips recorded on ANY empty report — savings_flow
   * carries its own per-test reason below, but every other card always
   * skips for the same fixed reason. */
  const CARD_SKIPS = [
    {
      id: SINCE_PAYDAY_INSIGHT_ID,
      reason: "no monthly recurring income series detected",
    },
    {
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "no account is designated as savings",
    },
    {
      id: RECURRING_BILLS_INSIGHT_ID,
      reason: "fewer than three complete months of recorded history",
    },
    {
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    },
  ]

  test("counts a two-leg transfer into savings exactly once, using the inflow projection", () => {
    const rows = classicTransfer({
      transferId: "tr-1",
      savedBase: 500_000n,
      purpose: "savings",
    })

    const result = report(rows)
    expect(result.engineVersion).toBe(INSIGHTS_ENGINE_VERSION)
    expect(result.failedCount).toBe(0)
    expect(result.window).toEqual({
      kind: "calendar_month",
      start: "2026-06-01",
      end: "2026-06-30",
      timezone: "Asia/Jakarta",
    })

    expect(result.insights).toHaveLength(1)
    const insight = result.insights[0]
    expect(insight.id).toBe(SAVINGS_FLOW_INSIGHT_ID)
    expect(insight.partial).toBe(false)
    expect(insight.fxPendingCount).toBe(0)
    expect(metricValue(rows, "saved")).toBe("500000")
    expect(metricValue(rows, "transfer_count")).toBe("1")
  })

  test("a transfer is never counted as income or expense — only as saved", () => {
    // The fold consumes transfer rows only; an income/expense-shaped row would
    // simply not be part of this input. Guard the headline number against a
    // double count by asserting one row-group yields exactly one saved unit.
    const rows = classicTransfer({
      transferId: "tr-1",
      savedBase: 100_000n,
      purpose: "savings",
    })
    expect(metricValue(rows, "transfer_count")).toBe("1")
    expect(metricValue(rows, "saved")).toBe("100000")
  })

  test("counts multiple qualifying transfers separately", () => {
    const rows = [
      ...classicTransfer({
        transferId: "tr-1",
        savedBase: 500_000n,
        purpose: "savings",
      }),
      ...classicTransfer({
        transferId: "tr-2",
        savedBase: 1_000_000n,
        fromSubtype: "checking",
        toSubtype: "brokerage",
        purpose: "investment_contribution",
      }),
    ]
    expect(metricValue(rows, "saved")).toBe("1500000")
    expect(metricValue(rows, "transfer_count")).toBe("2")
  })

  test("qualifies by destination subtype even with no purpose label", () => {
    const rows = classicTransfer({
      transferId: "tr-1",
      savedBase: 250_000n,
      toSubtype: "savings",
      purpose: null,
    })
    expect(metricValue(rows, "saved")).toBe("250000")
    expect(metricValue(rows, "transfer_count")).toBe("1")
  })

  test("qualifies by investment purpose even when the destination is not a savings subtype", () => {
    const rows = classicTransfer({
      transferId: "tr-1",
      savedBase: 300_000n,
      toSubtype: "crypto_wallet",
      purpose: "investment_contribution",
    })
    expect(metricValue(rows, "saved")).toBe("300000")
  })

  test("excludes an e-wallet top-up", () => {
    const rows = classicTransfer({
      transferId: "tr-1",
      savedBase: 100_000n,
      toSubtype: "cash",
      purpose: "top_up",
    })
    const result = report(rows)
    expect(result.insights).toHaveLength(0)
    expect(result.skipped).toEqual([
      {
        id: SAVINGS_FLOW_INSIGHT_ID,
        reason: "no savings or investment transfers in the window",
      },
      ...CARD_SKIPS,
    ])
  })

  test("excludes a withdrawal out of savings", () => {
    const rows = classicTransfer({
      transferId: "tr-1",
      savedBase: 400_000n,
      fromSubtype: "savings",
      toSubtype: "checking",
      purpose: null,
    })
    expect(report(rows).insights).toHaveLength(0)
  })

  test("excludes rows outside the family-tz month, including the zone boundary", () => {
    // 2026-06-30T20:00Z is already 2026-07-01 03:00 in Asia/Jakarta.
    const boundary = classicTransfer({
      transferId: "tr-1",
      savedBase: 900_000n,
      purpose: "savings",
      date: new Date("2026-06-30T20:00:00.000Z"),
    })
    expect(report(boundary, "2026-06").insights).toHaveLength(0)
    expect(metricValue(boundary, "saved", "2026-07")).toBe("900000")
  })

  test("excludes an FX-pending transfer from the total but counts it", () => {
    const rows = [
      ...classicTransfer({ transferId: "tr-1", savedBase: 500_000n }),
      ...classicTransfer({ transferId: "tr-2", savedBase: null }),
    ]
    const result = report(rows)
    expect(result.insights).toHaveLength(1)
    expect(metricValue(rows, "saved")).toBe("500000")
    expect(metricValue(rows, "transfer_count")).toBe("1")
    expect(metricValue(rows, "fx_pending_count")).toBe("1")
    expect(result.insights[0].partial).toBe(true)
  })

  test("never reports a confident zero: all-pending still surfaces the pending count", () => {
    const rows = classicTransfer({ transferId: "tr-1", savedBase: null })
    const result = report(rows)
    expect(result.insights).toHaveLength(1)
    expect(metricValue(rows, "saved")).toBe("0")
    expect(metricValue(rows, "fx_pending_count")).toBe("1")
    expect(result.insights[0].partial).toBe(true)
  })

  test("skips with a reason when there are no transfers at all", () => {
    const result = report([])
    expect(result.insights).toHaveLength(0)
    expect(result.skipped).toEqual([
      { id: SAVINGS_FLOW_INSIGHT_ID, reason: "no transfers in the window" },
      ...CARD_SKIPS,
    ])
  })

  test("counts a legacy unpaired transfer row by its destination subtype", () => {
    const rows = [
      leg({
        id: "tx-legacy",
        baseAmount: -150_000n,
        accountSubtype: "checking",
        toAccountSubtype: "savings",
      }),
    ]
    expect(metricValue(rows, "saved")).toBe("150000")
    expect(metricValue(rows, "transfer_count")).toBe("1")
  })

  test("counts a valuation-linked contribution from its single cash outflow leg", () => {
    const rows = [
      leg({
        id: "cash-leg",
        baseAmount: -2_000_000n,
        accountSubtype: "checking",
        toAccountSubtype: "gold",
        transferId: "tr-1",
        transferPurpose: "investment_contribution",
        transferOutflowTransactionId: "cash-leg",
        transferInflowTransactionId: null,
      }),
    ]
    expect(metricValue(rows, "saved")).toBe("2000000")
    expect(metricValue(rows, "transfer_count")).toBe("1")
  })

  test("isolates a failing derivation without losing the rest of the report", () => {
    const result = computeInsights(
      {
        timezone: "Asia/Jakarta",
        month: JUNE,
        baseCurrency: "IDR",
        now: DEFAULT_NOW,
        transferRows: classicTransfer({ transferId: "tr-1", savedBase: 1n }),
        incomeRows: [],
        expenseRows: [],
        anchorGaps: [],
        accountRows: [],
        fxRateRows: [],
        historyRange: null,
      },
      [
        {
          id: "explodes",
          run: () => {
            throw new Error("boom")
          },
        },
      ]
    )
    expect(result.insights).toHaveLength(0)
    expect(result.failedCount).toBe(1)

    const withSavings = computeInsights(
      {
        timezone: "Asia/Jakarta",
        month: JUNE,
        baseCurrency: "IDR",
        now: DEFAULT_NOW,
        transferRows: classicTransfer({ transferId: "tr-1", savedBase: 10n }),
        incomeRows: [],
        expenseRows: [],
        anchorGaps: [],
        accountRows: [],
        fxRateRows: [],
        historyRange: null,
      } satisfies InsightContextInput,
      [
        {
          id: "explodes",
          run: () => {
            throw new Error("boom")
          },
        },
        {
          id: SAVINGS_FLOW_INSIGHT_ID,
          run: (context) => ({
            insight: {
              id: SAVINGS_FLOW_INSIGHT_ID,
              tone: "positive",
              title: "Saved this month",
              summary: "test",
              metrics: [],
              partial: false,
              fxPendingCount: 0,
              periodPartial: false,
              periodGaps: [],
              window: context.window,
              engineVersion: INSIGHTS_ENGINE_VERSION,
            },
          }),
        },
      ]
    )
    expect(withSavings.failedCount).toBe(1)
    expect(withSavings.insights).toHaveLength(1)
  })
})

describe("resolvePaydayAnchor", () => {
  const NOW = new Date("2026-07-10T03:00:00.000Z") // 2026-07-10 10:00 WIB

  test("picks the largest monthly income series and localizes its dates", () => {
    const salary = salarySeries({ months: ["2026-04", "2026-05", "2026-06"] })
    const sideGig = salarySeries({
      months: ["2026-04", "2026-05", "2026-06"],
      amountMinor: 5_000_000n,
      day: 5,
      description: "Side gig",
    })

    // `nextExpected` is the detector's own average-gap projection (30/31-day
    // gaps → 31), not calendar-month arithmetic: 2026-06-25 + 31d = 07-26.
    expect(
      resolvePaydayAnchor([...salary, ...sideGig], NOW, "Asia/Jakarta")
    ).toEqual({
      paydayDate: "2026-06-25",
      nextExpectedDate: "2026-07-26",
    })
  })

  test("never anchors on a non-monthly series, even a much larger one", () => {
    const salary = salarySeries({
      months: ["2026-04", "2026-05", "2026-06"],
      amountMinor: 5_000_000n,
      day: 1,
    })
    const weekly = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"].map(
      (date) =>
        incomeRow({
          date: `${date}T03:00:00.000Z`,
          amountMinor: 40_000_000n,
          description: "Weekly payout",
        })
    )

    const anchor = resolvePaydayAnchor(
      [...salary, ...weekly],
      NOW,
      "Asia/Jakarta"
    )
    expect(anchor?.paydayDate).toBe("2026-06-01")
  })

  test("returns null when the series stopped recurring (staleness guard)", () => {
    // Last occurrence 2026-04-01 is 100 days before NOW — beyond the
    // detector's two-cadence-bands (~70 days) guard: a cancelled salary,
    // never an anchor.
    const stale = salarySeries({
      months: ["2026-02", "2026-03", "2026-04"],
      day: 1,
    })
    expect(resolvePaydayAnchor(stale, NOW, "Asia/Jakarta")).toBeNull()
  })

  test("returns null without three stable monthly occurrences", () => {
    expect(resolvePaydayAnchor([], NOW, "Asia/Jakarta")).toBeNull()
    const twoOccurrences = salarySeries({ months: ["2026-05", "2026-06"] })
    expect(resolvePaydayAnchor(twoOccurrences, NOW, "Asia/Jakarta")).toBeNull()
  })

  test("uses the occurrence instant's family-tz calendar date", () => {
    // 2026-06-25T20:00Z is already 2026-06-26 03:00 in Jakarta — the payday
    // date (and every window cut at it) must be the family's calendar date.
    const evening = salarySeries({
      months: ["2026-04", "2026-05", "2026-06"],
      hourUtc: 20,
    })
    expect(resolvePaydayAnchor(evening, NOW, "Asia/Jakarta")?.paydayDate).toBe(
      "2026-06-26"
    )
  })
})

describe("computeInsights — since_payday", () => {
  const NOW = new Date("2026-07-10T03:00:00.000Z") // 2026-07-10 10:00 WIB
  const SALARY = salarySeries({ months: ["2026-04", "2026-05", "2026-06"] })

  test("folds household cash flow inside the payday window (income − spending)", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: [
        ...SALARY,
        // Before the anchor — outside the window even though it is income.
        incomeRow({
          date: "2026-06-20T03:00:00.000Z",
          amountMinor: 9_000_000n,
          description: "Late invoice",
        }),
        incomeRow({
          date: "2026-07-05T03:00:00.000Z",
          amountMinor: 3_000_000n,
          description: "Freelance",
        }),
      ],
      expenseRows: [
        expenseRow({
          date: "2026-06-20T03:00:00.000Z",
          amountMinor: 1_000_000n,
        }),
        expenseRow({
          date: "2026-07-02T03:00:00.000Z",
          amountMinor: 12_000_000n,
        }),
      ],
    })

    expect(result.window).toEqual({
      kind: "calendar_month",
      start: "2026-07-01",
      end: "2026-07-31",
      timezone: "Asia/Jakarta",
    })
    expect(result.insights.map((insight) => insight.id)).toEqual([
      SINCE_PAYDAY_INSIGHT_ID,
    ])

    const insight = result.insights[0]
    expect(insight.window).toEqual({
      kind: "since_payday",
      start: "2026-06-25",
      end: "2026-07-10",
      timezone: "Asia/Jakarta",
    })
    expect(insight.tone).toBe("positive")
    expect(insight.partial).toBe(false)
    expect(insight.summary).toBe(
      "Income minus spending since your last payday (2026-06-25)."
    )
    // 20,000,000 (salary) + 3,000,000 (freelance) − 12,000,000 (spending).
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "left")).toBe(
      "11000000"
    )
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "spent")).toBe(
      "12000000"
    )
    expect(
      insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "fx_pending_count")
    ).toBe("0")
  })

  test("reports a negative left with an attention tone", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: SALARY,
      expenseRows: [
        expenseRow({
          date: "2026-07-02T03:00:00.000Z",
          amountMinor: 25_000_000n,
        }),
      ],
    })
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "left")).toBe(
      "-5000000"
    )
    expect(result.insights[0].tone).toBe("attention")
  })

  test("cuts the window on the family-tz calendar date, not the UTC date", () => {
    const evening = salarySeries({
      months: ["2026-04", "2026-05", "2026-06"],
      hourUtc: 20,
    })
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: evening,
      expenseRows: [
        // 2026-06-25 23:00 in Jakarta — one hour before the anchor.
        expenseRow({
          date: "2026-06-25T16:00:00.000Z",
          amountMinor: 500_000n,
        }),
        // 2026-06-26 00:30 in Jakarta — inside the window.
        expenseRow({
          date: "2026-06-25T17:30:00.000Z",
          amountMinor: 300_000n,
        }),
      ],
    })
    expect(result.insights[0].window.start).toBe("2026-06-26")
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "spent")).toBe(
      "300000"
    )
  })

  test("excludes and counts FX-pending rows on both sides", () => {
    const withPendingJune = salarySeries({
      months: ["2026-04", "2026-05", "2026-06"],
    }).map((row) =>
      row.date.getTime() === Date.parse("2026-06-25T03:00:00.000Z")
        ? { ...row, baseAmount: null }
        : row
    )

    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: [
        ...withPendingJune,
        incomeRow({
          date: "2026-07-05T03:00:00.000Z",
          amountMinor: 2_000_000n,
          description: "Freelance",
        }),
      ],
      expenseRows: [
        expenseRow({
          date: "2026-07-02T03:00:00.000Z",
          amountMinor: 4_000_000n,
          baseAmountMinor: null,
        }),
        expenseRow({
          date: "2026-07-03T03:00:00.000Z",
          amountMinor: 5_000_000n,
        }),
      ],
    })

    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "left")).toBe(
      "-3000000"
    )
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "spent")).toBe(
      "5000000"
    )
    expect(
      insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "fx_pending_count")
    ).toBe("2")
    expect(result.insights[0].partial).toBe(true)
  })

  test("folds split children through the parent's stored rate, not the parent's projection", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: SALARY,
      expenseRows: [
        flowRow({
          date: new Date("2026-07-02T03:00:00.000Z"),
          amount: 12_000_000n,
          // Intentionally NOT the children's sum: proof the fold consumes the
          // children (the cash-flow/budget rule), never the parent projection.
          baseAmount: -11_999_999n,
          isSplit: true,
          splitEntries: [{ amount: 7_000_000n }, { amount: 5_000_000n }],
        }),
      ],
    })
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "spent")).toBe(
      "12000000"
    )
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "left")).toBe(
      "8000000"
    )
  })

  test("counts a pending split parent once, never once per child", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: SALARY,
      expenseRows: [
        flowRow({
          date: new Date("2026-07-02T03:00:00.000Z"),
          amount: 12_000_000n,
          baseAmount: null,
          fxRateScaled: null,
          baseCurrency: null,
          isSplit: true,
          splitEntries: [{ amount: 7_000_000n }, { amount: 5_000_000n }],
        }),
      ],
    })
    expect(
      insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "fx_pending_count")
    ).toBe("1")
    expect(insightMetric(result, SINCE_PAYDAY_INSIGHT_ID, "spent")).toBe("0")
  })

  test("skips for a month that is not the family's current month", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-06",
      incomeRows: SALARY,
      expenseRows: [
        expenseRow({
          date: "2026-06-15T03:00:00.000Z",
          amountMinor: 1_000_000n,
        }),
      ],
    })
    expect(result.insights.map((insight) => insight.id)).toEqual([])
    expect(result.skipped).toContainEqual({
      id: SINCE_PAYDAY_INSIGHT_ID,
      reason: "since payday only applies to the family's current month",
    })
  })

  test("skips when the household has no monthly income series", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      incomeRows: [
        // Irregular income is not a salary: no cadence band holds its gaps.
        incomeRow({
          date: "2026-05-02T03:00:00.000Z",
          amountMinor: 4_000_000n,
        }),
        incomeRow({
          date: "2026-05-20T03:00:00.000Z",
          amountMinor: 4_000_000n,
        }),
        incomeRow({
          date: "2026-07-01T03:00:00.000Z",
          amountMinor: 4_000_000n,
        }),
      ],
    })
    expect(result.insights.map((insight) => insight.id)).toEqual([])
    expect(result.skipped).toContainEqual({
      id: SINCE_PAYDAY_INSIGHT_ID,
      reason: "no monthly recurring income series detected",
    })
  })

  test("surfaces alongside savings_flow in the registry order", () => {
    const result = buildReport({
      now: NOW,
      month: "2026-07",
      transferRows: classicTransfer({
        transferId: "tr-1",
        savedBase: 500_000n,
        purpose: "savings",
        date: new Date("2026-07-02T03:00:00.000Z"),
      }),
      incomeRows: SALARY,
    })
    expect(result.insights.map((insight) => insight.id)).toEqual([
      SAVINGS_FLOW_INSIGHT_ID,
      SINCE_PAYDAY_INSIGHT_ID,
    ])
    expect(result.engineVersion).toBe(INSIGHTS_ENGINE_VERSION)
  })
})

describe("computeInsights — period completeness (PER-443)", () => {
  const NOW = new Date("2026-07-10T03:00:00.000Z") // 2026-07-10 10:00 WIB
  const SALARY = salarySeries({ months: ["2026-04", "2026-05", "2026-06"] })

  function gap(
    overrides: Partial<InsightAnchorGapRow> = {}
  ): InsightAnchorGapRow {
    return {
      accountId: "acc-1",
      accountName: "Bank Jago",
      currency: "IDR",
      fromDate: "2026-06-03",
      toDate: "2026-06-28",
      amount: 6_762_000n,
      fromSource: "manual",
      toSource: "pit_stop",
      ...overrides,
    }
  }

  test("marks savings_flow partially recorded when a live gap intersects its month", () => {
    const result = buildReport({
      transferRows: classicTransfer({
        transferId: "tr-1",
        savedBase: 500_000n,
      }),
      anchorGaps: [gap()],
    })

    const insight = byId(result, SAVINGS_FLOW_INSIGHT_ID)
    expect(insight?.periodPartial).toBe(true)
    expect(insight?.periodGaps).toEqual([
      {
        accountId: "acc-1",
        accountName: "Bank Jago",
        currency: "IDR",
        fromDate: "2026-06-03",
        toDate: "2026-06-28",
        amount: "6762000",
      },
    ])
  })

  test("leaves the qualifier off when no gap intersects the window", () => {
    const result = buildReport({
      transferRows: classicTransfer({
        transferId: "tr-1",
        savedBase: 500_000n,
      }),
      anchorGaps: [gap({ fromDate: "2026-01-01", toDate: "2026-01-31" })],
    })

    const insight = byId(result, SAVINGS_FLOW_INSIGHT_ID)
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
  })

  test("ignores migration-softened gaps (known by design, not a live hole)", () => {
    const result = buildReport({
      transferRows: classicTransfer({
        transferId: "tr-1",
        savedBase: 500_000n,
      }),
      anchorGaps: [
        gap({ fromSource: "migration:sure", toSource: "migration:sure" }),
      ],
    })

    const insight = byId(result, SAVINGS_FLOW_INSIGHT_ID)
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
  })

  test("stays alarming when only ONE end is migration-sourced", () => {
    const result = buildReport({
      transferRows: classicTransfer({
        transferId: "tr-1",
        savedBase: 500_000n,
      }),
      anchorGaps: [gap({ fromSource: "migration:sure", toSource: "pit_stop" })],
    })

    expect(byId(result, SAVINGS_FLOW_INSIGHT_ID)?.periodPartial).toBe(true)
  })

  test("each derivation intersects its OWN window, not the report's", () => {
    const transferRows = classicTransfer({
      transferId: "tr-1",
      savedBase: 500_000n,
      date: new Date("2026-07-02T03:00:00.000Z"),
    })

    // Inside since_payday (2026-06-25 → 2026-07-10) but before the July month.
    const paydayOnly = buildReport({
      now: NOW,
      month: "2026-07",
      transferRows,
      incomeRows: SALARY,
      anchorGaps: [gap({ fromDate: "2026-06-26", toDate: "2026-06-30" })],
    })
    expect(byId(paydayOnly, SINCE_PAYDAY_INSIGHT_ID)?.periodPartial).toBe(true)
    expect(byId(paydayOnly, SAVINGS_FLOW_INSIGHT_ID)?.periodPartial).toBe(false)

    // Inside the July month but after since_payday's end (today, 2026-07-10).
    const monthOnly = buildReport({
      now: NOW,
      month: "2026-07",
      transferRows,
      incomeRows: SALARY,
      anchorGaps: [gap({ fromDate: "2026-07-12", toDate: "2026-07-20" })],
    })
    expect(byId(monthOnly, SAVINGS_FLOW_INSIGHT_ID)?.periodPartial).toBe(true)
    expect(byId(monthOnly, SINCE_PAYDAY_INSIGHT_ID)?.periodPartial).toBe(false)
  })
})

describe("shiftCalendarMonth", () => {
  test("shifts across the year boundary", () => {
    expect(shiftCalendarMonth("2026-01", -1)).toBe("2025-12")
    expect(shiftCalendarMonth("2025-12", 1)).toBe("2026-01")
  })

  test("shifts the trailing-window anchors of a July request", () => {
    expect(shiftCalendarMonth("2026-07", -6)).toBe("2026-01")
    expect(shiftCalendarMonth("2026-07", -1)).toBe("2026-06")
  })

  test("rejects a malformed month", () => {
    expect(() => shiftCalendarMonth("2026-7", -1)).toThrow(/YYYY-MM/)
    expect(() => shiftCalendarMonth("July", 1)).toThrow(/YYYY-MM/)
  })
})

describe("computeInsights — emergency_fund (PER-227 slice #3)", () => {
  const JULY = "2026-07"
  /** Ledger rows exist from 2026-01-01 through 2026-07-05: all six burn
   * months (Jan–Jun) are COMPLETE; July is the still-accumulating month. */
  const FULL_HISTORY: { start: string; end: string } = {
    start: "2026-01-01",
    end: "2026-07-05",
  }

  function savingsAccount(
    overrides: Partial<InsightAccountRow> & { id: string }
  ): InsightAccountRow {
    return {
      name: `Account ${overrides.id}`,
      accountClass: "ASSET",
      accountSubtype: "savings",
      currency: "IDR",
      nativeBalance: 1_000_000n,
      status: "active",
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    }
  }

  /** An expense on the 10th of `month` at 10:00 WIB (03:00Z). */
  function monthExpense(month: string, amountMinor: bigint): InsightFlowRow {
    return expenseRow({
      date: `${month}-10T03:00:00.000Z`,
      amountMinor,
    })
  }

  test("targets 6× the trailing-six-complete-months burn, excluding the current partial month", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({
          id: "acc-1",
          name: "Tabungan",
          nativeBalance: 4_000_000n,
        }),
        savingsAccount({
          id: "acc-2",
          name: "Reksadana",
          nativeBalance: 3_000_000n,
        }),
      ],
      expenseRows: [
        monthExpense("2026-01", 1_000_000n),
        monthExpense("2026-02", 1_000_000n),
        monthExpense("2026-03", 1_000_000n),
        monthExpense("2026-04", 2_000_000n),
        monthExpense("2026-05", 3_000_000n),
        monthExpense("2026-06", 5_000_000n),
        // July is still accumulating: 10M here must NOT enter the average.
        monthExpense(JULY, 10_000_000n),
      ],
    })

    expect(result.failedCount).toBe(0)
    const insight = byId(result, EMERGENCY_FUND_INSIGHT_ID)
    expect(insight).toBeDefined()
    // 1+1+1+2+3+5 = 13M spent over 6 complete months → target = 13M×6/6.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "7000000"
    )
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "13000000"
    )
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "gap")).toBe(
      "6000000"
    )
    expect(insight?.tone).toBe("attention")
    expect(insight?.window).toEqual({
      kind: "trailing_6_months",
      start: "2026-01-01",
      end: "2026-06-30",
      timezone: "Asia/Jakarta",
    })
    expect(insight?.detail).toBe(
      "Based on 6 complete months of recorded spending."
    )
    // Full window: no months-used disclosure.
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "partial_window")
    ).toBeUndefined()
    expect(insight?.partial).toBe(false)
  })

  test("orders metrics so the generic renderer reads Saved as the headline", () => {
    const full = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    const fullInsight = byId(full, EMERGENCY_FUND_INSIGHT_ID)
    expect(fullInsight?.metrics.map((metric) => metric.key)).toEqual([
      "saved",
      "target",
      "gap",
      "counted_accounts",
      "fx_pending_count",
    ])
    // Headline contract: the FIRST money metric carries the currency.
    expect(fullInsight?.metrics[0]).toEqual({
      key: "saved",
      label: "Saved",
      value: "1000000",
      currency: "IDR",
    })

    // A partial window inserts months-used between gap and counted accounts.
    const partial = buildReport({
      month: JULY,
      historyRange: { start: "2026-04-15", end: "2026-07-05" },
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [monthExpense("2026-05", 1_000_000n)],
    })
    expect(
      byId(partial, EMERGENCY_FUND_INSIGHT_ID)?.metrics.map((m) => m.key)
    ).toEqual([
      "saved",
      "target",
      "gap",
      "partial_window",
      "counted_accounts",
      "fx_pending_count",
    ])
  })

  test("folds split children through the parent's stored rate, never the parent projection", () => {
    const result = buildReport({
      month: JULY,
      historyRange: { start: "2026-04-01", end: "2026-06-30" },
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [
        monthExpense("2026-04", 1_000_000n),
        monthExpense("2026-05", 1_000_000n),
        flowRow({
          date: new Date("2026-06-10T03:00:00.000Z"),
          amount: 5_000_000n,
          // Intentionally NOT the children's sum: the fold must consume the
          // children (the cash-flow/budget rule).
          baseAmount: -4_999_999n,
          isSplit: true,
          splitEntries: [{ amount: 2_000_000n }, { amount: 3_000_000n }],
        }),
      ],
    })
    // spent = 1M + 1M + 5M(children) = 7M over 3 months → 42M/3 = 14M.
    // (The parent projection would have yielded 41_999_994/3 = 13_999_998.)
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "14000000"
    )
  })

  test("discloses a partial window: mid-month onboarding months are excluded, never diluted", () => {
    const result = buildReport({
      month: JULY,
      // First ledger row on 2026-04-15: April is NOT covered end-to-end,
      // so only May and June count — April's 3M burn is excluded, not
      // averaged in as a fragment.
      historyRange: { start: "2026-04-15", end: "2026-06-30" },
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [
        monthExpense("2026-04", 3_000_000n),
        monthExpense("2026-05", 2_000_000n),
        monthExpense("2026-06", 4_000_000n),
      ],
    })
    // spent = 6M over 2 months → 36M/2 = 18M.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "18000000"
    )
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "partial_window")
    ).toBe("2 of 6")
    expect(byId(result, EMERGENCY_FUND_INSIGHT_ID)?.detail).toBe(
      "Based on 2 complete months of recorded spending."
    )
  })

  test("excludes months after a lapsed recording period (history ends mid-window)", () => {
    const result = buildReport({
      month: JULY,
      // The family recorded Jan 1 → Mar 10 and then stopped: March is not
      // complete, Apr–Jun have no recorded history at all.
      historyRange: { start: "2026-01-01", end: "2026-03-10" },
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [
        monthExpense("2026-01", 1_000_000n),
        monthExpense("2026-02", 2_000_000n),
        monthExpense("2026-03", 9_000_000n),
      ],
    })
    // spent = 3M over 2 months (Jan, Feb) → 18M/2 = 9M; March's 9M excluded.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "9000000"
    )
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "partial_window")
    ).toBe("2 of 6")
  })

  test("counts a covered month with zero recorded rows as zero burn", () => {
    const result = buildReport({
      month: JULY,
      // History covers Apr–Jun end-to-end, but only May has spending rows:
      // April and June are honest zero-burn months, diluting the average.
      historyRange: { start: "2026-04-01", end: "2026-06-30" },
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [monthExpense("2026-05", 6_000_000n)],
    })
    // spent = 6M over 3 months → 36M/3 = 12M.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "12000000"
    )
  })

  test("truncates the target rather than rounding the family's hurdle up", () => {
    const result = buildReport({
      month: JULY,
      // Four complete months (Mar–Jun).
      historyRange: { start: "2026-03-01", end: "2026-06-30" },
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [monthExpense("2026-03", 7_000_001n)],
    })
    // 7_000_001×6 = 42_000_006, /4 = 10_500_001.5 → 10_500_001 (truncated).
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "10500001"
    )
  })

  test("skips — never a guessed average — when fewer than two complete months exist", () => {
    const accountRows = [savingsAccount({ id: "acc-1", name: "Tabungan" })]

    // Only June is covered end-to-end (first row 2026-05-15 excludes May).
    const oneMonth = buildReport({
      month: JULY,
      historyRange: { start: "2026-05-15", end: "2026-06-30" },
      accountRows,
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(byId(oneMonth, EMERGENCY_FUND_INSIGHT_ID)).toBeUndefined()
    expect(oneMonth.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })

    // No recorded ledger at all.
    const noHistory = buildReport({
      month: JULY,
      historyRange: null,
      accountRows,
      expenseRows: [],
    })
    expect(byId(noHistory, EMERGENCY_FUND_INSIGHT_ID)).toBeUndefined()
    expect(noHistory.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })
  })

  test("skips when no account is designated as savings (qualification is not vacuous)", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        // A checking account: ASSET but not the savings product subtype.
        savingsAccount({
          id: "acc-1",
          name: "Wallet",
          accountSubtype: "checking",
          nativeBalance: 99_000_000n,
        }),
        // A savings-FLAVOURED liability is debt, never a fund.
        savingsAccount({
          id: "acc-2",
          name: "Card",
          accountClass: "LIABILITY",
          nativeBalance: -5_000_000n,
        }),
        // A soft-deleted savings account has stopped being part of the fund.
        savingsAccount({
          id: "acc-3",
          name: "Old savings",
          deletedAt: new Date("2026-06-01T00:00:00.000Z"),
          nativeBalance: 8_000_000n,
        }),
        // An ARCHIVED (soft-closed) savings account: balance survives the
        // close, but the money is no longer actively managed — not the fund.
        savingsAccount({
          id: "acc-4",
          name: "Archived savings",
          status: "closed",
          archivedAt: new Date("2026-06-02T00:00:00.000Z"),
          nativeBalance: 7_000_000n,
        }),
      ],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(result.insights.map((insight) => insight.id)).not.toContain(
      EMERGENCY_FUND_INSIGHT_ID
    )
    expect(result.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "no account is designated as savings",
    })
  })

  test("counts exactly the designated accounts: any accountType, never deleted, never archived, never liability", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({
          id: "acc-1",
          name: "Wallet",
          accountSubtype: "checking",
          nativeBalance: 99_000_000n,
        }),
        savingsAccount({
          id: "acc-2",
          name: "Tabungan",
          nativeBalance: 2_000_000n,
        }),
        // An INVESTMENT-class ASSET with the savings subtype counts — the
        // emergency-fund money parked in a money-market fund.
        savingsAccount({
          id: "acc-3",
          name: "Reksadana",
          nativeBalance: 3_000_000n,
        }),
        savingsAccount({
          id: "acc-4",
          name: "Old savings",
          deletedAt: new Date("2026-06-01T00:00:00.000Z"),
          nativeBalance: 8_000_000n,
        }),
        // Archived (soft-closed): the balance row survives but the money is
        // no longer actively managed — excluded, never silently counted.
        savingsAccount({
          id: "acc-5",
          name: "Archived savings",
          status: "closed",
          archivedAt: new Date("2026-06-02T00:00:00.000Z"),
          nativeBalance: 7_000_000n,
        }),
        savingsAccount({
          id: "acc-6",
          name: "Card",
          accountClass: "LIABILITY",
          nativeBalance: -5_000_000n,
        }),
      ],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    // The fold sorts the names ITSELF — determinism is a local contract, not
    // a dependency on the seam's read order.
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("Reksadana, Tabungan")
  })

  test("caps the counted-accounts listing at three names then +n", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({ id: "a", name: "A", nativeBalance: 1n }),
        savingsAccount({ id: "b", name: "B", nativeBalance: 2n }),
        savingsAccount({ id: "c", name: "C", nativeBalance: 3n }),
        savingsAccount({ id: "d", name: "D", nativeBalance: 4n }),
        savingsAccount({ id: "e", name: "E", nativeBalance: 5n }),
      ],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe("15")
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("A, B, C +2")
  })

  test("sorts counted accounts with localeCompare, not byte order — pins the comparator contract (Sonar S2871)", () => {
    // Byte order (UTF-16 code units) puts uppercase first: "DanaB, Zakat,
    // dana darurat". Locale order folds case at the primary level and weighs
    // the space below letters, so the card prints "dana darurat, DanaB,
    // Zakat". The comparator is part of the counted-accounts contract — if
    // anyone reverts to `<`/`>`, this test fails.
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({ id: "acc-1", name: "Zakat" }),
        savingsAccount({ id: "acc-2", name: "dana darurat" }),
        savingsAccount({ id: "acc-3", name: "DanaB" }),
      ],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("dana darurat, DanaB, Zakat")
  })

  test("renders a genuine zero balance as zero — not as a skip", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({ id: "acc-1", name: "Tabungan", nativeBalance: 0n }),
      ],
      expenseRows: [monthExpense("2026-06", 6_000_000n)],
    })
    const insight = byId(result, EMERGENCY_FUND_INSIGHT_ID)
    expect(insight).toBeDefined()
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe("0")
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "6000000"
    )
    expect(insight?.tone).toBe("attention")
  })

  test("turns positive when the fund already covers the target", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({
          id: "acc-1",
          name: "Tabungan",
          nativeBalance: 20_000_000n,
        }),
      ],
      expenseRows: [monthExpense("2026-06", 2_000_000n)],
    })
    const insight = byId(result, EMERGENCY_FUND_INSIGHT_ID)
    expect(insight?.tone).toBe("positive")
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "gap")).toBe(
      "-18000000"
    )
  })

  test("skips when every designated balance is pending an exchange rate", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({
          id: "acc-1",
          name: "USD Savings",
          currency: "USD",
          nativeBalance: 5_000n,
        }),
      ],
      fxRateRows: [],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(byId(result, EMERGENCY_FUND_INSIGHT_ID)).toBeUndefined()
    expect(result.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "every designated savings balance is pending an exchange rate",
    })
  })

  test("skips when the only designated savings account is ARCHIVED", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        // The balance survives the soft close — but the household stopped
        // actively managing this money, so it is not the live fund.
        savingsAccount({
          id: "acc-1",
          name: "Archived savings",
          status: "closed",
          archivedAt: new Date("2026-06-02T00:00:00.000Z"),
          nativeBalance: 9_000_000n,
        }),
      ],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    expect(byId(result, EMERGENCY_FUND_INSIGHT_ID)).toBeUndefined()
    expect(result.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "no account is designated as savings",
    })
  })

  test("skips when every burn row in the used months is pending an exchange rate — never a fabricated zero target", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      fxRateRows: [],
      expenseRows: [
        // Every burn row is USD with no rate: spent folds to exactly zero
        // ONLY because the rates are missing. A Rp 0 target with a `positive`
        // tone would be the confident zero the honesty rules forbid.
        expenseRow({
          date: "2026-05-10T03:00:00.000Z",
          amountMinor: 1_000n,
          baseAmountMinor: null,
        }),
        expenseRow({
          date: "2026-06-12T03:00:00.000Z",
          amountMinor: 2_000n,
          baseAmountMinor: null,
        }),
      ],
    })
    expect(byId(result, EMERGENCY_FUND_INSIGHT_ID)).toBeUndefined()
    expect(result.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "every burn row in the window is pending an exchange rate",
    })
  })

  // The OTHER side of that guard — this test pins the guard's BOUNDARY, so it
  // must survive next to the skip test above. The guard is
  // `spent === 0n && fxPendingCount > 0`: it skips only when the zero is an
  // ARTIFACT of missing rates. A family whose covered months genuinely record
  // no spending at all (coverage established by the history span alone; think
  // a household funded by income rows with every expense still unrecorded)
  // still gets the card — saved intact, honest Rp 0 target. If anyone narrows
  // the guard to a bare `totals.spent === 0n`, THIS test fails: that
  // narrowing would silently delete the card for exactly the zero-spend
  // households it must speak for.
  test("RENDERS with target Rp 0 when the covered months record no spending at all — pins the burn guard's fxPendingCount boundary, not a bare spent===0", () => {
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [
        savingsAccount({
          id: "acc-1",
          name: "Tabungan",
          nativeBalance: 7_000_000n,
        }),
      ],
      // No expense rows exist: nothing was excluded to reach the zero burn,
      // so Rp 0 is a fact about the ledger, not a missing-rate artifact.
      expenseRows: [],
    })
    const insight = byId(result, EMERGENCY_FUND_INSIGHT_ID)
    expect(insight).toBeDefined()
    // Headline saved survives untouched…
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "7000000"
    )
    // …and the target answers "how much more" with Rp 0 instead of silence.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe("0")
    expect(result.skipped.map((entry) => entry.id)).not.toContain(
      EMERGENCY_FUND_INSIGHT_ID
    )
  })

  test("cuts a burn row at the UTC/WIB boundary into its FAMILY-tz month", () => {
    // 2026-06-30T20:00:00Z is already 2026-07-01 03:00 in Asia/Jakarta. Cut
    // in the family zone the row is JULY — still accumulating, excluded from
    // the burn. A UTC slice would misfile it into June (6M+9M=15M burn) and
    // produce a different target, so this assertion fails on that refactor.
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [
        monthExpense("2026-05", 3_000_000n),
        monthExpense("2026-06", 6_000_000n),
        expenseRow({
          date: "2026-06-30T20:00:00.000Z",
          amountMinor: 9_000_000n,
        }),
      ],
    })
    // burn = 3M + 6M over 6 months → 54M/6 = 9M. (UTC misfiling → 15M burn
    // → 15M target.)
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "9000000"
    )
  })

  test("excludes AND counts FX-pending balances and burn rows from both sides", () => {
    const result = buildReport({
      month: JULY,
      // First row 2026-05-01: May and June are the covered months (April
      // never entered the ledger) — April's absence is dilution's job to
      // avoid, so monthsUsed = 2.
      historyRange: { start: "2026-05-01", end: "2026-07-05" },
      accountRows: [
        savingsAccount({
          id: "acc-1",
          name: "Tabungan",
          nativeBalance: 5_000_000n,
        }),
        // USD savings with NO USD→IDR rate: excluded, counted.
        savingsAccount({
          id: "acc-2",
          name: "USD Savings",
          currency: "USD",
          nativeBalance: 5_000n,
        }),
      ],
      fxRateRows: [],
      expenseRows: [
        monthExpense("2026-05", 1_000_000n),
        monthExpense("2026-06", 2_000_000n),
        // A USD burn row with no rate: excluded, counted.
        expenseRow({
          date: "2026-06-12T03:00:00.000Z",
          amountMinor: 1_000n,
          baseAmountMinor: null,
        }),
      ],
    })
    const insight = byId(result, EMERGENCY_FUND_INSIGHT_ID)
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    // spent = 3M over 2 months → 18M/2 = 9M.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "9000000"
    )
    // 1 saved-side pending account + 1 burn-side pending row.
    expect(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "fx_pending_count")
    ).toBe("2")
    expect(insight?.partial).toBe(true)
  })

  test("converts foreign savings with the net-worth resolver — identical numbers, provably", () => {
    const fxRateRows: InsightFxRateRow[] = [
      {
        fromCurrency: "USD",
        toCurrency: "IDR",
        rateScaled: 16_000n * RATE_SCALE,
      },
    ]
    const accountRows = [
      savingsAccount({
        id: "acc-1",
        name: "Tabungan",
        nativeBalance: 1_000_000n,
      }),
      savingsAccount({
        id: "acc-2",
        name: "USD Savings",
        currency: "USD",
        nativeBalance: 5_000n,
      }),
    ]
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows,
      fxRateRows,
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    // 5_000 USD-cents @ 16_000 IDR/USD = 80_000_000 IDR-sen, + 1M base.
    expect(insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "81000000"
    )

    // The same balances through the net-worth engine's own fold must agree
    // exactly — one resolver, one conversion, one truth.
    const netWorth = normalizeNetWorthAt(
      accountRows.map((row) => ({
        accountClass: row.accountClass,
        currency: row.currency,
        native: row.nativeBalance,
      })),
      buildLatestRateResolver(fxRateRows, "IDR"),
      "IDR"
    )
    expect(netWorth.netWorth.toString()).toBe(
      insightMetric(result, EMERGENCY_FUND_INSIGHT_ID, "saved")
    )
  })

  test("intersects the burn window against anchor gaps, not the report month", () => {
    const accountRows = [savingsAccount({ id: "acc-1", name: "Tabungan" })]
    const expenses = [monthExpense("2026-06", 1_000_000n)]

    // A gap inside the burn window (Feb) marks THIS card partially recorded.
    const burnGap = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows,
      expenseRows: expenses,
      anchorGaps: [
        {
          accountId: "acc-gap",
          accountName: "Gap account",
          currency: "IDR",
          fromDate: "2026-02-01",
          toDate: "2026-02-28",
          amount: 500_000n,
          fromSource: "manual",
          toSource: "pit_stop",
        },
      ],
    })
    expect(byId(burnGap, EMERGENCY_FUND_INSIGHT_ID)?.periodPartial).toBe(true)

    // A gap in the July month only: outside the burn window (Jan–Jun), so the
    // burn figures are fully recorded even though July is not.
    const julyGap = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows,
      expenseRows: expenses,
      anchorGaps: [
        {
          accountId: "acc-gap",
          accountName: "Gap account",
          currency: "IDR",
          fromDate: "2026-07-12",
          toDate: "2026-07-20",
          amount: 500_000n,
          fromSource: "manual",
          toSource: "pit_stop",
        },
      ],
    })
    expect(byId(julyGap, EMERGENCY_FUND_INSIGHT_ID)?.periodPartial).toBe(false)
  })

  test("is registered under engine version 6", () => {
    expect(INSIGHTS_ENGINE_VERSION).toBe(6)
    const result = buildReport({
      month: JULY,
      historyRange: FULL_HISTORY,
      accountRows: [savingsAccount({ id: "acc-1", name: "Tabungan" })],
      expenseRows: [monthExpense("2026-06", 1_000_000n)],
    })
    // The other derivations skipped here (no qualifying rows), so this
    // pins that `emergency_fund` IS in the registry and reaches the report —
    // not the registry's array order. (`recurring_bills` also skips: it only
    // applies to the family's current month, and JUNE < JULY here;
    // `spending_trend` skips too: JULY has not started at the June clock.)
    expect(result.insights.map((insight) => insight.id)).toEqual([
      EMERGENCY_FUND_INSIGHT_ID,
    ])
    expect(byId(result, EMERGENCY_FUND_INSIGHT_ID)?.engineVersion).toBe(6)
  })
})

describe("computeInsights — recurring_bills (PER-227 slice #4)", () => {
  /** Mid-June in Asia/Jakarta (10:00 WIB): today is 2026-06-15, so the
   * forward window runs 2026-06-15 → 2026-07-15 inclusive. */
  const HISTORY: { start: string; end: string } = {
    start: "2026-01-01",
    end: "2026-06-15",
  }

  /** One expense row shaped like a bill occurrence: native magnitude
   * positive, frozen base projection negative, labelled by merchant (else
   * description) exactly as the seam's flow rows carry it. */
  function billRow(opts: {
    date: string
    amountMinor?: bigint
    label: string
    useMerchant?: boolean
    baseAmountMinor?: bigint | null
  }): InsightFlowRow {
    const amount = opts.amountMinor ?? 220_000n
    return flowRow({
      date: new Date(opts.date),
      amount,
      baseAmount:
        opts.baseAmountMinor === undefined ? -amount : opts.baseAmountMinor,
      merchantName: opts.useMerchant ? opts.label : null,
      description: opts.label,
    })
  }

  /** A cadence series of occurrences (all at 03:00Z = 10:00 WIB). */
  function billSeries(opts: {
    dates: ReadonlyArray<string>
    label: string
    amountMinor?: bigint
    useMerchant?: boolean
  }): InsightFlowRow[] {
    return opts.dates.map((date) =>
      billRow({
        date,
        label: opts.label,
        amountMinor: opts.amountMinor,
        useMerchant: opts.useMerchant,
      })
    )
  }

  function billsReport(options: ReportOptions = {}): InsightReport {
    return buildReport({
      month: JUNE,
      now: DEFAULT_NOW,
      historyRange: HISTORY,
      ...options,
    })
  }

  function metricOf(
    result: InsightReport,
    key: string
  ): { value: string; label?: string; currency?: string } | undefined {
    return byId(result, RECURRING_BILLS_INSIGHT_ID)?.metrics.find(
      (metric) => metric.key === key
    )
  }

  test("predicts a due-today monthly bill and labels the estimate honestly", () => {
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-03-17T03:00:00.000Z",
          "2026-04-16T03:00:00.000Z",
          "2026-05-16T03:00:00.000Z",
        ],
        label: "Netflix",
        useMerchant: true,
      }),
    })

    expect(result.failedCount).toBe(0)
    // savings_flow/since_payday/emergency_fund all skip; `spending_trend`
    // renders beside the bills card (May's only row sits after day 15, so
    // its baseline is a genuine zero — see the slice-#5 zero-baseline rule).
    expect(result.insights.map((insight) => insight.id)).toEqual([
      RECURRING_BILLS_INSIGHT_ID,
      SPENDING_TREND_INSIGHT_ID,
    ])
    const insight = byId(result, RECURRING_BILLS_INSIGHT_ID)
    expect(insight?.tone).toBe("neutral")
    expect(insight?.title).toBe("Bills due soon")
    expect(insight?.summary).toBe(
      "Predicted recurring outflows over the next 30 days — an estimate from recorded payments, not money already spent."
    )
    expect(insight?.detail).toBe(
      "Based on 3 past payments across 5 months of recorded history."
    )
    expect(insight?.window).toEqual({
      kind: "next_30_days",
      start: "2026-06-15",
      end: "2026-07-15",
      timezone: "Asia/Jakarta",
    })
    expect(insight?.engineVersion).toBe(INSIGHTS_ENGINE_VERSION)
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
    expect(insight?.partial).toBe(false)
    expect(insight?.fxPendingCount).toBe(0)

    expect(metricOf(result, "predicted_total")).toEqual({
      key: "predicted_total",
      label: "Predicted from 3 past payments",
      value: "220000",
      currency: "IDR",
    })
    expect(metricOf(result, "series_count")?.value).toBe("1")
    expect(metricOf(result, "series_count")?.label).toBe("Bills due")
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (Netflix, due today)"
    )
    expect(metricOf(result, "nearest_bill")?.value).toBe("220000")
    expect(metricOf(result, "cadence_mix")?.value).toBe("1 monthly")
    expect(metricOf(result, "due_bills")?.value).toBe("Netflix")
    expect(metricOf(result, "history_months")?.value).toBe("5")
    expect(metricOf(result, "history_months")?.label).toBe("Months of history")
    expect(metricOf(result, "fx_pending_count")?.value).toBe("0")
  })

  test("counts a bill projected exactly to today+30 (inclusive endpoint)", () => {
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-04-16T03:00:00.000Z",
          "2026-05-16T03:00:00.000Z",
          "2026-06-15T03:00:00.000Z",
        ],
        label: "Netflix",
      }),
    })
    expect(metricOf(result, "series_count")?.value).toBe("1")
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (Netflix, due in 30 days)"
    )
  })

  test("counts a bill projected to tomorrow", () => {
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-03-18T03:00:00.000Z",
          "2026-04-17T03:00:00.000Z",
          "2026-05-17T03:00:00.000Z",
        ],
        label: "Netflix",
      }),
    })
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (Netflix, due tomorrow)"
    )
  })

  test("excludes a bill projected past today+30, but still renders the honest empty card", () => {
    // 31-day gaps push the projection to 2026-07-16 — one day past the
    // window. Adequate history + nothing due must RENDER (a fact about the
    // schedule), never skip. A series WAS detected, so the copy must say
    // nothing is DUE — never "not detected" (false negative).
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-04-14T03:00:00.000Z",
          "2026-05-15T03:00:00.000Z",
          "2026-06-15T03:00:00.000Z",
        ],
        label: "Netflix",
      }),
    })

    const insight = byId(result, RECURRING_BILLS_INSIGHT_ID)
    expect(insight).toBeDefined()
    expect(insight?.tone).toBe("neutral")
    expect(insight?.summary).toBe(
      "No recurring bills are due in the next 30 days."
    )
    expect(insight?.detail).toBe(
      "Nothing is predicted to be due within the next 30 days."
    )
    expect(metricOf(result, "predicted_total")).toEqual({
      key: "predicted_total",
      label: "Predicted for the next 30 days",
      value: "0",
      currency: "IDR",
    })
    expect(metricOf(result, "series_count")?.value).toBe("0")
    expect(metricOf(result, "nearest_bill")).toBeUndefined()
    expect(metricOf(result, "cadence_mix")).toBeUndefined()
    expect(metricOf(result, "due_bills")).toBeUndefined()
    expect(metricOf(result, "history_months")?.value).toBe("5")
  })

  test("still counts an OVERDUE bill — no lower bound on due-soon", () => {
    // Projection 2026-06-09: six days overdue as of today, still a bill
    // that must be paid. The detector's staleness guard (two monthly bands
    // = 70 days) bounds how far past due a series can linger.
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-03-11T03:00:00.000Z",
          "2026-04-10T03:00:00.000Z",
          "2026-05-10T03:00:00.000Z",
        ],
        label: "Netflix",
      }),
    })
    expect(metricOf(result, "series_count")?.value).toBe("1")
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (Netflix, 6 days overdue)"
    )
  })

  test("cuts membership in the FAMILY timezone, not UTC", () => {
    // Occurrences at 17:00Z with 31-day gaps project to 2026-07-15T17:00Z:
    // already 2026-07-16 in Jakarta (excluded), still 2026-07-15 in UTC
    // (included). One series, one instant — only the family zone decides.
    const series = billSeries({
      dates: [
        "2026-04-13T17:00:00.000Z",
        "2026-05-14T17:00:00.000Z",
        "2026-06-14T17:00:00.000Z",
      ],
      label: "Netflix",
    })
    const inFamilyZone = billsReport({ expenseRows: series })
    expect(metricOf(inFamilyZone, "series_count")?.value).toBe("0")

    const inUtc = billsReport({ expenseRows: series, timezone: "UTC" })
    expect(metricOf(inUtc, "series_count")?.value).toBe("1")
  })

  test("drops future-dated rows: a schedule is not an occurrence", () => {
    // With the 2026-07-10 row treated as an occurrence, the projection would
    // shift to ~2026-08-07 and the bill would VANISH from the card even
    // though its previous occurrence (today) is due. The row must be
    // dropped, leaving the three real occurrences → next 07-15.
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-04-16T03:00:00.000Z",
          "2026-05-16T03:00:00.000Z",
          "2026-06-15T03:00:00.000Z",
          "2026-07-10T03:00:00.000Z",
        ],
        label: "Netflix",
      }),
    })
    expect(metricOf(result, "series_count")?.value).toBe("1")
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (Netflix, due in 30 days)"
    )
  })

  test("never bills a salary: income rows never reach the detector (non-vacuity)", () => {
    // A monthly income series projecting INSIDE the window (06-10 + 31d =
    // 07-11). If the direction filter broke, the card would predict
    // 20,000,000 of "bills". The payday derivation detects the SAME rows,
    // proving they were present and detectable — only the filter keeps them
    // off the bills card.
    const salary = salarySeries({
      months: ["2026-04", "2026-05", "2026-06"],
      day: 10,
      amountMinor: 20_000_000n,
    })
    const result = billsReport({ incomeRows: salary })

    const insight = byId(result, RECURRING_BILLS_INSIGHT_ID)
    expect(insight).toBeDefined()
    expect(metricOf(result, "series_count")?.value).toBe("0")
    expect(metricOf(result, "predicted_total")?.value).toBe("0")
    expect(byId(result, SINCE_PAYDAY_INSIGHT_ID)).toBeDefined()
  })

  test("sorts due-bill labels with localeCompare and caps the list with +n", () => {
    // Four monthly bills, all projecting to the same instant. Byte order
    // would print "DanaB, Zakat, apple bill, dana darurat"; locale order is
    // "apple bill, dana darurat, DanaB, zakat" (Sonar S2871). The nearest
    // tie-break must pick the locale-first label although input order put
    // "zakat" first.
    const sameDates = [
      "2026-04-05T03:00:00.000Z",
      "2026-05-05T03:00:00.000Z",
      "2026-06-05T03:00:00.000Z",
    ]
    const result = billsReport({
      expenseRows: [
        ...billSeries({ dates: sameDates, label: "zakat" }),
        ...billSeries({ dates: sameDates, label: "DanaB" }),
        ...billSeries({ dates: sameDates, label: "dana darurat" }),
        ...billSeries({ dates: sameDates, label: "apple bill" }),
      ],
    })
    expect(metricOf(result, "due_bills")?.label).toBe("Due bills")
    expect(metricOf(result, "due_bills")?.value).toBe(
      "apple bill, dana darurat, DanaB +1"
    )
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (apple bill, due in 21 days)"
    )
    expect(metricOf(result, "cadence_mix")?.value).toBe("4 monthly")
  })

  test("prints the cadence mix on a fixed ladder, never a string sort", () => {
    // An alphabetical print would read "biweekly, monthly, weekly" and bury
    // the dominant cadence; the ladder leads with monthly.
    const result = billsReport({
      expenseRows: [
        ...billSeries({
          dates: [
            "2026-03-17T03:00:00.000Z",
            "2026-04-16T03:00:00.000Z",
            "2026-05-16T03:00:00.000Z",
          ],
          label: "Netflix",
        }),
        ...billSeries({
          dates: [
            "2026-03-20T03:00:00.000Z",
            "2026-04-19T03:00:00.000Z",
            "2026-05-19T03:00:00.000Z",
          ],
          label: "Spotify",
        }),
        ...billSeries({
          dates: [
            "2026-05-18T03:00:00.000Z",
            "2026-06-01T03:00:00.000Z",
            "2026-06-15T03:00:00.000Z",
          ],
          label: "Electricity",
        }),
        ...billSeries({
          dates: [
            "2026-06-01T03:00:00.000Z",
            "2026-06-08T03:00:00.000Z",
            "2026-06-15T03:00:00.000Z",
          ],
          label: "Gym",
        }),
      ],
    })
    expect(metricOf(result, "series_count")?.value).toBe("4")
    expect(metricOf(result, "cadence_mix")?.value).toBe(
      "2 monthly, 1 biweekly, 1 weekly"
    )
    expect(metricOf(result, "nearest_bill")?.label).toBe(
      "Nearest (Netflix, due today)"
    )
  })

  test("skips with the history reason when fewer than three months are covered", () => {
    // History starts mid-April: only May is complete among Mar–May. A due
    // bill exists, but "predicted from recorded payments" would rest on too
    // little — the skip reason is distinct from "nothing is due".
    const dueToday = billSeries({
      dates: [
        "2026-03-17T03:00:00.000Z",
        "2026-04-16T03:00:00.000Z",
        "2026-05-16T03:00:00.000Z",
      ],
      label: "Netflix",
    })
    const thin = billsReport({
      expenseRows: dueToday,
      historyRange: { start: "2026-04-15", end: "2026-06-15" },
    })
    expect(thin.insights.map((insight) => insight.id)).not.toContain(
      RECURRING_BILLS_INSIGHT_ID
    )
    expect(thin.skipped).toContainEqual({
      id: RECURRING_BILLS_INSIGHT_ID,
      reason: "fewer than three complete months of recorded history",
    })

    // A family with NO recorded history at all skips the same way.
    const none = billsReport({ expenseRows: dueToday, historyRange: null })
    expect(none.skipped).toContainEqual({
      id: RECURRING_BILLS_INSIGHT_ID,
      reason: "fewer than three complete months of recorded history",
    })
  })

  test("skips a historical month: the window is now-relative by nature", () => {
    // Same rows and full history, but a MAY request: the detector's
    // staleness guard would drop every series, rendering a lying empty card
    // — so the derivation refuses instead (the same rule as since_payday).
    const dueToday = billSeries({
      dates: [
        "2026-03-17T03:00:00.000Z",
        "2026-04-16T03:00:00.000Z",
        "2026-05-16T03:00:00.000Z",
      ],
      label: "Netflix",
    })
    const may = billsReport({ expenseRows: dueToday, month: "2026-05" })
    expect(may.skipped).toContainEqual({
      id: RECURRING_BILLS_INSIGHT_ID,
      reason: "recurring bills only apply to the family's current month",
    })
    // The discriminating pair: the same rows in the CURRENT month render.
    const june = billsReport({ expenseRows: dueToday })
    expect(metricOf(june, "series_count")?.value).toBe("1")
  })

  test("excludes FX-pending expense rows from detection and counts them", () => {
    // A complete "Adobe" cadence with NO frozen base projection cannot be
    // summed into a base-currency prediction: excluded AND counted, never
    // silently folded in as zero — and never clustered by the detector.
    const pending = billSeries({
      dates: [
        "2026-04-16T03:00:00.000Z",
        "2026-05-16T03:00:00.000Z",
        "2026-06-15T03:00:00.000Z",
      ],
      label: "Adobe",
    }).map((row) => ({ ...row, baseAmount: null }))
    const solid = billSeries({
      dates: [
        "2026-03-17T03:00:00.000Z",
        "2026-04-16T03:00:00.000Z",
        "2026-05-16T03:00:00.000Z",
      ],
      label: "Netflix",
    })

    const result = billsReport({ expenseRows: [...pending, ...solid] })
    expect(metricOf(result, "predicted_total")?.value).toBe("220000")
    expect(metricOf(result, "due_bills")?.value).toBe("Netflix")
    expect(metricOf(result, "fx_pending_count")?.value).toBe("3")
    expect(byId(result, RECURRING_BILLS_INSIGHT_ID)?.partial).toBe(true)
  })

  test("does NOT count a future-dated FX-pending row: a schedule is neither an occurrence nor a pending occurrence", () => {
    // The pending count must be scoped to the SAME rows detection uses. A
    // future row is dropped before the pending check, so a future row that
    // ALSO lacks a frozen base projection stays uncounted — otherwise the
    // count would claim excluded detection input that detection never saw.
    const past = billSeries({
      dates: [
        "2026-04-16T03:00:00.000Z",
        "2026-05-16T03:00:00.000Z",
        "2026-06-15T03:00:00.000Z",
      ],
      label: "Netflix",
    })
    const futurePending = billSeries({
      dates: ["2026-07-20T03:00:00.000Z"],
      label: "Adobe",
    }).map((row) => ({ ...row, baseAmount: null }))

    const result = billsReport({ expenseRows: [...past, ...futurePending] })
    expect(metricOf(result, "fx_pending_count")?.value).toBe("0")
    expect(byId(result, RECURRING_BILLS_INSIGHT_ID)?.partial).toBe(false)
  })

  test("always reports an honest forward window: no periodPartial, no gaps", () => {
    // A live anchor-chain gap intersecting the forward window says nothing
    // about PREDICTED future obligations — PER-443's axis is past-tense, so
    // fabricating periodPartial here would be a lie in the other direction.
    const result = billsReport({
      expenseRows: billSeries({
        dates: [
          "2026-03-17T03:00:00.000Z",
          "2026-04-16T03:00:00.000Z",
          "2026-05-16T03:00:00.000Z",
        ],
        label: "Netflix",
      }),
      anchorGaps: [
        {
          accountId: "acc-gap",
          accountName: "Gap account",
          currency: "IDR",
          fromDate: "2026-06-20",
          toDate: "2026-07-05",
          amount: 500_000n,
          fromSource: "manual",
          toSource: "pit_stop",
        },
      ],
    })
    const insight = byId(result, RECURRING_BILLS_INSIGHT_ID)
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
  })

  test("renders the empty card when history is adequate and no series exists at all", () => {
    // Nothing DETECTED at all — the copy makes the true claim about
    // detection (distinct from "detected but nothing due", which says so).
    const result = billsReport({ expenseRows: [] })
    const insight = byId(result, RECURRING_BILLS_INSIGHT_ID)
    expect(insight).toBeDefined()
    expect(insight?.summary).toBe(
      "No recurring outflows detected in the last 5 complete months of recorded history."
    )
    expect(metricOf(result, "series_count")?.value).toBe("0")
  })
})

describe("computeInsights — spending_trend (PER-227 slice #5)", () => {
  /** Recorded history covering the comparison month end-to-end; the clock is
   * 2026-06-15 in Asia/Jakarta, so June (the requested month) is in progress
   * and N = 15 on both sides of the delta. */
  const HISTORY: { start: string; end: string } = {
    start: "2026-05-01",
    end: "2026-06-15",
  }

  function trendReport(options: ReportOptions = {}): InsightReport {
    return buildReport({
      month: JUNE,
      now: DEFAULT_NOW,
      historyRange: HISTORY,
      ...options,
    })
  }

  function metricOf(result: InsightReport, key: string): string | undefined {
    return byId(result, SPENDING_TREND_INSIGHT_ID)?.metrics.find(
      (metric) => metric.key === key
    )?.value
  }

  /** The shared prologue of every rendered-card pin: a clean report, the
   * trend card present — and the card handle handed back so each test spells
   * its own expected values below. */
  function expectTrendInsight(result: InsightReport) {
    expect(result.failedCount).toBe(0)
    const insight = byId(result, SPENDING_TREND_INSIGHT_ID)
    expect(insight).toBeDefined()
    return insight
  }

  /** The baseline-window envelope shape (the reserved `previous_month` kind
   * plus the family timezone); every caller writes its own start/end. */
  function expectTrendWindow(
    insight: ReturnType<typeof byId>,
    start: string,
    end: string
  ) {
    expect(insight?.window).toEqual({
      kind: "previous_month",
      start,
      end,
      timezone: "Asia/Jakarta",
    })
  }

  /** One labelled trend metric; the expected value is written by the caller,
   * in the caller's own order. */
  function expectTrendMetric(
    result: InsightReport,
    key: string,
    value: string
  ) {
    expect(metricOf(result, key)).toBe(value)
  }

  function trendGap(fromDate: string, toDate: string): InsightAnchorGapRow {
    return {
      accountId: "acc-gap",
      accountName: "Bank Jago",
      currency: "IDR",
      fromDate,
      toDate,
      amount: 1_000_000n,
      fromSource: "manual",
      toSource: "pit_stop",
    }
  }

  /** The non-vacuity pin for the like-for-like rule: previous-month rows
   * after day 15 must NOT reach the comparison. Removing the same-days
   * cutoff makes `spent_previous_period` fold 2,087,000 instead of 200,000
   * and fails every delta assertion below. */
  test("compares day N of the current month against day N of the previous month — later spend never leaks in", () => {
    const result = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-03T03:00:00.000Z", amountMinor: 100_000n }),
        expenseRow({ date: "2026-06-15T03:00:00.000Z", amountMinor: 50_000n }),
        expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 200_000n }),
        // Previous month AFTER day 15: inside the complete-month context
        // figure, outside the like-for-like comparison.
        expenseRow({ date: "2026-05-20T03:00:00.000Z", amountMinor: 999_000n }),
        expenseRow({ date: "2026-05-31T03:00:00.000Z", amountMinor: 888_000n }),
      ],
    })

    const insight = expectTrendInsight(result)
    expect(insight?.tone).toBe("neutral")
    // The envelope carries the BASELINE window (the reserved `previous_month`
    // kind, finally in use): days 1–15 of the previous month.
    expectTrendWindow(insight, "2026-05-01", "2026-05-15")
    expectTrendMetric(result, "spent_current_period", "150000")
    expectTrendMetric(result, "spent_previous_period", "200000")
    expectTrendMetric(result, "previous_month_total", "2087000")
    expectTrendMetric(result, "delta", "-50000")
    expectTrendMetric(result, "percent_change", "-25%")
    expectTrendMetric(result, "days_elapsed", "1–15 vs 1–15")
    // The current month is in progress — `partial` must say so.
    expect(insight?.partial).toBe(true)
    expect(insight?.summary).toBe(
      "Days 1–15 of this month versus days 1–15 of last month — the same days of each month, never a partial month against a complete one."
    )
    expect(insight?.detail).toBe(
      "Last month's complete total is shown for context — a whole month versus part of one is not a fair comparison."
    )
  })

  /** The clamp pin: on day 31 of a 31-day month the naive same-days math
   * (previousDays = currentDays) would overflow the baseline window across
   * the month boundary (Feb 1 + 30 days = Mar 3), folding early-March rows
   * into BOTH sides. `Math.min(currentDays, previous month length)` is what
   * stops that; this test fails without it. */
  test("clamps the baseline to the previous month's length on day 29–31 — never an overflowing comparison window", () => {
    const result = buildReport({
      month: "2026-03",
      // Jakarta 2026-03-31 10:00 — the family is on day 31 of a 31-day month
      // whose previous month (February) has only 28 days.
      now: new Date("2026-03-31T03:00:00.000Z"),
      historyRange: { start: "2026-02-01", end: "2026-03-31" },
      expenseRows: [
        // Baseline side: February, days 1–28.
        expenseRow({ date: "2026-02-10T03:00:00.000Z", amountMinor: 200_000n }),
        // Current side: March, days 1–31.
        expenseRow({ date: "2026-03-05T03:00:00.000Z", amountMinor: 100_000n }),
        // The double-count trap: an UNclamped baseline (Feb 1 + 30 days =
        // Mar 3) would fold this row into BOTH sides of the delta.
        expenseRow({ date: "2026-03-02T03:00:00.000Z", amountMinor: 50_000n }),
      ],
    })

    const insight = expectTrendInsight(result)
    // The baseline stops at February's actual last day, never March 3.
    expectTrendWindow(insight, "2026-02-01", "2026-02-28")
    // The asymmetric "1–31 vs 1–28" disclosure.
    expectTrendMetric(result, "days_elapsed", "1–31 vs 1–28")
    expectTrendMetric(result, "spent_current_period", "150000")
    // 250000 without the clamp (the Mar 2 row would leak into the baseline).
    expectTrendMetric(result, "spent_previous_period", "200000")
    expectTrendMetric(result, "previous_month_total", "200000")
    expectTrendMetric(result, "delta", "-50000")
    expectTrendMetric(result, "percent_change", "-25%")
    expect(insight?.partial).toBe(true)
    // The clamped copy must own the asymmetry — it may never claim "the
    // same days of each month" while printing 1–31 vs 1–28.
    expect(insight?.summary).toBe(
      "Days 1–31 of this month versus days 1–28 of last month — February 2026 has only 28 days, so the comparison stops at the shorter month's length."
    )
  })

  test("orders metrics with the like-for-like delta first and a label on every supporting line", () => {
    const result = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-03T03:00:00.000Z", amountMinor: 100_000n }),
        expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 200_000n }),
      ],
    })
    const insight = byId(result, SPENDING_TREND_INSIGHT_ID)
    expect(insight?.metrics.map((metric) => metric.key)).toEqual([
      "delta",
      "spent_current_period",
      "spent_previous_period",
      "previous_month_total",
      "days_elapsed",
      "percent_change",
      "fx_pending_count",
    ])
    // Headline contract: the FIRST money metric is the signed delta —
    // positive would mean "spent MORE than the same days last month".
    expect(insight?.metrics[0]).toEqual({
      key: "delta",
      label: "Difference versus the same days last month",
      value: "-100000",
      currency: "IDR",
    })
    for (const metric of insight?.metrics.slice(1) ?? []) {
      expect(metric.label).toBeDefined()
    }
    for (const metric of insight?.metrics ?? []) {
      if (
        [
          "delta",
          "spent_current_period",
          "spent_previous_period",
          "previous_month_total",
        ].includes(metric.key)
      ) {
        expect(metric.currency).toBe("IDR")
      }
    }
  })

  test("renders a delta against zero when the comparison period recorded no spending — never NaN, never a skip", () => {
    // History still COVERS May (its first recorded row is on or before
    // May 1 — e.g. an income row): zero spend in the window is a fact about
    // the ledger, not an absence of history.
    const result = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 150_000n }),
      ],
    })
    const insight = byId(result, SPENDING_TREND_INSIGHT_ID)
    expect(insight).toBeDefined()
    expect(metricOf(result, "spent_previous_period")).toBe("0")
    expect(metricOf(result, "previous_month_total")).toBe("0")
    expect(metricOf(result, "delta")).toBe("150000")
    expect(metricOf(result, "percent_change")).toBe("no comparison possible")
    expect(insight?.detail).toContain(
      "No spending was recorded in the comparison period last month, so the percentage change has no base."
    )
    expect(result.skipped).not.toContainEqual(
      expect.objectContaining({ id: SPENDING_TREND_INSIGHT_ID })
    )
  })

  test("a past requested month compares two COMPLETE months and reports partial false", () => {
    const result = buildReport({
      month: "2026-04",
      now: DEFAULT_NOW,
      historyRange: { start: "2026-03-01", end: "2026-04-30" },
      expenseRows: [
        expenseRow({ date: "2026-03-05T03:00:00.000Z", amountMinor: 250_000n }),
        expenseRow({ date: "2026-03-31T03:00:00.000Z", amountMinor: 50_000n }),
        expenseRow({ date: "2026-04-10T03:00:00.000Z", amountMinor: 300_000n }),
        expenseRow({ date: "2026-04-30T03:00:00.000Z", amountMinor: 100_000n }),
      ],
    })

    expect(result.insights.map((insight) => insight.id)).toEqual([
      SPENDING_TREND_INSIGHT_ID,
    ])
    const insight = result.insights[0]
    expect(insight.tone).toBe("neutral")
    // Both sides COMPLETE: the baseline window is the whole previous month.
    expect(insight.window).toEqual({
      kind: "previous_month",
      start: "2026-03-01",
      end: "2026-03-31",
      timezone: "Asia/Jakarta",
    })
    expect(insight.partial).toBe(false)
    expect(
      insightMetric(result, SPENDING_TREND_INSIGHT_ID, "spent_current_period")
    ).toBe("400000")
    expect(
      insightMetric(result, SPENDING_TREND_INSIGHT_ID, "spent_previous_period")
    ).toBe("300000")
    // The context metric is CURRENT-MONTH-ONLY: for a past request the
    // baseline IS the whole previous month, so `previous_month_total` would
    // duplicate `spent_previous_period` byte-identically under a second
    // label — suppressed, and pinned absent here.
    expect(
      insightMetric(result, SPENDING_TREND_INSIGHT_ID, "previous_month_total")
    ).toBeUndefined()
    expect(insight.metrics.map((metric) => metric.key)).toEqual([
      "delta",
      "spent_current_period",
      "spent_previous_period",
      "days_elapsed",
      "percent_change",
      "fx_pending_count",
    ])
    expect(insightMetric(result, SPENDING_TREND_INSIGHT_ID, "delta")).toBe(
      "100000"
    )
    expect(
      insightMetric(result, SPENDING_TREND_INSIGHT_ID, "percent_change")
    ).toBe("+33.3%")
    expect(
      insightMetric(result, SPENDING_TREND_INSIGHT_ID, "days_elapsed")
    ).toBe("1–30 vs 1–31")
    // The copy must NOT claim "partial" for a fully elapsed past month.
    expect(insight.summary).toBe(
      "April 2026 versus March 2026 — both months are complete, so the comparison is like for like."
    )
    expect(insight.detail).toBe(
      "Both months are fully elapsed, so the figures compare two complete months."
    )
  })

  test("splits BOTH months at the family-tz boundary — never a UTC slice", () => {
    // Each row sits on the Jakarta day AFTER the UTC day it was stamped on
    // (17:30Z = 00:30 WIB the next day), one per side of each cutoff. A
    // UTC-slicing refactor flips every one of them.
    const result = trendReport({
      historyRange: { start: "2026-04-30", end: "2026-06-16" },
      expenseRows: [
        // Jakarta 2026-06-01 00:30 → day 1 → INSIDE the current window.
        expenseRow({ date: "2026-05-31T17:30:00.000Z", amountMinor: 10_000n }),
        // Jakarta 2026-06-16 → day 16 → outside (a UTC slice says 06-15).
        expenseRow({ date: "2026-06-15T17:30:00.000Z", amountMinor: 900_000n }),
        // Jakarta 2026-05-01 00:30 → day 1 → INSIDE the baseline window.
        expenseRow({ date: "2026-04-30T17:30:00.000Z", amountMinor: 20_000n }),
        // Jakarta 2026-05-16 → day 16 → context figure only (UTC: 05-15).
        expenseRow({ date: "2026-05-15T17:30:00.000Z", amountMinor: 800_000n }),
      ],
    })

    expect(byId(result, SPENDING_TREND_INSIGHT_ID)?.window).toEqual({
      kind: "previous_month",
      start: "2026-05-01",
      end: "2026-05-15",
      timezone: "Asia/Jakarta",
    })
    expect(metricOf(result, "spent_current_period")).toBe("10000")
    expect(metricOf(result, "spent_previous_period")).toBe("20000")
    expect(metricOf(result, "previous_month_total")).toBe("820000")
    expect(metricOf(result, "delta")).toBe("-10000")
    expect(metricOf(result, "days_elapsed")).toBe("1–15 vs 1–15")
  })

  test("derives N from the FAMILY-tz clock — a UTC month-boundary instant never inverts the current period", () => {
    // 2026-06-30T20:00Z is already 2026-07-01 03:00 in Asia/Jakarta: the
    // family's July has started (day 1) while the UTC date still says June
    // 30. A `now.toISOString().slice(0,10)` clock would either refuse July
    // as "not started yet" or cut an inverted window (start 07-01 > end
    // 06-30), silently emptying the comparison.
    const result = buildReport({
      month: "2026-07",
      now: new Date("2026-06-30T20:00:00.000Z"),
      historyRange: { start: "2026-06-01", end: "2026-07-01" },
      expenseRows: [
        // Jakarta 2026-07-01 00:30 → day 1 → INSIDE the current window (a
        // UTC slice says 2026-06-30 and drops it).
        expenseRow({
          date: "2026-06-30T17:30:00.000Z",
          amountMinor: 120_000n,
        }),
      ],
    })

    const insight = expectTrendInsight(result)
    expectTrendWindow(insight, "2026-06-01", "2026-06-01")
    expectTrendMetric(result, "days_elapsed", "1–1 vs 1–1")
    expectTrendMetric(result, "spent_current_period", "120000")
    expectTrendMetric(result, "spent_previous_period", "0")
    expectTrendMetric(result, "percent_change", "no comparison possible")
    expect(result.skipped).not.toContainEqual(
      expect.objectContaining({ id: SPENDING_TREND_INSIGHT_ID })
    )
  })

  test("skips below two complete months of recorded history — a comparison against nothing is fabrication", () => {
    const juneRow = expenseRow({
      date: "2026-06-05T03:00:00.000Z",
      amountMinor: 150_000n,
    })
    const noHistory = trendReport({
      historyRange: null,
      expenseRows: [juneRow],
    })
    expect(noHistory.insights.map((insight) => insight.id)).not.toContain(
      SPENDING_TREND_INSIGHT_ID
    )
    expect(noHistory.skipped).toContainEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })

    // Family started recording mid-current-month: May never existed on the
    // ledger, so there is nothing to compare day 15 against.
    const freshFamily = trendReport({
      historyRange: { start: "2026-06-01", end: "2026-06-15" },
      expenseRows: [juneRow],
    })
    expect(freshFamily.skipped).toContainEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })
  })

  test("skips a long-tenured family whose ledger stopped mid-requested-month with the truthful reason — never a false count claim", () => {
    // History spans SEVEN complete months — "fewer than two" would be a
    // lie. What is actually missing is the requested month itself (the last
    // recorded row is 2026-04-15), and that is what the skip must say.
    const result = buildReport({
      month: "2026-04",
      now: DEFAULT_NOW,
      historyRange: { start: "2025-09-01", end: "2026-04-15" },
      expenseRows: [
        expenseRow({ date: "2026-03-05T03:00:00.000Z", amountMinor: 90_000n }),
      ],
    })
    expect(result.insights.map((insight) => insight.id)).not.toContain(
      SPENDING_TREND_INSIGHT_ID
    )
    expect(
      result.skipped.find((entry) => entry.id === SPENDING_TREND_INSIGHT_ID)
    ).toEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "the requested month was not recorded end-to-end",
    })
  })

  test("skips a requested month that has not started yet", () => {
    const result = trendReport({ month: "2026-07" })
    expect(result.insights.map((insight) => insight.id)).not.toContain(
      SPENDING_TREND_INSIGHT_ID
    )
    expect(result.skipped).toContainEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "the requested month has not started yet",
    })
  })

  test("skips when the baseline's only rows are FX-pending — never a fabricated zero to compare against", () => {
    const result = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 150_000n }),
        expenseRow({
          date: "2026-05-05T03:00:00.000Z",
          amountMinor: 400_000n,
          baseAmountMinor: null,
        }),
      ],
    })
    expect(result.insights.map((insight) => insight.id)).not.toContain(
      SPENDING_TREND_INSIGHT_ID
    )
    expect(result.skipped).toContainEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason:
        "every spending row in the comparison period is pending an exchange rate",
    })
  })

  test("excludes FX-pending rows from BOTH sides and counts them (non-vacuity)", () => {
    const result = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 100_000n }),
        expenseRow({
          date: "2026-06-07T03:00:00.000Z",
          amountMinor: 500_000n,
          baseAmountMinor: null,
        }),
        expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 300_000n }),
        expenseRow({
          date: "2026-05-06T03:00:00.000Z",
          amountMinor: 900_000n,
          baseAmountMinor: null,
        }),
      ],
    })
    const insight = byId(result, SPENDING_TREND_INSIGHT_ID)
    expect(insight?.fxPendingCount).toBe(2)
    expect(insight?.partial).toBe(true)
    // FOLDING the pending rows in (the vacuous version) would yield 600000 /
    // 1200000 and a POSITIVE delta — exclusion is the pinned behavior.
    expect(metricOf(result, "spent_current_period")).toBe("100000")
    expect(metricOf(result, "spent_previous_period")).toBe("300000")
    expect(metricOf(result, "previous_month_total")).toBe("300000")
    expect(metricOf(result, "delta")).toBe("-200000")
    expect(metricOf(result, "fx_pending_count")).toBe("2")
  })

  test("folds split children through the parent's stored rate, never the parent projection", () => {
    const result = trendReport({
      expenseRows: [
        flowRow({
          date: new Date("2026-06-05T03:00:00.000Z"),
          amount: 5_000_000n,
          // Intentionally NOT the children's sum: the fold must consume the
          // children (the budget/cash-flow rule).
          baseAmount: -999_999n,
          isSplit: true,
          splitEntries: [{ amount: 60_000n }, { amount: 40_000n }],
        }),
        expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 30_000n }),
      ],
    })
    expect(metricOf(result, "spent_current_period")).toBe("100000")
    expect(metricOf(result, "delta")).toBe("70000")
  })

  test("reports the delta neutrally — more spent and less spent are both just facts", () => {
    const more = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 300_000n }),
        expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 100_000n }),
      ],
    })
    const moreInsight = byId(more, SPENDING_TREND_INSIGHT_ID)
    expect(moreInsight?.tone).toBe("neutral")
    expect(metricOf(more, "delta")).toBe("200000")
    expect(metricOf(more, "percent_change")).toBe("+200%")

    const less = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 50_000n }),
        expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 100_000n }),
      ],
    })
    const lessInsight = byId(less, SPENDING_TREND_INSIGHT_ID)
    expect(lessInsight?.tone).toBe("neutral")
    expect(metricOf(less, "delta")).toBe("-50000")
    expect(metricOf(less, "percent_change")).toBe("-50%")
    // No verdict on either side — a lower number can be a cancelled medicine.
    expect(lessInsight?.summary).toContain(
      "never a partial month against a complete one"
    )
  })

  test("marks the card partially recorded when a gap intersects EITHER compared window, deduped", () => {
    const rows = [
      expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 100_000n }),
      expenseRow({ date: "2026-05-05T03:00:00.000Z", amountMinor: 100_000n }),
    ]

    // Inside the current compared window: the current side is understated.
    const currentGap = trendReport({
      expenseRows: rows,
      anchorGaps: [trendGap("2026-06-03", "2026-06-10")],
    })
    expect(byId(currentGap, SPENDING_TREND_INSIGHT_ID)?.periodPartial).toBe(
      true
    )
    expect(
      byId(currentGap, SPENDING_TREND_INSIGHT_ID)?.periodGaps
    ).toHaveLength(1)

    // Inside the BASELINE window ALONE (days 1–15 of the previous month):
    // the previous side is understated even though no gap touches the
    // current window — deleting the previous-side probe (`sides[1]`) used
    // to pass every test; this case is what pins it.
    const previousOnlyGap = trendReport({
      expenseRows: rows,
      anchorGaps: [trendGap("2026-05-03", "2026-05-10")],
    })
    expect(
      byId(previousOnlyGap, SPENDING_TREND_INSIGHT_ID)?.periodPartial
    ).toBe(true)
    expect(
      byId(previousOnlyGap, SPENDING_TREND_INSIGHT_ID)?.periodGaps
    ).toEqual([
      expect.objectContaining({
        accountId: "acc-gap",
        fromDate: "2026-05-03",
        toDate: "2026-05-10",
      }),
    ])

    // Only AFTER the previous cutoff: it touches the context figure alone,
    // never the comparison — the badge must not claim the delta is affected.
    const afterCutoff = trendReport({
      expenseRows: rows,
      anchorGaps: [trendGap("2026-05-16", "2026-05-25")],
    })
    expect(byId(afterCutoff, SPENDING_TREND_INSIGHT_ID)?.periodPartial).toBe(
      false
    )
    expect(byId(afterCutoff, SPENDING_TREND_INSIGHT_ID)?.periodGaps).toEqual([])

    // One gap spanning BOTH compared windows is disclosed exactly once.
    const spanning = trendReport({
      expenseRows: rows,
      anchorGaps: [trendGap("2026-05-10", "2026-06-10")],
    })
    expect(byId(spanning, SPENDING_TREND_INSIGHT_ID)?.periodPartial).toBe(true)
    expect(byId(spanning, SPENDING_TREND_INSIGHT_ID)?.periodGaps).toHaveLength(
      1
    )
  })

  test("is registered under engine version 6", () => {
    expect(INSIGHTS_ENGINE_VERSION).toBe(6)
    const result = trendReport({
      expenseRows: [
        expenseRow({ date: "2026-06-05T03:00:00.000Z", amountMinor: 100_000n }),
      ],
    })
    // The other four derivations skip in this fixture, so reaching the
    // report pins that `spending_trend` IS in the registry.
    expect(result.insights.map((insight) => insight.id)).toEqual([
      SPENDING_TREND_INSIGHT_ID,
    ])
    expect(byId(result, SPENDING_TREND_INSIGHT_ID)?.engineVersion).toBe(6)
  })
})
