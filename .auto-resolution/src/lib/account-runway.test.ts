import { describe, expect, test } from "vite-plus/test"
import { computeAccountRunway, isRunwayAlerting } from "./account-runway"
import { type AnalyticsTxn } from "./account-analytics"

// Fixed "now" so every forecast is deterministic.
const NOW = new Date("2026-08-02T12:00:00.000Z")
const DAY_MS = 86_400_000
const ACC = "acc-1"

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS)
}

/** An expense (money leaving the account) `n` days ago. */
function expense(amount: bigint, n: number): AnalyticsTxn {
  return { date: daysAgo(n), amount, type: "expense", accountId: ACC }
}

/** Income (money arriving) `n` days ago. */
function income(amount: bigint, n: number): AnalyticsTxn {
  return { date: daysAgo(n), amount, type: "income", accountId: ACC }
}

describe("computeAccountRunway", () => {
  test("growing: net inflow over the window → no dip forecast", () => {
    const txns = [
      income(500_000n, 2),
      income(600_000n, 10),
      income(400_000n, 20),
    ]
    const r = computeAccountRunway(txns, 2_000_000n, 500_000n, ACC, {
      now: NOW,
    })
    expect(r.status).toBe("growing")
    expect(r.daysToReserve).toBeNull()
    expect(r.dailyBurnMinor).toBeNull()
    expect(r.netDailyFlowMinor > 0n).toBe(true)
  })

  test("critical: burns down to the reserve floor in < 7 days", () => {
    // available = 1,000,000 − 500,000 = 500,000; burn 100,000/day → 5 days.
    const txns = Array.from({ length: 8 }, (_, i) => expense(375_000n, i + 1))
    const r = computeAccountRunway(txns, 1_000_000n, 500_000n, ACC, {
      now: NOW,
    })
    expect(r.status).toBe("critical")
    expect(r.daysToReserve).toBe(5)
    expect(r.dailyBurnMinor).toBe(100_000n)
    expect(r.reserveDate).not.toBeNull()
    expect(isRunwayAlerting(r.status)).toBe(true)
  })

  test("watch: dips below the floor within 30 days", () => {
    // available = 500,000; burn 25,000/day → 20 days.
    const txns = Array.from({ length: 8 }, () => expense(93_750n, 15))
    const r = computeAccountRunway(txns, 1_000_000n, 500_000n, ACC, {
      now: NOW,
    })
    expect(r.status).toBe("watch")
    expect(r.daysToReserve).toBe(20)
    expect(isRunwayAlerting(r.status)).toBe(true)
  })

  test("healthy: burning, but more than 30 days of runway", () => {
    // available = 10,000,000; burn 10,000/day → 1000 days.
    const txns = Array.from({ length: 8 }, () => expense(37_500n, 12))
    const r = computeAccountRunway(txns, 10_500_000n, 500_000n, ACC, {
      now: NOW,
    })
    expect(r.status).toBe("healthy")
    expect(r.daysToReserve).toBeGreaterThan(30)
    expect(isRunwayAlerting(r.status)).toBe(false)
  })

  test("below: already at/under the reserve floor, regardless of activity", () => {
    const txns = [expense(50_000n, 1)]
    const r = computeAccountRunway(txns, 400_000n, 500_000n, ACC, { now: NOW })
    expect(r.status).toBe("below")
    expect(r.daysToReserve).toBe(0)
    expect(isRunwayAlerting(r.status)).toBe(true)
  })

  test("insufficient_data: above the floor but too few recent transactions", () => {
    const txns = [expense(100_000n, 3), expense(100_000n, 5)] // 2 < minSamples(3)
    const r = computeAccountRunway(txns, 1_000_000n, 500_000n, ACC, {
      now: NOW,
    })
    expect(r.status).toBe("insufficient_data")
    expect(r.daysToReserve).toBeNull()
    expect(r.lowConfidence).toBe(true)
  })

  test("thin sample (3–7 txns) forecasts but flags low confidence", () => {
    const txns = Array.from({ length: 5 }, (_, i) => expense(200_000n, i + 1))
    const r = computeAccountRunway(txns, 1_000_000n, 500_000n, ACC, {
      now: NOW,
    })
    expect(r.sampleSize).toBe(5)
    expect(r.lowConfidence).toBe(true)
    expect(["critical", "watch", "healthy"]).toContain(r.status)
  })

  test("ignores transactions outside the trailing window", () => {
    // A big spend 45 days ago must NOT count in a 30-day window.
    const txns = [expense(9_000_000n, 45), expense(30_000n, 2)]
    const r = computeAccountRunway(txns, 1_000_000n, 0n, ACC, {
      now: NOW,
      windowDays: 30,
    })
    expect(r.sampleSize).toBe(1)
  })

  test("no reserve → runway to empty (floor = 0)", () => {
    // available = full balance 300,000; burn 30,000/day over 30d → 10 days.
    const txns = Array.from({ length: 8 }, () => expense(112_500n, 10))
    const r = computeAccountRunway(txns, 300_000n, 0n, ACC, { now: NOW })
    expect(r.status).toBe("watch")
    expect(r.daysToReserve).toBe(10)
  })

  test("transfers count from this account's perspective (out = burn)", () => {
    // Transfers OUT of ACC are negative deltas → contribute to burn.
    const txns = Array.from({ length: 8 }, () => ({
      date: daysAgo(6),
      amount: 62_500n,
      type: "transfer" as const,
      accountId: ACC,
      toAccountId: "other",
    }))
    const r = computeAccountRunway(txns, 1_000_000n, 500_000n, ACC, {
      now: NOW,
    })
    // 8 × 62,500 = 500,000 over 30d → burn ~16,667/day → available 500,000 → ~30d.
    expect(r.dailyBurnMinor).not.toBeNull()
    expect(["watch", "healthy"]).toContain(r.status)
  })
})
