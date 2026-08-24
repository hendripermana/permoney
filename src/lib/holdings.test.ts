import fc from "fast-check"
import { describe, expect, test } from "vite-plus/test"
import {
  averageUnitCostMinor,
  holdingCostMinor,
  holdingGainMinor,
  holdingReturnPct,
  holdingValueMinor,
  QUANTITY_SCALE,
  quantityToScaled,
  scaledToQuantityString,
  sumHoldingValuesMinor,
  unitsFromAmountScaled,
} from "./holdings"

describe("quantityToScaled", () => {
  test("scales a fractional decimal to 1e8", () => {
    expect(quantityToScaled("2.0180")).toBe(201_800_000n)
    expect(quantityToScaled("1353.5149")).toBe(135_351_490_000n)
  })

  test("integer and zero quantities", () => {
    expect(quantityToScaled("5")).toBe(500_000_000n)
    expect(quantityToScaled("0")).toBe(0n)
    expect(quantityToScaled("0.00000001")).toBe(1n) // full 8-digit precision
  })

  test("trims surrounding whitespace", () => {
    expect(quantityToScaled("  2.5 ")).toBe(250_000_000n)
  })

  test("rejects negative, NaN-shaped, exponent, separator and over-precise input", () => {
    expect(() => quantityToScaled("-1")).toThrow()
    expect(() => quantityToScaled("")).toThrow()
    expect(() => quantityToScaled("abc")).toThrow()
    expect(() => quantityToScaled("1e5")).toThrow()
    expect(() => quantityToScaled("1,000")).toThrow()
    expect(() => quantityToScaled("1.2.3")).toThrow()
    expect(() => quantityToScaled("0.000000001")).toThrow() // 9 fraction digits
  })
})

describe("holdingValueMinor / holdingCostMinor (half-up rounding)", () => {
  test("BSI Gold worked example (ADR-0051): value", () => {
    // 2.0180 gram × Rp 2,455,000/gram (245_500_000 sen) = Rp 4,954,190.
    const qty = quantityToScaled("2.0180")
    expect(holdingValueMinor(qty, 245_500_000n)).toBe(495_419_000n)
  })

  test("BSI Gold worked example (ADR-0051): cost", () => {
    // 2.0180 gram × Rp 2,760,809/gram (276_080_900 sen) = Rp 5,571,312.56 →
    // 557,131,256 sen (half-up on the exact .56 boundary is a no-op here, the
    // fractional part is below .5 of a sen — the value is already integral sen).
    const qty = quantityToScaled("2.0180")
    expect(holdingCostMinor(qty, 276_080_900n)).toBe(557_131_256n)
  })

  test("zero quantity → zero value and zero cost", () => {
    expect(holdingValueMinor(0n, 245_500_000n)).toBe(0n)
    expect(holdingCostMinor(0n, 276_080_900n)).toBe(0n)
  })

  test("zero price → zero value", () => {
    expect(holdingValueMinor(quantityToScaled("2.0180"), 0n)).toBe(0n)
  })

  test("half-up rounds a genuine half-sen up", () => {
    // quantityScaled × price = QUANTITY_SCALE/2 + k*QUANTITY_SCALE produces an
    // exact .5 remainder. 0.5 units × 1 minor = 0.5 minor → rounds to 1.
    const halfUnit = QUANTITY_SCALE / 2n // 0.5 scaled
    expect(holdingValueMinor(halfUnit, 1n)).toBe(1n)
    // 0.5 units × 3 minor = 1.5 minor → rounds to 2.
    expect(holdingValueMinor(halfUnit, 3n)).toBe(2n)
  })

  test("rounds just below a half down", () => {
    // (QUANTITY_SCALE/2 - 1) × 1 = 0.4999… → rounds to 0.
    expect(holdingValueMinor(QUANTITY_SCALE / 2n - 1n, 1n)).toBe(0n)
  })

  test("rejects negative operands (defence in depth against a bad caller)", () => {
    expect(() => holdingValueMinor(-1n, 1n)).toThrow()
    expect(() => holdingValueMinor(1n, -1n)).toThrow()
    expect(() => holdingCostMinor(-1n, 1n)).toThrow()
  })
})

describe("gain and return", () => {
  test("gain = value − cost, both signs", () => {
    expect(holdingGainMinor(495_419_000n, 557_131_256n)).toBe(-61_712_256n)
    expect(holdingGainMinor(600_000_000n, 557_131_256n)).toBe(42_868_744n)
  })

  test("return pct is the ratio, null when cost is 0", () => {
    // Bibit example: value 200,837,000 cost 200,000,000 → +0.42% (0.004185).
    expect(holdingReturnPct(200_837_000n, 200_000_000n)).toBeCloseTo(0.0042, 4)
    expect(holdingReturnPct(100n, 0n)).toBeNull()
    expect(holdingReturnPct(0n, 0n)).toBeNull()
  })
})

