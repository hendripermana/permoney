import { describe, expect, test } from "vite-plus/test"
import { computeAccountPerformance } from "./account-performance"
import { type AnalyticsTxn } from "./account-analytics"

const ACC = "inv-1"

/** A transfer INTO the account (a buy / contribution). */
function buy(amount: bigint): AnalyticsTxn {
  return {
    date: "2026-01-01",
    amount,
    type: "transfer",
    accountId: "bank",
    toAccountId: ACC,
  }
}
/** A transfer OUT of the account (a sell / withdrawal). */
function sell(amount: bigint): AnalyticsTxn {
  return {
    date: "2026-02-01",
    amount,
    type: "transfer",
    accountId: ACC,
    toAccountId: "bank",
  }
}

describe("computeAccountPerformance", () => {
  test("opening-only account that gained: cost = opening, gain = value − opening", () => {
    // Gold bought at 20,000,000 (opening), now worth 25,000,000, no transfers.
    const p = computeAccountPerformance([], 20_000_000n, 25_000_000n, ACC)
    expect(p.costBasisMinor).toBe(20_000_000n)
    expect(p.marketValueMinor).toBe(25_000_000n)
    expect(p.gainMinor).toBe(5_000_000n)
    expect(p.returnPct).toBeCloseTo(0.25, 5)
    expect(p.isGain).toBe(true)
    expect(p.hasBasis).toBe(true)
  })

  test("opening + later contributions add to the cost basis", () => {
    // opening 10,000,000 + buy 5,000,000 = 15,000,000 invested; now worth 18,000,000.
    const p = computeAccountPerformance(
      [buy(5_000_000n)],
      10_000_000n,
      18_000_000n,
      ACC
    )
    expect(p.contributionsMinor).toBe(5_000_000n)
    expect(p.costBasisMinor).toBe(15_000_000n)
    expect(p.gainMinor).toBe(3_000_000n)
    expect(p.isGain).toBe(true)
  })

  test("contribution-only account (opening 0)", () => {
    const p = computeAccountPerformance([buy(8_000_000n)], 0n, 9_000_000n, ACC)
    expect(p.costBasisMinor).toBe(8_000_000n)
    expect(p.gainMinor).toBe(1_000_000n)
    expect(p.hasBasis).toBe(true)
  })

  test("a loss shows negative gain", () => {
    const p = computeAccountPerformance([], 20_000_000n, 17_000_000n, ACC)
    expect(p.gainMinor).toBe(-3_000_000n)
    expect(p.isGain).toBe(false)
    expect(p.returnPct).toBeCloseTo(-0.15, 5)
  })

  test("flat: value equals cost basis", () => {
    const p = computeAccountPerformance([], 5_000_000n, 5_000_000n, ACC)
    expect(p.gainMinor).toBe(0n)
    expect(p.isFlat).toBe(true)
    expect(p.isGain).toBe(false)
    expect(p.returnPct).toBe(0)
  })

  test("withdrawal reduces cost basis dollar-for-dollar", () => {
    // opening 10,000,000, then sell 4,000,000 out → basis 6,000,000; now worth 9,000,000.
    const p = computeAccountPerformance(
      [sell(4_000_000n)],
      10_000_000n,
      9_000_000n,
      ACC
    )
    expect(p.contributionsMinor).toBe(-4_000_000n)
    expect(p.costBasisMinor).toBe(6_000_000n)
    expect(p.gainMinor).toBe(3_000_000n)
  })

  test("no positive basis → hasBasis false, no fabricated return", () => {
    // Withdrew more than invested (after gains): basis goes non-positive.
    const p = computeAccountPerformance(
      [sell(12_000_000n)],
      10_000_000n,
      2_000_000n,
      ACC
    )
    expect(p.costBasisMinor).toBe(-2_000_000n)
    expect(p.hasBasis).toBe(false)
    expect(p.returnPct).toBeNull()
  })
})
