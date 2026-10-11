import { describe, expect, test } from "vite-plus/test"
import {
  calendarMonthBounds,
  computeInsights,
  currentMonthInZone,
  INSIGHTS_ENGINE_VERSION,
  resolvePaydayAnchor,
  SAVINGS_FLOW_INSIGHT_ID,
  SINCE_PAYDAY_INSIGHT_ID,
  type InsightContextInput,
  type InsightFlowRow,
  type InsightReport,
  type InsightTransferRow,
} from "./insights"

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
      {
        id: SINCE_PAYDAY_INSIGHT_ID,
        reason: "no monthly recurring income series detected",
      },
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
      {
        id: SINCE_PAYDAY_INSIGHT_ID,
        reason: "no monthly recurring income series detected",
      },
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
