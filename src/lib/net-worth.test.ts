import { describe, expect, test } from "vite-plus/test"
import { convertMinor, encodeRate } from "./fx"
import {
  buildNetWorthSeries,
  generateSampleDates,
  MAX_SERIES_POINTS,
  normalizeNetWorthAt,
  type NetWorthPoint,
  type NetWorthSeriesInput,
  type PointBalance,
} from "./net-worth"

const USD_IDR = encodeRate("16000") // 1 USD = 16,000 IDR

function pointByDate(points: NetWorthPoint[], date: string): NetWorthPoint {
  const point = points.find((p) => p.date === date)
  if (!point)
    throw new Error(
      `no point for ${date} in ${points.map((p) => p.date).join(",")}`
    )
  return point
}

const baseInput = (
  overrides: Partial<NetWorthSeriesInput>
): NetWorthSeriesInput => ({
  baseCurrency: "IDR",
  timezone: "UTC",
  from: "2026-01-01",
  to: "2026-01-01",
  interval: "day",
  accounts: [],
  valuations: [],
  transactions: [],
  snapshots: [],
  ...overrides,
})

// =============================================================================
// normalizeNetWorthAt — the shared point normalizer
// =============================================================================

describe("normalizeNetWorthAt", () => {
  const noRate = () => null

  test("decomposes assets and liabilities in the base currency", () => {
    const balances: PointBalance[] = [
      { accountClass: "ASSET", currency: "IDR", native: 1_000_000n },
      { accountClass: "ASSET", currency: "IDR", native: 250_000n },
      { accountClass: "LIABILITY", currency: "IDR", native: -400_000n },
    ]
    const result = normalizeNetWorthAt(balances, noRate, "IDR")
    expect(result.assets).toBe(1_250_000n)
    expect(result.liabilities).toBe(400_000n)
    expect(result.netWorth).toBe(850_000n)
    expect(result.unconverted).toEqual([])
  })

  test("netWorth === assets - liabilities holds by construction", () => {
    const balances: PointBalance[] = [
      { accountClass: "ASSET", currency: "IDR", native: 777_777n },
      { accountClass: "ASSET", currency: "IDR", native: -120n }, // overdraft asset
      { accountClass: "LIABILITY", currency: "IDR", native: -333_333n },
    ]
    const result = normalizeNetWorthAt(balances, noRate, "IDR")
    expect(result.netWorth).toBe(result.assets - result.liabilities)
  })

  test("converts foreign balances via convertMinor with the resolved rate", () => {
    const balances: PointBalance[] = [
      { accountClass: "ASSET", currency: "IDR", native: 1_000_000n },
      { accountClass: "ASSET", currency: "USD", native: 100n },
    ]
    const result = normalizeNetWorthAt(balances, () => USD_IDR, "IDR")
    const expectedUsd = convertMinor(100n, "USD", "IDR", USD_IDR)
    expect(result.assets).toBe(1_000_000n + (expectedUsd as bigint))
    expect(result.netWorth).toBe(result.assets)
  })

  test("excludes unconverted foreign accounts and lists them, never zeroes", () => {
    const balances: PointBalance[] = [
      { accountClass: "ASSET", currency: "IDR", native: 500_000n },
      { accountClass: "ASSET", currency: "USD", native: 100n },
      { accountClass: "ASSET", currency: "USD", native: 25n },
    ]
    const result = normalizeNetWorthAt(balances, noRate, "IDR")
    expect(result.assets).toBe(500_000n)
    expect(result.unconverted).toEqual([{ currency: "USD", native: 125n }])
  })
})

// =============================================================================
// generateSampleDates — bounded calendar sampling
// =============================================================================