describe("sumHoldingValuesMinor", () => {
  test("sums per-holding value (account value = Σ holdings)", () => {
    const total = sumHoldingValuesMinor([
      {
        quantityScaled: quantityToScaled("2.0180"),
        pricePerUnitMinor: 245_500_000n,
      },
      { quantityScaled: quantityToScaled("10"), pricePerUnitMinor: 1_000n },
    ])
    expect(total).toBe(495_419_000n + 10_000n)
  })

  test("empty portfolio is 0", () => {
    expect(sumHoldingValuesMinor([])).toBe(0n)
  })
})

// ===========================================================================
// Property-based invariants (fast-check). Thousands of qty/price combinations.
// ===========================================================================

describe("valuation invariants (property-based)", () => {
  const qtyArb = fc.bigInt({ min: 0n, max: 10n ** 18n }) // scaled quantity
  const priceArb = fc.bigInt({ min: 0n, max: 10n ** 15n }) // minor units/unit

  test("value is non-negative and never NaN", () => {
    fc.assert(
      fc.property(qtyArb, priceArb, (qty, price) => {
        const value = holdingValueMinor(qty, price)
        expect(value >= 0n).toBe(true)
        expect(typeof value).toBe("bigint")
      })
    )
  })

  test("value is monotonic non-decreasing in quantity", () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, priceArb, (a, b, price) => {
        const lo = a < b ? a : b
        const hi = a < b ? b : a
        expect(
          holdingValueMinor(lo, price) <= holdingValueMinor(hi, price)
        ).toBe(true)
      })
    )
  })

  test("value is monotonic non-decreasing in price", () => {
    fc.assert(
      fc.property(qtyArb, priceArb, priceArb, (qty, p1, p2) => {
        const lo = p1 < p2 ? p1 : p2
        const hi = p1 < p2 ? p2 : p1
        expect(holdingValueMinor(qty, lo) <= holdingValueMinor(qty, hi)).toBe(
          true
        )
      })
    )
  })

  test("Σ of per-holding values equals the account-value helper", () => {
    const holdingArb = fc.record({
      quantityScaled: qtyArb,
      pricePerUnitMinor: priceArb,
    })
    fc.assert(
      fc.property(fc.array(holdingArb, { maxLength: 20 }), (holdings) => {
        const manual = holdings.reduce(
          (acc, h) =>
            acc + holdingValueMinor(h.quantityScaled, h.pricePerUnitMinor),
          0n
        )
        expect(sumHoldingValuesMinor(holdings)).toBe(manual)
      })
    )
  })

  test("gain never NaN and returnPct is null exactly when cost is 0", () => {
    fc.assert(
      fc.property(qtyArb, priceArb, priceArb, (qty, price, cost) => {
        const value = holdingValueMinor(qty, price)
        const costMinor = holdingCostMinor(qty, cost)
        const gain = holdingGainMinor(value, costMinor)
        expect(typeof gain).toBe("bigint")
        expect(gain).toBe(value - costMinor)
        const pct = holdingReturnPct(value, costMinor)
        if (costMinor <= 0n) {
          expect(pct).toBeNull()
        } else {
          expect(Number.isNaN(pct)).toBe(false)
        }
      })
    )
  })

  test("quantityToScaled round-trips through the 8-digit scale", () => {
    const wholeArb = fc.nat({ max: 1_000_000 })
    const fracArb = fc.stringMatching(/^[0-9]{0,8}$/)
    fc.assert(
      fc.property(wholeArb, fracArb, (whole, frac) => {
        const decimal = frac === "" ? `${whole}` : `${whole}.${frac}`
        const scaled = quantityToScaled(decimal)
        // padEnd always yields 8 chars ("" -> "00000000" -> 0n), so no guard.
        const expected =
          BigInt(whole) * QUANTITY_SCALE + BigInt(frac.padEnd(8, "0"))
        expect(scaled).toBe(expected)
      })
    )
  })
})

describe("averageUnitCostMinor (PER-198 trade cost blend)", () => {
  test("inverts holdingCostMinor for exact divisions", () => {
    // 200 units, total cost 3,000,000 → 15,000/unit.
    const units = quantityToScaled("200")
    const avg = averageUnitCostMinor(3_000_000n, units)
    expect(avg).toBe(15_000n)
    expect(holdingCostMinor(units, avg)).toBe(3_000_000n)
  })

  test("blends two buys to the weighted average", () => {
    // 100 @ 10,000 then 100 @ 20,000 → 200 units, cost 3,000,000, avg 15,000.
    const units = quantityToScaled("100") + quantityToScaled("100")
    expect(averageUnitCostMinor(1_000_000n + 2_000_000n, units)).toBe(15_000n)
  })

  test("rounds half-up and rejects non-positive units", () => {
    // 3 units, cost 1,000 → 333.33/unit → 333 (rounds to nearest sen).
    expect(averageUnitCostMinor(1_000n, quantityToScaled("3"))).toBe(333n)
    expect(() => averageUnitCostMinor(1_000n, 0n)).toThrow()
    expect(() => averageUnitCostMinor(-1n, quantityToScaled("1"))).toThrow()
  })
})

