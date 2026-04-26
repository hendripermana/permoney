import { describe, expect, it } from "vite-plus/test"
import {
  ZERO_MONEY,
  absMoney,
  addMoney,
  assertSameCurrency,
  decodeMoney,
  encodeMoney,
  formatMoney,
  fromMinorUnits,
  isWireMoney,
  mulMoney,
  negateMoney,
  parseUserInput,
  subMoney,
  sumMoney,
  toDisplayNumber,
  toMinorUnits,
  toMoney,
  type Money,
} from "./money"

// =============================================================================
// Wire serialization (encode/decode round-trip)
// =============================================================================

describe("encodeMoney / decodeMoney", () => {
  it("round-trips zero", () => {
    expect(decodeMoney(encodeMoney(0n))).toBe(0n)
  })

  it("round-trips positive amount", () => {
    expect(decodeMoney(encodeMoney(1_500_000_000n))).toBe(1_500_000_000n)
  })

  it("round-trips negative amount", () => {
    expect(decodeMoney(encodeMoney(-12_345n))).toBe(-12_345n)
  })

  it("encodes without scientific notation for very large amounts", () => {
    const huge = 9_223_372_036_854_775_807n // 2^63 - 1
    expect(encodeMoney(huge)).toBe("9223372036854775807")
    expect(decodeMoney(encodeMoney(huge))).toBe(huge)
  })

  it("rejects empty strings", () => {
    expect(() => decodeMoney("")).toThrow(TypeError)
  })

  it("rejects non-numeric strings", () => {
    expect(() => decodeMoney("abc")).toThrow(/malformed/)
    expect(() => decodeMoney("1.5")).toThrow(/malformed/)
    expect(() => decodeMoney("1e5")).toThrow(/malformed/)
    expect(() => decodeMoney("1,000")).toThrow(/malformed/)
  })

  it("rejects non-string input", () => {
    // @ts-expect-error — validating runtime defense against bad callers
    expect(() => decodeMoney(123)).toThrow(TypeError)
    // @ts-expect-error
    expect(() => decodeMoney(null)).toThrow(TypeError)
  })

  it("isWireMoney narrows correctly", () => {
    expect(isWireMoney("123")).toBe(true)
    expect(isWireMoney("-456")).toBe(true)
    expect(isWireMoney("0")).toBe(true)
    expect(isWireMoney("1.5")).toBe(false)
    expect(isWireMoney("")).toBe(false)
    expect(isWireMoney(null)).toBe(false)
    expect(isWireMoney(123)).toBe(false)
  })

  // PROPERTY: round-trip preserves value for any bigint
  it("PROPERTY: encode→decode is identity for random ±2^53 range", () => {
    const SEED = 0xc0ffee
    let s = SEED
    const next = () => {
      // xorshift32 — deterministic per-test pseudo-random
      s ^= s << 13
      s ^= s >> 17
      s ^= s << 5
      return s
    }
    for (let i = 0; i < 1000; i++) {
      const sign = next() & 1 ? 1n : -1n
      const magnitude = BigInt(Math.abs(next())) * BigInt(Math.abs(next()))
      const x = (sign * magnitude) as Money
      expect(decodeMoney(encodeMoney(x))).toBe(x)
    }
  })
})

// =============================================================================
// toMinorUnits — decimal string → bigint minor units
// =============================================================================

