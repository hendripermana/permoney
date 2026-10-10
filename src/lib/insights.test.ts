import { describe, expect, test } from "vite-plus/test"
import {
  calendarMonthBounds,
  computeInsights,
  currentMonthInZone,
  INSIGHTS_ENGINE_VERSION,
  SAVINGS_FLOW_INSIGHT_ID,
  type InsightContextInput,
  type InsightTransferRow,
} from "./insights"

const JUNE = "2026-06"

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

function report(
  rows: ReadonlyArray<InsightTransferRow>,
  month = JUNE,
  timezone = "Asia/Jakarta"
) {
  return computeInsights({
    timezone,
    month,
    baseCurrency: "IDR",
    transferRows: rows,
  })
}

function metricValue(
  rows: ReadonlyArray<InsightTransferRow>,
  key: string,
  month = JUNE
) {
  const insight = report(rows, month).insights[0]
  return insight?.metrics.find((metric) => metric.key === key)?.value
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
        transferRows: classicTransfer({ transferId: "tr-1", savedBase: 1n }),
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
        transferRows: classicTransfer({ transferId: "tr-1", savedBase: 10n }),
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
