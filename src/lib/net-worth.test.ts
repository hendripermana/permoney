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
  type SeriesAccount,
  type SeriesSnapshot,
  type SeriesValuation,
} from "./net-worth"

const USD_IDR = encodeRate("16000") // 1 USD = 16,000 IDR

// ---- factory helpers (keep the test literals DRY) ---------------------------

const cashAccount = (id: string, currency = "IDR"): SeriesAccount => ({
  id,
  accountClass: "ASSET",
  balanceSource: "transaction_flow",
  currency,
})
const liabilityAccount = (id: string, currency = "IDR"): SeriesAccount => ({
  id,
  accountClass: "LIABILITY",
  balanceSource: "transaction_flow",
  currency,
})
const trackedAccount = (id: string, currency = "IDR"): SeriesAccount => ({
  id,
  accountClass: "ASSET",
  balanceSource: "valuation",
  currency,
})
const valuation = (
  accountId: string,
  value: bigint,
  valuationDate: string,
  type = "opening",
  // Defaults to the valuation's own date at midnight UTC. `afterAnchor` uses
  // strict `>`, so a same-instant flow is NOT "after" — existing date-only
  // expectations are preserved unless a test passes explicit createdAt values.
  createdAt: Date = new Date(`${valuationDate}T00:00:00Z`)
): SeriesValuation => ({ accountId, value, valuationDate, type, createdAt })
const snapshot = (
  fromCurrency: string,
  rate: string,
  asOfDate: string
): SeriesSnapshot => ({ fromCurrency, rateScaled: encodeRate(rate), asOfDate })
const balance = (
  accountClass: string,
  currency: string,
  native: bigint
): PointBalance => ({ accountClass, currency, native })
const usdInIdr = (native: bigint, rate: string): bigint =>
  convertMinor(native, "USD", "IDR", encodeRate(rate)) as bigint