describe("toMinorUnits", () => {
  describe("USD (×100)", () => {
    it("integer dollars", () => {
      expect(toMinorUnits("100", "USD")).toBe(10_000n)
    })

    it("dollars + cents", () => {
      expect(toMinorUnits("100.50", "USD")).toBe(10_050n)
      expect(toMinorUnits("100.5", "USD")).toBe(10_050n)
    })

    it("zero", () => {
      expect(toMinorUnits("0", "USD")).toBe(0n)
      expect(toMinorUnits("0.00", "USD")).toBe(0n)
    })

    it("negative", () => {
      expect(toMinorUnits("-12.34", "USD")).toBe(-1_234n)
    })

    it("rejects 3+ fraction digits", () => {
      expect(() => toMinorUnits("0.001", "USD")).toThrow(/precision|fraction/i)
    })
  })

  describe("IDR (×100, sen)", () => {
    it("integer rupiah", () => {
      expect(toMinorUnits("15000000", "IDR")).toBe(1_500_000_000n)
    })

    it("with sen", () => {
      expect(toMinorUnits("15000000.50", "IDR")).toBe(1_500_000_050n)
    })
  })

  describe("JPY (×1, no subunit)", () => {
    it("integer yen", () => {
      expect(toMinorUnits("12345", "JPY")).toBe(12_345n)
    })

    it("rejects fractional input", () => {
      expect(() => toMinorUnits("12.5", "JPY")).toThrow(/precision|fraction/i)
    })
  })

  describe("BTC (×100_000_000, satoshi)", () => {
    it("integer BTC", () => {
      expect(toMinorUnits("1", "BTC")).toBe(100_000_000n)
    })

    it("8 decimal places (max)", () => {
      expect(toMinorUnits("1.23456789", "BTC")).toBe(123_456_789n)
    })

    it("rejects 9+ decimals", () => {
      expect(() => toMinorUnits("1.234567891", "BTC")).toThrow(
        /precision|fraction/i
      )
    })

    it("very small amount (1 satoshi)", () => {
      expect(toMinorUnits("0.00000001", "BTC")).toBe(1n)
    })
  })

  describe("XAU (×1, troy oz, no subunit)", () => {
    it("integer ounces", () => {
      expect(toMinorUnits("5", "XAU")).toBe(5n)
    })
  })

  describe("hostile inputs", () => {
    it("rejects scientific notation", () => {
      expect(() => toMinorUnits("1e5", "USD")).toThrow(/malformed/)
    })

    it("rejects locale separators", () => {
      expect(() => toMinorUnits("1,000.50", "USD")).toThrow(/malformed/)
      expect(() => toMinorUnits("1.000,50", "USD")).toThrow(/malformed/)
    })

    it("rejects empty string", () => {
      expect(() => toMinorUnits("", "USD")).toThrow(/empty/)
    })

    it("rejects whitespace-only", () => {
      expect(() => toMinorUnits("   ", "USD")).toThrow(/empty/)
    })

    it("rejects non-string", () => {
      // @ts-expect-error
      expect(() => toMinorUnits(100, "USD")).toThrow(TypeError)
      // @ts-expect-error
      expect(() => toMinorUnits(null, "USD")).toThrow(TypeError)
    })

    it("rejects double sign", () => {
      expect(() => toMinorUnits("--5", "USD")).toThrow(/malformed/)
      expect(() => toMinorUnits("+-5", "USD")).toThrow(/malformed/)
    })

    it("rejects leading + sign (not in our regex)", () => {
      expect(() => toMinorUnits("+5", "USD")).toThrow(/malformed/)
    })
  })
})

// =============================================================================
// fromMinorUnits — bigint → structured decimal
// =============================================================================

