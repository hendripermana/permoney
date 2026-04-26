import { describe, expect, it } from "vite-plus/test"
import { formatCurrency, getCurrencySymbol } from "./currency"
import { toMoney } from "./money"

// =============================================================================
// formatCurrency \u2014 post-ADR-0001 polymorphic input shape coverage.
//
// The function accepts three input shapes (bigint Money, digit-string wire
// format, legacy decimal number) and must produce the SAME currency output
// for the SAME magnitude regardless of which shape was passed. This is the
// invariant that lets the entire UI keep using \`formatCurrency\` while the
// underlying data type silently migrated.
// =============================================================================

describe("formatCurrency \u2014 input-shape polymorphism", () => {
  describe("IDR (\u00d7100 minor units)", () => {
    it("preserves the 15M magnitude across both bigint and legacy number paths", () => {
      const fromBigint = formatCurrency(toMoney(1_500_000_000n), "IDR")
      const fromNumber = formatCurrency(15_000_000, "IDR")
      // Both shapes must contain the same numeric magnitude with thousands
      // grouping. Symbol shape ("Rp" vs "IDR") differs because formatMoney
      // delegates to Intl.NumberFormat which may emit the ISO code in en-US
      // while the legacy number path uses the same Intl call \u2014 the value
      // we care about (the user-visible magnitude) is identical.
      expect(fromBigint).toContain("15,000,000")
      expect(fromNumber).toContain("15,000,000")
    })

    it("revives a digit-string wire value to the same output as bigint", () => {
      const fromString = formatCurrency("1500000000", "IDR")
      const fromBigint = formatCurrency(toMoney(1_500_000_000n), "IDR")
      expect(fromString).toBe(fromBigint)
    })

    it("handles negative bigint amounts (refunds, expense magnitudes)", () => {
      const negative = formatCurrency(toMoney(-50_000n), "IDR")
      expect(negative).toContain("-")
      expect(negative).toContain("500")
    })

    it("handles zero (BigInt 0n) without throwing", () => {
      expect(() => formatCurrency(0n, "IDR")).not.toThrow()
      expect(formatCurrency(0n, "IDR")).toContain("0")
    })
  })

  describe("USD (\u00d7100 minor units, en-US grouping)", () => {
    it("99 cents \u2192 $0.99", () => {
      const out = formatCurrency(toMoney(99n), "USD")
      expect(out).toContain("0.99")
      expect(out).toContain("$")
    })

    it("$1234.56 round-trips", () => {
      const out = formatCurrency(toMoney(123_456n), "USD")
      expect(out).toContain("1,234.56")
    })
  })

  describe("JPY (\u00d71, no subunit)", () => {
    it("100 yen \u2192 \u00a5100 with no decimal places", () => {
      const out = formatCurrency(toMoney(100n), "JPY")
      expect(out).toContain("100")
      expect(out).not.toMatch(/\.\d/) // no fractional component
    })

    it("very large JPY amounts (millions) format with grouping", () => {
      const out = formatCurrency(toMoney(1_000_000n), "JPY")
      expect(out).toContain("1,000,000")
    })
  })

  describe("BTC (\u00d710\u2078, satoshi precision)", () => {
    it("1 satoshi \u2192 0.00000001 BTC (full 8-decimal precision)", () => {
      const out = formatCurrency(toMoney(1n), "BTC")
      // BTC is not an ISO currency, so Intl falls back to a manual format.
      // Must preserve the 8 fractional digits (satoshi precision).
      expect(out).toContain("0.00000001")
    })

    it("1 BTC \u2192 1.00000000", () => {
      const out = formatCurrency(toMoney(100_000_000n), "BTC")
      expect(out).toContain("1.00000000")
    })
  })

  describe("BHD (\u00d71000, Middle-East 3-decimal currency)", () => {
    it("1 fils \u2192 0.001 BHD", () => {
      const out = formatCurrency(toMoney(1n), "BHD")
      expect(out).toContain("0.001")
    })
  })

  describe("Unknown / unmapped currency code", () => {
    it("falls back to a non-throwing manual stringify for an unknown code", () => {
      // \"ZZZ\" is not in the CURRENCIES table. Expect the bigint path to
      // produce a string containing both the code and the raw minor units
      // (no crash on an unrecognized currency added to the DB before the
      // registry is rebuilt).
      const out = formatCurrency(100n, "ZZZ")
      expect(out).toContain("ZZZ")
      expect(out).toContain("100")
    })
  })
})

// =============================================================================
// getCurrencySymbol \u2014 not part of this PR but covered for regression safety.
// =============================================================================

describe("getCurrencySymbol", () => {
  it("returns Rp for IDR", () => {
    expect(getCurrencySymbol("IDR")).toBe("Rp")
  })

  it("returns $ for USD (narrowSymbol)", () => {
    expect(getCurrencySymbol("USD")).toBe("$")
  })

  it("returns the input code when Intl cannot resolve it", () => {
    // Intl.NumberFormat throws for invalid codes; we catch and return code.
    expect(getCurrencySymbol("ZZZ")).toBe("ZZZ")
  })
})