describe("scaledToQuantityString", () => {
  test("renders the canonical fixed-scale decimal string", () => {
    expect(scaledToQuantityString(quantityToScaled("100"))).toBe("100.00000000")
    expect(scaledToQuantityString(quantityToScaled("2.018"))).toBe("2.01800000")
    expect(scaledToQuantityString(0n)).toBe("0.00000000")
    expect(scaledToQuantityString(1n)).toBe("0.00000001")
  })

  test("round-trips with quantityToScaled", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (scaled) => {
        expect(quantityToScaled(scaledToQuantityString(scaled))).toBe(scaled)
      })
    )
  })

  test("rejects a negative scaled quantity", () => {
    expect(() => scaledToQuantityString(-1n)).toThrow()
  })
})

describe("unitsFromAmountScaled (amount-driven trade entry)", () => {
  test("inverts holdingCostMinor for exact divisions", () => {
    // Invest Rp 500,000 at Rp 12,000/unit → 41.66666667 units.
    const units = unitsFromAmountScaled(50_000_000n, 1_200_000n)
    expect(scaledToQuantityString(units)).toBe("41.66666667")

    // Exact division: Rp 2,000,000 at Rp 500,000/unit → exactly 4 units.
    expect(unitsFromAmountScaled(200_000_000n, 50_000_000n)).toBe(
      quantityToScaled("4")
    )
  })

  test("rounds HALF-UP at the 1e-8 column scale", () => {
    // amount 1, price 3 → 0.33333333... units → 33333333n (rounds down).
    expect(unitsFromAmountScaled(1n, 3n)).toBe(33_333_333n)
    // amount 2, price 3 → 0.66666666... units → 66666667n (rounds up).
    expect(unitsFromAmountScaled(2n, 3n)).toBe(66_666_667n)
    // Exact .5 tick: amount 1, price 2e8 → 0.005 of a tick... use a clean case:
    // amount 3, price 2 → 1.5 units exactly, no rounding needed.
    expect(unitsFromAmountScaled(3n, 2n)).toBe(150_000_000n)
  })

  test("zero amount yields zero units", () => {
    expect(unitsFromAmountScaled(0n, 1_200_000n)).toBe(0n)
  })

  test("rejects a negative amount or a non-positive price", () => {
    expect(() => unitsFromAmountScaled(-1n, 100n)).toThrow(RangeError)
    expect(() => unitsFromAmountScaled(100n, 0n)).toThrow(RangeError)
    expect(() => unitsFromAmountScaled(100n, -5n)).toThrow(RangeError)
  })

  test("the derived quantity re-values back to the typed amount within the rounding bound", () => {
    // The invariant that makes amount-driven entry safe: the AMOUNT stays
    // authoritative for cash, and the derived quantity — re-multiplied by the
    // same unit price — lands back on it up to two stacked half-up roundings:
    //
    //   |units·P/S − A| ≤ ½ tick-value = P / 2S     (deriving the units)
    //   |revalued − units·P/S| ≤ ½ minor unit        (re-valuing them)
    //   ⇒ drift ≤ ½ + P/2S,  i.e.  2·S·drift ≤ S + P
    //
    // Anything larger would mean the previewed position silently disagrees
    // with the cash moved by more than the representation allows.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (amountMinor, unitPriceMinor) => {
          const units = unitsFromAmountScaled(amountMinor, unitPriceMinor)
          const revalued = holdingCostMinor(units, unitPriceMinor)
          const drift =
            revalued > amountMinor
              ? revalued - amountMinor
              : amountMinor - revalued
          expect(
            2n * QUANTITY_SCALE * drift <= QUANTITY_SCALE + unitPriceMinor
          ).toBe(true)
        }
      )
    )
  })

  test("at any realistic per-unit price the drift is at most one minor unit", () => {
    // A unit tick (1e-8 of a unit) is worth less than one minor unit whenever
    // the price per unit is below QUANTITY_SCALE minor units — Rp 1,000,000 per
    // unit/gram/share. Every reksadana NAV and share price sits far below that,
    // so the practical drift collapses to the single-minor-unit case. (Above
    // that line — e.g. gold quoted per KILO — the bound above still holds, it
    // just widens by one sen per Rp 2,000,000 of unit price.)
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.bigInt({ min: 1n, max: QUANTITY_SCALE }),
        (amountMinor, unitPriceMinor) => {
          const units = unitsFromAmountScaled(amountMinor, unitPriceMinor)
          const revalued = holdingCostMinor(units, unitPriceMinor)
          const drift =
            revalued > amountMinor
              ? revalued - amountMinor
              : amountMinor - revalued
          expect(drift <= 1n).toBe(true)
        }
      )
    )
  })
})