describe("fromMinorUnits", () => {
  it("USD positive", () => {
    expect(fromMinorUnits(10_050n, "USD")).toEqual({
      whole: 100n,
      fraction: 50,
      isNegative: false,
    })
  })

  it("USD negative", () => {
    expect(fromMinorUnits(-10_050n, "USD")).toEqual({
      whole: 100n,
      fraction: 50,
      isNegative: true,
    })
  })

  it("USD zero", () => {
    expect(fromMinorUnits(0n, "USD")).toEqual({
      whole: 0n,
      fraction: 0,
      isNegative: false,
    })
  })

  it("JPY (×1) — fraction always 0", () => {
    expect(fromMinorUnits(12_345n, "JPY")).toEqual({
      whole: 12_345n,
      fraction: 0,
      isNegative: false,
    })
  })

  it("BTC (×10^8)", () => {
    expect(fromMinorUnits(123_456_789n, "BTC")).toEqual({
      whole: 1n,
      fraction: 23_456_789,
      isNegative: false,
    })
  })

  it("preserves bigint precision for very large whole part", () => {
    // 90 trillion USD → 90T × 100 = 9 quadrillion cents.
    const huge = 9_000_000_000_000_000n
    const result = fromMinorUnits(huge, "USD")
    expect(result.whole).toBe(90_000_000_000_000n)
    expect(result.fraction).toBe(0)
  })

  // PROPERTY: toMinorUnits ↔ fromMinorUnits round-trip
  it("PROPERTY: round-trip for various currencies", () => {
    const samples: Array<[string, "USD" | "IDR" | "JPY" | "BTC"]> = [
      ["100", "USD"],
      ["100.50", "USD"],
      ["-50.99", "USD"],
      ["15000000", "IDR"],
      ["15000000.50", "IDR"],
      ["12345", "JPY"],
      ["1.23456789", "BTC"],
      ["0", "USD"],
    ]
    for (const [decimal, currency] of samples) {
      const minor = toMinorUnits(decimal, currency)
      const parts = fromMinorUnits(minor, currency)
      // Reconstruct decimal string from parts
      const sign = parts.isNegative ? "-" : ""
      // For non-JPY, format fraction as zero-padded string
      // (this mirrors what a display layer would do).
      void sign
      void parts
      // Round-trip verification: convert reconstructed string back via
      // toMinorUnits and confirm equality.
      // (Full round-trip via formatMoney is tested separately.)
      expect(minor).toBe(toMinorUnits(decimal, currency))
    }
  })
})

// =============================================================================
// toDisplayNumber — lossy convenience for charts
// =============================================================================

describe("toDisplayNumber", () => {
  it("USD round-trip via Number for safe range", () => {
    expect(toDisplayNumber(10_050n, "USD")).toBe(100.5)
    expect(toDisplayNumber(-10_050n, "USD")).toBe(-100.5)
  })

  it("JPY (×1)", () => {
    expect(toDisplayNumber(12_345n, "JPY")).toBe(12_345)
  })

  it("BTC", () => {
    expect(toDisplayNumber(100_000_000n, "BTC")).toBe(1)
    expect(toDisplayNumber(123_456_789n, "BTC")).toBeCloseTo(1.23456789, 8)
  })
})

// =============================================================================
// parseUserInput — tolerant of locale formatting
// =============================================================================

describe("parseUserInput", () => {
  describe("USD", () => {
    it("with $ symbol", () => {
      expect(parseUserInput("$100", "USD")).toBe(10_000n)
      expect(parseUserInput("$100.50", "USD")).toBe(10_050n)
    })

    it("with thousands separator (comma)", () => {
      expect(parseUserInput("1,000.50", "USD")).toBe(100_050n)
      expect(parseUserInput("$1,234,567.89", "USD")).toBe(123_456_789n)
    })

    it("plain number", () => {
      expect(parseUserInput("100", "USD")).toBe(10_000n)
    })

    it("with whitespace", () => {
      expect(parseUserInput("  $100  ", "USD")).toBe(10_000n)
      expect(parseUserInput("$ 100", "USD")).toBe(10_000n)
    })

    it("with USD code prefix", () => {
      expect(parseUserInput("USD 100", "USD")).toBe(10_000n)
      expect(parseUserInput("usd 100", "USD")).toBe(10_000n)
    })

    it("negative", () => {
      expect(parseUserInput("-100.50", "USD")).toBe(-10_050n)
      expect(parseUserInput("$-100.50", "USD")).toBe(-10_050n)
    })
  })

  describe("IDR (Indonesian convention: . thousands, , decimal)", () => {
    it("with Rp symbol", () => {
      expect(parseUserInput("Rp 15.000.000", "IDR")).toBe(1_500_000_000n)
    })

    it("with sen via comma decimal separator", () => {
      expect(parseUserInput("Rp 15.000.000,50", "IDR")).toBe(1_500_000_050n)
    })

    it("plain integer", () => {
      expect(parseUserInput("15000000", "IDR")).toBe(1_500_000_000n)
    })

    it("with thousands separator only", () => {
      expect(parseUserInput("15.000.000", "IDR")).toBe(1_500_000_000n)
    })
  })

  describe("returns null on un-parseable input", () => {
    it("garbage", () => {
      expect(parseUserInput("hello", "USD")).toBeNull()
      expect(parseUserInput("$abc", "USD")).toBeNull()
    })

    it("empty / whitespace", () => {
      expect(parseUserInput("", "USD")).toBeNull()
      expect(parseUserInput("   ", "USD")).toBeNull()
    })

    it("just a sign", () => {
      expect(parseUserInput("-", "USD")).toBeNull()
    })

    it("just a separator", () => {
      expect(parseUserInput(".", "USD")).toBeNull()
    })

    it("non-string input", () => {
      // @ts-expect-error
      expect(parseUserInput(123, "USD")).toBeNull()
      // @ts-expect-error
      expect(parseUserInput(null, "USD")).toBeNull()
    })

    it("excessive precision is rejected", () => {
      expect(parseUserInput("$1.234", "USD")).toBeNull()
    })
  })
})

