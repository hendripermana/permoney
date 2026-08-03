import { describe, expect, test } from "vite-plus/test"
import { computeIdleCash } from "./account-idle-cash"
import { type AnalyticsTxn } from "./account-analytics"

const NOW = new Date("2026-08-02T12:00:00.000Z")
const DAY_MS = 86_400_000
const ACC = "acc-1"

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS)
}
function expense(amount: bigint, n: number): AnalyticsTxn {
  return { date: daysAgo(n), amount, type: "expense", accountId: ACC }
}
function income(amount: bigint, n: number): AnalyticsTxn {
  return { date: daysAgo(n), amount, type: "income", accountId: ACC }
}

describe("computeIdleCash", () => {
  test("flags a large surplus that stayed above the reserve all window", () => {
    // Funded 90d ago (pre-window evidence), then tiny churn; the low-water mark
    // stays high → most of the balance has provably sat idle.
    const txns = [
      income(10_000_000n, 90),
      expense(100_000n, 40),
      income(100_000n, 20),
    ]
    const r = computeIdleCash(txns, 10_000_000n, 500_000n, ACC, { now: NOW })
    expect(r.hasSurplus).toBe(true)
    expect(r.idleSurplusMinor > 8_000_000n).toBe(true)
    expect(r.fractionIdle).toBeGreaterThan(0.8)
  })

  test("honesty guard: no pre-window history → not claimed (new vs idle is ambiguous)", () => {
    // High stable balance but the only activity is inside the window, so we
    // cannot prove the account is old enough to call it "idle 60+ days".
    const txns = [expense(100_000n, 10)]
    const r = computeIdleCash(txns, 5_000_000n, 0n, ACC, { now: NOW })
    expect(r.minBalanceMinor > 0n).toBe(true) // surplus exists numerically…
    expect(r.hasSurplus).toBe(false) // …but is not surfaced without coverage
  })

  test("zero-history balance (opening-only account) is not claimed", () => {
    const r = computeIdleCash([], 3_000_000n, 500_000n, ACC, { now: NOW })
    expect(r.hasSurplus).toBe(false)
  })

  test("no surplus when the balance dipped near the reserve during the window", () => {
    // Funded 90d ago (coverage present), then swung down to ~reserve mid-window
    // and back — so nothing actually sat idle.
    const txns = [
      income(5_000_000n, 90),
      expense(4_600_000n, 30), // down to 400,000
      income(4_600_000n, 10), // back to 5,000,000
    ]
    const r = computeIdleCash(txns, 5_000_000n, 500_000n, ACC, { now: NOW })
    expect(r.minBalanceMinor).toBe(400_000n)
    expect(r.hasSurplus).toBe(false)
    expect(r.idleSurplusMinor).toBe(0n)
  })

  test("respects the minFraction gate (small surplus not surfaced)", () => {
    // Coverage present (funded 90d ago); surplus is only ~10% of balance.
    const txns = [income(1_000_000n, 90), expense(100_000n, 15)]
    const r = computeIdleCash(txns, 1_000_000n, 900_000n, ACC, { now: NOW })
    expect(r.fractionIdle).toBeLessThan(0.2)
    expect(r.hasSurplus).toBe(false)
  })

  test("no reserve → all stably-held cash counts as idle (with coverage)", () => {
    const txns = [income(2_000_000n, 90)]
    const r = computeIdleCash(txns, 2_000_000n, 0n, ACC, { now: NOW })
    expect(r.idleSurplusMinor).toBe(2_000_000n)
    expect(r.hasSurplus).toBe(true)
  })

  test("a dip OUTSIDE the window does not lower the idle surplus", () => {
    // Big dip 90/89 days ago (outside the 60d window) then stable high since.
    const txns = [
      income(10_000_000n, 120),
      expense(9_000_000n, 90),
      income(9_000_000n, 89),
    ]
    const r = computeIdleCash(txns, 10_000_000n, 500_000n, ACC, {
      now: NOW,
      windowDays: 60,
    })
    expect(r.minBalanceMinor).toBe(10_000_000n)
    expect(r.hasSurplus).toBe(true)
  })

  test("current balance at/below reserve → no idle surplus", () => {
    const txns = [income(500_000n, 90)]
    const r = computeIdleCash(txns, 500_000n, 500_000n, ACC, { now: NOW })
    expect(r.idleSurplusMinor).toBe(0n)
    expect(r.hasSurplus).toBe(false)
  })
})