describe("generateSampleDates", () => {
  test("daily sampling is inclusive of both endpoints", () => {
    expect(generateSampleDates("2026-01-01", "2026-01-04", "day")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ])
  })

  test("monthly sampling always includes the final `to` date", () => {
    expect(generateSampleDates("2026-01-15", "2026-03-10", "month")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-10",
    ])
  })

  test("single-day range yields exactly one point", () => {
    expect(generateSampleDates("2026-06-21", "2026-06-21", "day")).toEqual([
      "2026-06-21",
    ])
  })

  test("rejects from > to", () => {
    expect(() =>
      generateSampleDates("2026-02-01", "2026-01-01", "day")
    ).toThrow(RangeError)
  })

  test(`rejects ranges exceeding ${MAX_SERIES_POINTS} points`, () => {
    expect(() =>
      generateSampleDates("2026-01-01", "2027-12-31", "day")
    ).toThrow(/exceeds/)
  })
})

// =============================================================================
// buildNetWorthSeries — the fold
// =============================================================================

describe("buildNetWorthSeries", () => {
  test("cash-like balance = opening anchor + Σ flow up to each sample date", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-05",
        to: "2026-01-25",
        interval: "month",
        accounts: [
          {
            id: "a",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
        ],
        valuations: [
          {
            accountId: "a",
            value: 100_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
        transactions: [
          {
            accountId: "a",
            amount: -30_000n,
            date: new Date("2026-01-10T00:00:00Z"),
          },
          {
            accountId: "a",
            amount: 50_000n,
            date: new Date("2026-01-20T00:00:00Z"),
          },
        ],
      })
    )
    expect(pointByDate(points, "2026-01-05").netWorth).toBe(100_000n)
    expect(pointByDate(points, "2026-01-25").netWorth).toBe(120_000n)
  })

  test("tracked balance carries forward the latest valuation <= T", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-03-01",
        interval: "month",
        accounts: [
          {
            id: "gold",
            accountClass: "ASSET",
            balanceSource: "valuation",
            currency: "IDR",
          },
        ],
        valuations: [
          {
            accountId: "gold",
            value: 10_000_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
          {
            accountId: "gold",
            value: 12_000_000n,
            valuationDate: "2026-02-15",
            type: "market",
          },
        ],
      })
    )
    expect(pointByDate(points, "2026-01-01").netWorth).toBe(10_000_000n)
    // 2026-02-01: market valuation (02-15) not yet effective → carry opening.
    expect(pointByDate(points, "2026-02-01").netWorth).toBe(10_000_000n)
    // 2026-03-01: latest <= T is the 02-15 market valuation.
    expect(pointByDate(points, "2026-03-01").netWorth).toBe(12_000_000n)
  })

  test("liabilities reduce net worth (assets - liabilities)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        accounts: [
          {
            id: "cash",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
          {
            id: "card",
            accountClass: "LIABILITY",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
        ],
        valuations: [
          {
            accountId: "cash",
            value: 1_000_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
          {
            accountId: "card",
            value: -250_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
      })
    )
    const point = pointByDate(points, "2026-01-01")
    expect(point.assets).toBe(1_000_000n)
    expect(point.liabilities).toBe(250_000n)
    expect(point.netWorth).toBe(750_000n)
  })

  test("an idle foreign balance re-values mark-to-market as FX moves", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-10",
        to: "2026-01-20",
        interval: "day",
        accounts: [
          {
            id: "usd",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "USD",
          },
        ],
        valuations: [
          {
            accountId: "usd",
            value: 100n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
        snapshots: [
          {
            fromCurrency: "USD",
            rateScaled: encodeRate("16000"),
            asOfDate: "2026-01-05",
          },
          {
            fromCurrency: "USD",
            rateScaled: encodeRate("17000"),
            asOfDate: "2026-01-15",
          },
        ],
      })
    )
    // Same native balance (no transactions), different base value as the rate steps.
    expect(pointByDate(points, "2026-01-10").netWorth).toBe(
      convertMinor(100n, "USD", "IDR", encodeRate("16000")) as bigint
    )
    expect(pointByDate(points, "2026-01-20").netWorth).toBe(
      convertMinor(100n, "USD", "IDR", encodeRate("17000")) as bigint
    )
  })

  test("a future-dated rate never affects an earlier point (clamp <= T)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-10",
        to: "2026-01-10",
        interval: "day",
        accounts: [
          {
            id: "usd",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "USD",
          },
        ],
        valuations: [
          {
            accountId: "usd",
            value: 100n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
        snapshots: [
          {
            fromCurrency: "USD",
            rateScaled: encodeRate("16000"),
            asOfDate: "2026-01-05",
          },
          // dated AFTER the sample — must be ignored.
          {
            fromCurrency: "USD",
            rateScaled: encodeRate("99999"),
            asOfDate: "2026-01-31",
          },
        ],
      })
    )
    expect(pointByDate(points, "2026-01-10").netWorth).toBe(
      convertMinor(100n, "USD", "IDR", encodeRate("16000")) as bigint
    )
  })

  test("FX-pending: dates before the earliest rate are partial and excluded", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-01-10",
        interval: "day",
        accounts: [
          {
            id: "idr",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
          {
            id: "usd",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "USD",
          },
        ],
        valuations: [
          {
            accountId: "idr",
            value: 500_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
          {
            accountId: "usd",
            value: 100n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
        snapshots: [
          {
            fromCurrency: "USD",
            rateScaled: encodeRate("16000"),
            asOfDate: "2026-01-06",
          },
        ],
      })
    )
    const early = pointByDate(points, "2026-01-03")
    expect(early.isPartial).toBe(true)
    expect(early.unconverted).toEqual([{ currency: "USD", native: 100n }])
    expect(early.netWorth).toBe(500_000n) // USD excluded, not zeroed into the total
    const later = pointByDate(points, "2026-01-10")
    expect(later.isPartial).toBe(false)
    expect(later.netWorth).toBe(
      500_000n +
        (convertMinor(100n, "USD", "IDR", encodeRate("16000")) as bigint)
    )
  })

  test("an account created mid-range contributes 0 before its opening date", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-02-01",
        interval: "month",
        accounts: [
          {
            id: "late",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
        ],
        valuations: [
          {
            accountId: "late",
            value: 300_000n,
            valuationDate: "2026-01-20",
            type: "opening",
          },
        ],
      })
    )
    expect(pointByDate(points, "2026-01-01").netWorth).toBe(0n) // before inception
    expect(pointByDate(points, "2026-02-01").netWorth).toBe(300_000n)
  })

  test("activity dated before `from` shifts the first point (replay from inception)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-02-01",
        to: "2026-02-01",
        interval: "day",
        accounts: [
          {
            id: "a",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
        ],
        valuations: [
          {
            accountId: "a",
            value: 100_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
        transactions: [
          // dated BEFORE `from` — must still be included in the first point.
          {
            accountId: "a",
            amount: -40_000n,
            date: new Date("2026-01-15T00:00:00Z"),
          },
        ],
      })
    )
    expect(pointByDate(points, "2026-02-01").netWorth).toBe(60_000n)
  })

  test("transaction day boundary is computed in the family timezone", () => {
    const input = (timezone: string) =>
      baseInput({
        timezone,
        from: "2026-01-10",
        to: "2026-01-11",
        interval: "day",
        accounts: [
          {
            id: "a",
            accountClass: "ASSET",
            balanceSource: "transaction_flow",
            currency: "IDR",
          },
        ],
        valuations: [
          {
            accountId: "a",
            value: 100_000n,
            valuationDate: "2026-01-01",
            type: "opening",
          },
        ],
        transactions: [
          // 2026-01-10T20:00Z is still 2026-01-10 in UTC but 2026-01-11 in Jakarta (+7).
          {
            accountId: "a",
            amount: -10_000n,
            date: new Date("2026-01-10T20:00:00Z"),
          },
        ],
      })
    const utc = buildNetWorthSeries(input("UTC"))
    expect(pointByDate(utc, "2026-01-10").netWorth).toBe(90_000n)
    const jakarta = buildNetWorthSeries(input("Asia/Jakarta"))
    expect(pointByDate(jakarta, "2026-01-10").netWorth).toBe(100_000n) // not yet
    expect(pointByDate(jakarta, "2026-01-11").netWorth).toBe(90_000n)
  })
})
