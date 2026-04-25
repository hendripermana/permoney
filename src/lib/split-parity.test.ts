import { describe, expect, it } from "vite-plus/test"
import {
  assertSplitParity,
  checkSplitParity,
  SPLIT_PARITY_EPSILON,
  type ParitySplitInput,
} from "./split-parity"

// =============================================================================
// checkSplitParity (non-throwing)
// =============================================================================

describe("checkSplitParity", () => {
  describe("when isSplit is false", () => {
    it("passes regardless of entries (split flag off → guard skipped)", () => {
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: false,
        splitEntries: [{ amount: 1 }, { amount: 2 }],
      })
      expect(result.ok).toBe(true)
      expect(result.delta).toBe(0)
    })

    it("passes when no splitEntries provided", () => {
      const result = checkSplitParity({ amount: 50_000, isSplit: false })
      expect(result.ok).toBe(true)
    })
  })

  describe("when isSplit is true but entries are absent", () => {
    it("passes for empty array (upstream concern, not parity's)", () => {
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: [],
      })
      expect(result.ok).toBe(true)
    })

    it("passes for null splitEntries", () => {
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: null,
      })
      expect(result.ok).toBe(true)
    })

    it("passes for undefined splitEntries", () => {
      const result = checkSplitParity({ amount: 100_000, isSplit: true })
      expect(result.ok).toBe(true)
    })
  })

  describe("happy path — sum exactly matches parent", () => {
    it("two entries summing to parent", () => {
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: [{ amount: 60_000 }, { amount: 40_000 }],
      })
      expect(result.ok).toBe(true)
      expect(result.splitSum).toBe(100_000)
      expect(result.delta).toBe(0)
    })

    it("many small entries summing to parent", () => {
      const entries = Array.from({ length: 20 }, () => ({ amount: 5_000 }))
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: entries,
      })
      expect(result.ok).toBe(true)
      expect(result.splitSum).toBe(100_000)
    })

    it("single entry equal to parent (degenerate split)", () => {
      const result = checkSplitParity({
        amount: 50_000,
        isSplit: true,
        splitEntries: [{ amount: 50_000 }],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("violation cases", () => {
    it("fails when sum is greater than parent (over-budget)", () => {
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: [{ amount: 60_000 }, { amount: 50_000 }],
      })
      expect(result.ok).toBe(false)
      expect(result.splitSum).toBe(110_000)
      expect(result.delta).toBe(10_000)
    })

    it("fails when sum is less than parent (under-budget)", () => {
      const result = checkSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: [{ amount: 30_000 }, { amount: 50_000 }],
      })
      expect(result.ok).toBe(false)
      expect(result.splitSum).toBe(80_000)
      expect(result.delta).toBe(20_000)
    })

    it("fails when delta exactly exceeds epsilon (boundary)", () => {
      // amount=10, sum=10.02 → delta=0.02 > 0.01 epsilon
      const result = checkSplitParity({
        amount: 10,
        isSplit: true,
        splitEntries: [{ amount: 5 }, { amount: 5.02 }],
      })
      expect(result.ok).toBe(false)
      // Use closeTo for the comparison itself — Float arithmetic again.
      expect(result.delta).toBeCloseTo(0.02, 5)
    })
  })

  describe("epsilon tolerance (Float-noise absorption)", () => {
    it("accepts the classic 0.1 + 0.2 ≠ 0.3 case", () => {
      // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
      const result = checkSplitParity({
        amount: 0.3,
        isSplit: true,
        splitEntries: [{ amount: 0.1 }, { amount: 0.2 }],
      })
      expect(result.ok).toBe(true)
      expect(result.delta).toBeLessThan(SPLIT_PARITY_EPSILON)
    })

    it("accepts delta exactly at epsilon boundary (inclusive)", () => {
      // amount=100, sum=100.01 → delta=0.01 === epsilon → OK
      const result = checkSplitParity({
        amount: 100,
        isSplit: true,
        splitEntries: [{ amount: 50 }, { amount: 50.01 }],
      })
      expect(result.ok).toBe(true)
    })

    it("rejects delta of 1 cent above epsilon", () => {
      const result = checkSplitParity({
        amount: 100,
        isSplit: true,
        splitEntries: [{ amount: 50 }, { amount: 50.02 }],
      })
      expect(result.ok).toBe(false)
    })
  })

  describe("hostile inputs (defense in depth)", () => {
    it("fails when parent amount is NaN", () => {
      const result = checkSplitParity({
        amount: Number.NaN,
        isSplit: true,
        splitEntries: [{ amount: 50 }],
      })
      expect(result.ok).toBe(false)
    })

    it("fails when an entry amount is NaN", () => {
      const result = checkSplitParity({
        amount: 100,
        isSplit: true,
        splitEntries: [{ amount: 50 }, { amount: Number.NaN }],
      })
      expect(result.ok).toBe(false)
    })

    it("fails when an entry amount is Infinity", () => {
      const result = checkSplitParity({
        amount: 100,
        isSplit: true,
        splitEntries: [{ amount: Number.POSITIVE_INFINITY }],
      })
      expect(result.ok).toBe(false)
    })
  })
})

// =============================================================================
// assertSplitParity (throwing variant for $transaction blocks)
// =============================================================================

describe("assertSplitParity", () => {
  it("does not throw on valid input", () => {
    expect(() =>
      assertSplitParity({
        amount: 100,
        isSplit: true,
        splitEntries: [{ amount: 60 }, { amount: 40 }],
      })
    ).not.toThrow()
  })

  it("does not throw when isSplit is false", () => {
    expect(() =>
      assertSplitParity({
        amount: 100,
        isSplit: false,
        splitEntries: [{ amount: 999 }],
      })
    ).not.toThrow()
  })

  it("throws Error with SPLIT_PARITY_VIOLATION prefix on mismatch", () => {
    expect(() =>
      assertSplitParity({
        amount: 100_000,
        isSplit: true,
        splitEntries: [{ amount: 60_000 }, { amount: 50_000 }],
      })
    ).toThrow(/^SPLIT_PARITY_VIOLATION:/)
  })

  it("error message includes both sums and delta for debuggability", () => {
    const input: ParitySplitInput = {
      amount: 100,
      isSplit: true,
      splitEntries: [{ amount: 80 }],
    }

    let caught: unknown
    try {
      assertSplitParity(input)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain("100.00")
    expect(msg).toContain("80.00")
    expect(msg).toContain("Δ = 20.00")
    expect(msg).toContain("epsilon")
  })

  it("throws on NaN inputs (does not silently accept)", () => {
    expect(() =>
      assertSplitParity({
        amount: 100,
        isSplit: true,
        splitEntries: [{ amount: Number.NaN }],
      })
    ).toThrow(/SPLIT_PARITY_VIOLATION/)
  })
})