function pointByDate(points: NetWorthPoint[], date: string): NetWorthPoint {
  const point = points.find((p) => p.date === date)
  if (!point) {
    throw new Error(
      `no point for ${date} in ${points.map((p) => p.date).join(",")}`
    )
  }
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
    const result = normalizeNetWorthAt(
      [
        balance("ASSET", "IDR", 1_000_000n),
        balance("ASSET", "IDR", 250_000n),
        balance("LIABILITY", "IDR", -400_000n),
      ],
      noRate,
      "IDR"
    )
    expect(result.assets).toBe(1_250_000n)
    expect(result.liabilities).toBe(400_000n)
    expect(result.netWorth).toBe(850_000n)
    expect(result.unconverted).toEqual([])
  })

  test("netWorth === assets - liabilities holds by construction", () => {
    const result = normalizeNetWorthAt(
      [
        balance("ASSET", "IDR", 777_777n),
        balance("ASSET", "IDR", -120n), // overdraft asset
        balance("LIABILITY", "IDR", -333_333n),
      ],
      noRate,
      "IDR"
    )
    expect(result.netWorth).toBe(result.assets - result.liabilities)
  })

  test("converts foreign balances via convertMinor with the resolved rate", () => {
    const result = normalizeNetWorthAt(
      [balance("ASSET", "IDR", 1_000_000n), balance("ASSET", "USD", 100n)],
      () => USD_IDR,
      "IDR"
    )
    expect(result.assets).toBe(1_000_000n + usdInIdr(100n, "16000"))
    expect(result.netWorth).toBe(result.assets)
  })

  test("excludes unconverted foreign accounts and lists them, never zeroes", () => {
    const result = normalizeNetWorthAt(
      [
        balance("ASSET", "IDR", 500_000n),
        balance("ASSET", "USD", 100n),
        balance("ASSET", "USD", 25n),
      ],
      noRate,
      "IDR"
    )
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
  const txn = (
    accountId: string,
    amount: bigint,
    iso: string,
    createdAtIso: string = iso
  ) => ({
    accountId,
    amount,
    date: new Date(iso),
    createdAt: new Date(createdAtIso),
  })

  test("cash-like balance = opening anchor + Σ flow up to each sample date", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-05",
        to: "2026-01-25",
        interval: "month",
        accounts: [cashAccount("a")],
        valuations: [valuation("a", 100_000n, "2026-01-01")],
        transactions: [
          txn("a", -30_000n, "2026-01-10T00:00:00Z"),
          txn("a", 50_000n, "2026-01-20T00:00:00Z"),
        ],
      })
    )
    expect(pointByDate(points, "2026-01-05").netWorth).toBe(100_000n)
    expect(pointByDate(points, "2026-01-25").netWorth).toBe(120_000n)
  })

  // PER-204: a cash account anchored by a RECONCILIATION valuation (not an
  // `opening`) — the shape of every Sure-migrated / reconciled account — must
  // resolve to its asserted balance, not 0. The old opening-only fold zeroed it.
  test("reconciliation anchor (no opening) sets the cash balance — PER-204", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-03-01",
        interval: "month",
        accounts: [cashAccount("a")],
        valuations: [
          valuation("a", 210_000_000n, "2026-02-15", "reconciliation"),
        ],
        transactions: [txn("a", 5_000_000n, "2026-02-20T00:00:00Z")],
      })
    )
    // Before the anchor's date the account has no anchor yet → 0.
    expect(pointByDate(points, "2026-01-01").netWorth).toBe(0n)
    // At/after: asserted value + post-anchor flow (dated after the anchor).
    expect(pointByDate(points, "2026-03-01").netWorth).toBe(215_000_000n)
  })

  // A later reconciliation asserts a fresh balance that ABSORBS all flow dated
  // at/before it and already recorded — mirrors `computeCanonicalBalance`.
  test("a later reconciliation anchor overrides accumulated flow (absorbs prior)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-03-01",
        interval: "month",
        accounts: [cashAccount("a")],
        valuations: [
          valuation("a", 100_000n, "2026-01-01", "opening"),
          valuation("a", 500_000n, "2026-02-10", "reconciliation"),
        ],
        transactions: [
          txn("a", 999_999n, "2026-01-15T00:00:00Z"), // absorbed by the reconciliation
          txn("a", 20_000n, "2026-02-20T00:00:00Z"), // after it → counted
        ],
      })
    )
    // Jan (opening active): 100k + the 01-15 flow.
    expect(pointByDate(points, "2026-01-01").netWorth).toBe(100_000n)
    expect(pointByDate(points, "2026-02-01").netWorth).toBe(1_099_999n)
    // Mar (reconciliation active): asserts 500k, prior flow absorbed, +20k after.
    expect(pointByDate(points, "2026-03-01").netWorth).toBe(520_000n)
  })

  // The `afterAnchor` createdAt disjunct (PER-201): a txn dated BEFORE the anchor
  // but RECORDED after it is genuine post-anchor activity and must be counted;
  // the same-date txn recorded before the anchor is absorbed.
  test("a back-dated txn recorded after the anchor is counted (createdAt disjunct)", () => {
    const anchorCreatedAt = new Date("2026-02-10T09:00:00Z")
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-02-01",
        to: "2026-03-01",
        interval: "month",
        accounts: [cashAccount("a")],
        valuations: [
          valuation(
            "a",
            500_000n,
            "2026-02-10",
            "reconciliation",
            anchorCreatedAt
          ),
        ],
        transactions: [
          // dated before the anchor date, recorded AFTER it → post-anchor.
          txn("a", 7_000n, "2026-02-05T00:00:00Z", "2026-02-11T00:00:00Z"),
          // dated before AND recorded before the anchor → absorbed.
          txn("a", 3_000n, "2026-02-05T00:00:00Z", "2026-02-09T00:00:00Z"),
        ],
      })
    )
    expect(pointByDate(points, "2026-03-01").netWorth).toBe(507_000n)
  })

  // No-anchor edge: `computeCanonicalBalance` falls back to the stored balance,
  // which for a canonically-created account equals opening-0 + Σ all flow. The
  // fold never reads Account.balance, so it folds an anchor-less cash account as
  // an implicit opening-0: 0 + Σ all flow ≤ T.
  test("an account with no anchor of any type folds as opening-0 (Σ all flow)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-02-01",
        interval: "month",
        accounts: [cashAccount("a")],
        valuations: [], // no opening / reconciliation / manual
        transactions: [
          txn("a", 40_000n, "2026-01-10T00:00:00Z"),
          txn("a", -15_000n, "2026-01-20T00:00:00Z"),
        ],
      })
    )
    expect(pointByDate(points, "2026-01-01").netWorth).toBe(0n) // no flow yet
    expect(pointByDate(points, "2026-02-01").netWorth).toBe(25_000n)
  })

  // A `market` valuation is an OBSERVATION, never a cash anchor, so it must not
  // assert a transaction_flow balance — the account folds as opening-0 here.
  test("a market valuation is not a cash anchor (observation only)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-01-01",
        interval: "day",
        accounts: [cashAccount("a")],
        valuations: [valuation("a", 9_000_000n, "2026-01-01", "market")],
        transactions: [txn("a", 25_000n, "2026-01-01T00:00:00Z")],
      })
    )
    expect(pointByDate(points, "2026-01-01").netWorth).toBe(25_000n)
  })

  test("tracked balance carries forward the latest valuation <= T", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-03-01",
        interval: "month",
        accounts: [trackedAccount("gold")],
        valuations: [
          valuation("gold", 10_000_000n, "2026-01-01"),
          valuation("gold", 12_000_000n, "2026-02-15", "market"),
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
        accounts: [cashAccount("cash"), liabilityAccount("card")],
        valuations: [
          valuation("cash", 1_000_000n, "2026-01-01"),
          valuation("card", -250_000n, "2026-01-01"),
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
        accounts: [cashAccount("usd", "USD")],
        valuations: [valuation("usd", 100n, "2026-01-01")],
        snapshots: [
          snapshot("USD", "16000", "2026-01-05"),
          snapshot("USD", "17000", "2026-01-15"),
        ],
      })
    )
    // Same native balance (no transactions), different base value as the rate steps.
    expect(pointByDate(points, "2026-01-10").netWorth).toBe(
      usdInIdr(100n, "16000")
    )
    expect(pointByDate(points, "2026-01-20").netWorth).toBe(
      usdInIdr(100n, "17000")
    )
  })

  test("a future-dated rate never affects an earlier point (clamp <= T)", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-10",
        to: "2026-01-10",
        interval: "day",
        accounts: [cashAccount("usd", "USD")],
        valuations: [valuation("usd", 100n, "2026-01-01")],
        snapshots: [
          snapshot("USD", "16000", "2026-01-05"),
          snapshot("USD", "99999", "2026-01-31"), // dated AFTER the sample
        ],
      })
    )
    expect(pointByDate(points, "2026-01-10").netWorth).toBe(
      usdInIdr(100n, "16000")
    )
  })

  test("FX-pending: dates before the earliest rate are partial and excluded", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-01-10",
        interval: "day",
        accounts: [cashAccount("idr"), cashAccount("usd", "USD")],
        valuations: [
          valuation("idr", 500_000n, "2026-01-01"),
          valuation("usd", 100n, "2026-01-01"),
        ],
        snapshots: [snapshot("USD", "16000", "2026-01-06")],
      })
    )
    const early = pointByDate(points, "2026-01-03")
    expect(early.isPartial).toBe(true)
    expect(early.unconverted).toEqual([{ currency: "USD", native: 100n }])
    expect(early.netWorth).toBe(500_000n) // USD excluded, not zeroed into the total
    const later = pointByDate(points, "2026-01-10")
    expect(later.isPartial).toBe(false)
    expect(later.netWorth).toBe(500_000n + usdInIdr(100n, "16000"))
  })

  test("an account created mid-range contributes 0 before its opening date", () => {
    const points = buildNetWorthSeries(
      baseInput({
        from: "2026-01-01",
        to: "2026-02-01",
        interval: "month",
        accounts: [cashAccount("late")],
        valuations: [valuation("late", 300_000n, "2026-01-20")],
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
        accounts: [cashAccount("a")],
        valuations: [valuation("a", 100_000n, "2026-01-01")],
        // dated BEFORE `from` — must still be included in the first point.
        transactions: [txn("a", -40_000n, "2026-01-15T00:00:00Z")],
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
        accounts: [cashAccount("a")],
        valuations: [valuation("a", 100_000n, "2026-01-01")],
        // 2026-01-10T20:00Z is still 2026-01-10 in UTC but 2026-01-11 in Jakarta (+7).
        transactions: [txn("a", -10_000n, "2026-01-10T20:00:00Z")],
      })
    const utc = buildNetWorthSeries(input("UTC"))
    expect(pointByDate(utc, "2026-01-10").netWorth).toBe(90_000n)
    const jakarta = buildNetWorthSeries(input("Asia/Jakarta"))
    expect(pointByDate(jakarta, "2026-01-10").netWorth).toBe(100_000n) // not yet
    expect(pointByDate(jakarta, "2026-01-11").netWorth).toBe(90_000n)
  })
})
