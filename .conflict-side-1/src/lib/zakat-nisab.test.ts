import { describe, expect, test } from "vite-plus/test"
import {
  computeNisabValue,
  computeZakatDue,
  divRoundHalfEven,
  GOLD_NISAB_GRAMS_SCALED,
  SILVER_NISAB_GRAMS_SCALED,
} from "./zakat-nisab"

describe("zakat-nisab", () => {
  describe("divRoundHalfEven", () => {
    test("rounds down below half", () => {
      // 9 / 4 = 2.25 -> remainder 1/4 < half -> rounds down to 2.
      expect(divRoundHalfEven(9n, 4n)).toBe(2n)
    })

    test("rounds exact half to the even neighbor", () => {
      // 5 / 2 = 2.5 -> rounds to 2 (even)
      expect(divRoundHalfEven(5n, 2n)).toBe(2n)
      // 7 / 2 = 3.5 -> rounds to 4 (even)
      expect(divRoundHalfEven(7n, 2n)).toBe(4n)
    })

    test("exact division has no rounding", () => {
      expect(divRoundHalfEven(100n, 10n)).toBe(10n)
    })

    test("handles negative numerators symmetrically", () => {
      expect(divRoundHalfEven(-5n, 2n)).toBe(-2n)
    })
  })

  describe("computeNisabValue", () => {
    test("gold nisab = 87.48 grams exactly (not the popular 85g rounding)", () => {
      expect(GOLD_NISAB_GRAMS_SCALED).toBe(8748n)
      const pricePerGram = 1_000_000n // Rp 1,000,000/gram, minor units (sen)
      // 87.48 * 1_000_000 = 87,480,000
      expect(computeNisabValue("gold", pricePerGram)).toBe(87_480_000n)
    })

    test("silver nisab = 612.36 grams exactly", () => {
      expect(SILVER_NISAB_GRAMS_SCALED).toBe(61236n)
      const pricePerGram = 20_000n
      // 612.36 * 20_000 = 12,247,200
      expect(computeNisabValue("silver", pricePerGram)).toBe(12_247_200n)
    })

    test("gold nisab value is much larger than silver's at realistic relative prices", () => {
      // Gold trades roughly 60-90x silver's price per gram; even at a
      // conservative 50x, gold's nisab value should exceed silver's, which
      // is exactly why Hanafi's silver-basis is "more precautionary".
      const goldPricePerGram = 1_500_000n
      const silverPricePerGram = 20_000n
      const goldNisab = computeNisabValue("gold", goldPricePerGram)
      const silverNisab = computeNisabValue("silver", silverPricePerGram)
      expect(goldNisab).toBeGreaterThan(silverNisab)
    })

    test("throws on a non-positive price rather than silently returning 0", () => {
      expect(() => computeNisabValue("gold", 0n)).toThrow()
      expect(() => computeNisabValue("gold", -1n)).toThrow()
    })

    test("exact for a price with fractional-minor-unit rounding pressure", () => {
      // 3 * 8748 = 26244, /100 = 262.44 -> rounds to 262 (round-half-even,
      // remainder 44/100 < half).
      expect(computeNisabValue("gold", 3n)).toBe(262n)
    })
  })

  describe("computeZakatDue", () => {
    test("is exactly 2.5% of net wealth", () => {
      expect(computeZakatDue(100_000_000n)).toBe(2_500_000n)
    })

    test("is 0 for non-positive wealth", () => {
      expect(computeZakatDue(0n)).toBe(0n)
      expect(computeZakatDue(-100n)).toBe(0n)
    })

    test("rounds half-to-even on the 1/40 division", () => {
      // 20 / 40 = 0.5 -> rounds to 0 (even)
      expect(computeZakatDue(20n)).toBe(0n)
      // 60 / 40 = 1.5 -> rounds to 2 (even)
      expect(computeZakatDue(60n)).toBe(2n)
    })
  })
})
