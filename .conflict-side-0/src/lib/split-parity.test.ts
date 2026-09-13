import { describe, expect, it } from "vite-plus/test"
import {
  assertSplitParity,
  checkSplitParity,
  type ParitySplitInput,
} from "./split-parity"

// =============================================================================
// checkSplitParity (non-throwing) — bigint edition (post-ADR-0001)
// =============================================================================

describe("checkSplitParity", () => {
  describe("when isSplit is false", () => {
    it("passes regardless of entries (split flag off → guard skipped)", () => {
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: false,
        splitEntries: [{ amount: 1n }, { amount: 2n }],
      })
      expect(result.ok).toBe(true)
      expect(result.delta).toBe(0n)
    })

    it("passes when no splitEntries provided", () => {
      const result = checkSplitParity({ amount: 50_000n, isSplit: false })
      expect(result.ok).toBe(true)
    })
  })

  describe("when isSplit is true but entries are absent", () => {
    it("passes for empty array (upstream concern, not parity's)", () => {
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [],
      })
      expect(result.ok).toBe(true)
    })

    it("passes for null splitEntries", () => {
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: null,
      })
      expect(result.ok).toBe(true)
    })

    it("passes for undefined splitEntries", () => {
      const result = checkSplitParity({ amount: 100_000n, isSplit: true })
      expect(result.ok).toBe(true)
    })
  })

  describe("happy path — sum exactly matches parent", () => {
    it("two entries summing to parent", () => {
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [{ amount: 60_000n }, { amount: 40_000n }],
      })
      expect(result.ok).toBe(true)
      expect(result.splitSum).toBe(100_000n)
      expect(result.delta).toBe(0n)
    })

    it("many small entries summing to parent", () => {
      const entries = Array.from({ length: 20 }, () => ({ amount: 5_000n }))
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: entries,
      })
      expect(result.ok).toBe(true)
      expect(result.splitSum).toBe(100_000n)
    })

    it("single entry equal to parent (degenerate split)", () => {
      const result = checkSplitParity({
        amount: 50_000n,
        isSplit: true,
        splitEntries: [{ amount: 50_000n }],
      })
      expect(result.ok).toBe(true)
    })

    it("parent is negative (expense), children stored as magnitudes", () => {
      // Real flow: an expense parent is stored as -100_000n, but split
      // children are positive. Parity uses |parent|.
      const result = checkSplitParity({
        amount: -100_000n,
        isSplit: true,
        splitEntries: [{ amount: 60_000n }, { amount: 40_000n }],
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("violation cases", () => {
    it("fails when sum is greater than parent (over-budget)", () => {
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [{ amount: 60_000n }, { amount: 50_000n }],
      })
      expect(result.ok).toBe(false)
      expect(result.splitSum).toBe(110_000n)
      expect(result.delta).toBe(10_000n)
    })

    it("fails when sum is less than parent (under-budget)", () => {
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [{ amount: 30_000n }, { amount: 50_000n }],
      })
      expect(result.ok).toBe(false)
      expect(result.splitSum).toBe(80_000n)
      expect(result.delta).toBe(20_000n)
    })

    it("fails on a 1-minor-unit difference (exact equality required)", () => {
      // Pre-bigint, the old epsilon=0.01 hack would have masked this. With
      // BigInt arithmetic we catch single-minor-unit drift.
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [{ amount: 50_000n }, { amount: 50_001n }],
      })
      expect(result.ok).toBe(false)
      expect(result.delta).toBe(1n)
    })
  })

  describe("exact arithmetic (associativity holds)", () => {
    it("sum of partition is exactly parent — the property Float CANNOT satisfy", () => {
      // 100_000 split 5 ways. If this were Float, repeated addition could drift.
      // BigInt: must hold exactly.
      const result = checkSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [
          { amount: 19_999n },
          { amount: 20_001n },
          { amount: 20_000n },
          { amount: 19_998n },
          { amount: 20_002n },
        ],
      })
      expect(result.ok).toBe(true)
      expect(result.splitSum).toBe(100_000n)
    })

    it("very large amounts remain exact (BigInt has no overflow at ledger scale)", () => {
      // 9 trillion sen × 100_000 entries × 1 sen each — silly scenario but
      // demonstrates BigInt's range.
      const big = 9_000_000_000_000n
      const result = checkSplitParity({
        amount: big,
        isSplit: true,
        splitEntries: [{ amount: big - 1n }, { amount: 1n }],
      })
      expect(result.ok).toBe(true)
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
        amount: 100n,
        isSplit: true,
        splitEntries: [{ amount: 60n }, { amount: 40n }],
      })
    ).not.toThrow()
  })

  it("does not throw when isSplit is false", () => {
    expect(() =>
      assertSplitParity({
        amount: 100n,
        isSplit: false,
        splitEntries: [{ amount: 999n }],
      })
    ).not.toThrow()
  })

  it("throws Error with SPLIT_PARITY_VIOLATION prefix on mismatch", () => {
    expect(() =>
      assertSplitParity({
        amount: 100_000n,
        isSplit: true,
        splitEntries: [{ amount: 60_000n }, { amount: 50_000n }],
      })
    ).toThrow(/^SPLIT_PARITY_VIOLATION:/)
  })

  it("error message includes both sums and delta for debuggability", () => {
    const input: ParitySplitInput = {
      amount: 100n,
      isSplit: true,
      splitEntries: [{ amount: 80n }],
    }

    let caught: unknown
    try {
      assertSplitParity(input)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain("100")
    expect(msg).toContain("80")
    expect(msg).toContain("Δ = 20")
    expect(msg).toContain("exact match")
  })
})