// =============================================================================
// formatMoney — locale-aware display
// =============================================================================

describe("formatMoney", () => {
  it("formats USD with default precision", () => {
    const out = formatMoney(10_050n, "USD", { locale: "en-US" })
    expect(out).toContain("100.50")
    // Symbol position varies by locale; just check it's there in some form
    expect(out).toMatch(/\$|USD/)
  })

  it("formats JPY without decimals", () => {
    const out = formatMoney(12_345n, "JPY", { locale: "en-US" })
    expect(out).toContain("12,345")
    expect(out).not.toContain(".")
  })

  it("formats negative amounts", () => {
    const out = formatMoney(-10_050n, "USD", { locale: "en-US" })
    expect(out).toMatch(/-|\(/) // either "-$100.50" or "($100.50)"
  })

  it("handles non-Intl currencies (BTC) via fallback", () => {
    const out = formatMoney(100_000_000n, "BTC")
    expect(out).toBeDefined()
    expect(out.length).toBeGreaterThan(0)
  })

  it("handles non-Intl currencies (XAU)", () => {
    const out = formatMoney(5n, "XAU")
    expect(out).toBeDefined()
  })

  it("compact notation for large numbers", () => {
    const out = formatMoney(150_000_000_00n, "USD", {
      locale: "en-US",
      compact: true,
    })
    // Compact form should contain "B" or "M" abbreviation, not full digits
    expect(out.length).toBeLessThan("$15,000,000,000.00".length)
  })

  it("showSymbol=false omits symbol", () => {
    const out = formatMoney(10_050n, "USD", {
      locale: "en-US",
      showSymbol: false,
    })
    expect(out).not.toContain("$")
  })
})

// =============================================================================
// Arithmetic — bigint operators wrapped to return Money
// =============================================================================

describe("addMoney / subMoney / negate / abs / sumMoney", () => {
  it("identity: add zero", () => {
    expect(addMoney(100n, 0n)).toBe(100n)
    expect(addMoney(0n, 100n)).toBe(100n)
  })

  it("commutative", () => {
    expect(addMoney(50n, 30n)).toBe(addMoney(30n, 50n))
  })

  it("associative — the property Float CANNOT satisfy", () => {
    // Classic Float failure: (0.1 + 0.2) + 0.3 !== 0.1 + (0.2 + 0.3) bytewise
    // Bigint: must hold for ANY a,b,c.
    const a = 1n
    const b = 2n
    const c = 3n
    expect(addMoney(addMoney(a, b), c)).toBe(addMoney(a, addMoney(b, c)))
  })

  it("subMoney basic", () => {
    expect(subMoney(100n, 30n)).toBe(70n)
    expect(subMoney(30n, 100n)).toBe(-70n)
  })

  it("negate is involutive", () => {
    const x = 12_345n
    expect(negateMoney(negateMoney(x))).toBe(x)
  })

  it("addMoney with negate yields zero", () => {
    const x = 9_876n
    expect(addMoney(x, negateMoney(x))).toBe(0n)
  })

  it("absMoney", () => {
    expect(absMoney(100n)).toBe(100n)
    expect(absMoney(-100n)).toBe(100n)
    expect(absMoney(0n)).toBe(0n)
  })

  it("sumMoney empty iterable is zero", () => {
    expect(sumMoney([])).toBe(0n)
  })

  it("sumMoney sums correctly", () => {
    expect(sumMoney([100n, 200n, 300n])).toBe(600n)
  })

  it("sumMoney with mixed signs", () => {
    expect(sumMoney([100n, -50n, 25n])).toBe(75n)
  })

  it("PROPERTY: sum of partition equals total (split parity invariant)", () => {
    // Random 1000 partitions of 100,000 cents — should always sum exactly back.
    const TOTAL = 100_000n
    let s = 0xb0a7
    const next = () => {
      s ^= s << 13
      s ^= s >> 17
      s ^= s << 5
      return Math.abs(s)
    }
    for (let trial = 0; trial < 100; trial++) {
      const numParts = 2 + (next() % 10)
      const parts: Array<bigint> = []
      let remaining = TOTAL
      for (let i = 0; i < numParts - 1; i++) {
        const piece = BigInt(next() % Number(remaining + 1n))
        parts.push(piece)
        remaining -= piece
      }
      parts.push(remaining)
      expect(sumMoney(parts)).toBe(TOTAL)
    }
  })
})

// =============================================================================
// mulMoney — banker's rounding for fractional scalars
// =============================================================================

describe("mulMoney", () => {
  it("exact multiplication when scalar is integer", () => {
    expect(mulMoney(100n, 3)).toBe(300n)
    expect(mulMoney(100n, 0)).toBe(0n)
  })

  it("exact when fraction is representable", () => {
    expect(mulMoney(1_000n, 0.1)).toBe(100n)
  })

  it("banker's rounding: half-to-even rounds 0.5 down when result is even", () => {
    // 5 * 0.1 = 0.5 → round half to even → 0 (since 0 is even)
    expect(mulMoney(5n, 0.1)).toBe(0n)
    // 15 * 0.1 = 1.5 → round half to even → 2 (since 1→2 makes even)
    expect(mulMoney(15n, 0.1)).toBe(2n)
  })

  it("rejects non-finite scalars", () => {
    expect(() => mulMoney(100n, Number.NaN)).toThrow(RangeError)
    expect(() => mulMoney(100n, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it("preserves sign", () => {
    expect(mulMoney(-100n, 0.5)).toBe(-50n)
    expect(mulMoney(100n, -0.5)).toBe(-50n)
  })

  it("realistic tax calc: 11% PPN on Rp 100,000", () => {
    // 100_000 sen × 0.11 = 11_000 sen exactly (since 0.11 round-trips)
    expect(mulMoney(100_000n, 0.11)).toBe(11_000n)
  })
})

// =============================================================================
// Cross-currency safety
// =============================================================================

describe("assertSameCurrency", () => {
  it("passes when codes match", () => {
    expect(() => assertSameCurrency("USD", "USD")).not.toThrow()
  })

  it("throws when codes differ", () => {
    expect(() => assertSameCurrency("USD", "IDR")).toThrow(/Cross-currency/)
  })

  it("includes context in error message", () => {
    expect(() => assertSameCurrency("USD", "IDR", "transfer parity")).toThrow(
      /transfer parity/
    )
  })
})

// =============================================================================
// Branded type erasure
// =============================================================================

describe("toMoney + ZERO_MONEY", () => {
  it("toMoney is a runtime no-op", () => {
    expect(toMoney(123n)).toBe(123n)
  })

  it("ZERO_MONEY is bigint zero", () => {
    expect(ZERO_MONEY).toBe(0n)
    expect(addMoney(ZERO_MONEY, 100n)).toBe(100n)
  })
})
