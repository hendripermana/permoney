import { describe, expect, it } from "vite-plus/test"
import { toMoney } from "./money"
import {
  IDENTITY_RATE,
  RATE_SCALE,
  convertMinor,
  decodeRate,
  deriveTransferFx,
  encodeRate,
  impliedRateScaled,
} from "./fx"

describe("RATE_SCALE / IDENTITY_RATE", () => {
  it("uses a fixed 1e12 scale", () => {
    expect(RATE_SCALE).toBe(1_000_000_000_000n)
    expect(IDENTITY_RATE).toBe(RATE_SCALE)
  })
})

describe("encodeRate / decodeRate", () => {
  it("round-trips a large integer-ish rate (USD->IDR)", () => {
    const r = encodeRate("16250.75")
    expect(r).toBe(16_250_750_000_000_000n) // 16250.75 * 1e12
    expect(decodeRate(r)).toBe("16250.75")
  })

  it("keeps ~8 significant figures for a tiny rate (IDR->USD)", () => {
    const r = encodeRate("0.0000615")
    expect(r).toBe(61_500_000n) // 0.0000615 * 1e12
    expect(decodeRate(r)).toBe("0.0000615")
  })

  it("decodes an integer rate without a trailing dot", () => {
    expect(decodeRate(encodeRate("16250"))).toBe("16250")
  })

  it("banker's-rounds excess precision to 12 dp", () => {
    // 13th fraction digit forces a round-half-to-even at the 12th.
    expect(encodeRate("1.0000000000005")).toBe(1_000_000_000_000n) // ...0 even
    expect(encodeRate("1.0000000000015")).toBe(1_000_000_000_002n) // ...2 even
  })

  it("rejects malformed rate strings and non-positive rates", () => {
    expect(() => encodeRate("")).toThrow()
    expect(() => encodeRate("1e5")).toThrow()
    expect(() => encodeRate("-1")).toThrow()
    expect(() => encodeRate("0")).toThrow()
  })
})

describe("convertMinor", () => {
  it("is identity when rate is 1e12 and currencies match", () => {
    expect(convertMinor(toMoney(123_45n), "USD", "USD", IDENTITY_RATE)).toBe(
      123_45n
    )
  })

  it("converts USD cents -> IDR sen (same minor scale)", () => {
    // $100.00 = 10_000 cents, rate 16250 -> Rp 1,625,000.00 = 162_500_000 sen
    expect(
      convertMinor(toMoney(10_000n), "USD", "IDR", encodeRate("16250"))
    ).toBe(162_500_000n)
  })

  it("converts across mismatched minor scales (XAU oz -> IDR sen)", () => {
    // 1 XAU (minor=1, conv=1) at 50,000,000 IDR/oz -> Rp 50,000,000.00 = 5e9 sen
    expect(
      convertMinor(toMoney(1n), "XAU", "IDR", encodeRate("50000000"))
    ).toBe(5_000_000_000n)
  })

  it("converts BTC satoshi -> USD cents", () => {
    // 0.5 BTC = 50,000,000 sat (conv 1e8) at 60000 USD/BTC -> $30,000.00 = 3,000,000 cents
    expect(
      convertMinor(toMoney(50_000_000n), "BTC", "USD", encodeRate("60000"))
    ).toBe(3_000_000n)
  })

  it("converts IDR sen -> USD cents with a tiny rate", () => {
    // Rp 1,000,000.00 = 100,000,000 sen at 0.0000615 -> $61.50 = 6150 cents
    expect(
      convertMinor(toMoney(100_000_000n), "IDR", "USD", encodeRate("0.0000615"))
    ).toBe(6_150n)
  })

  it("preserves sign for outflow (negative) amounts", () => {
    expect(
      convertMinor(toMoney(-10_000n), "USD", "IDR", encodeRate("16250"))
    ).toBe(-162_500_000n)
  })

  it("uses banker's rounding (round half to even) on fractional minor results", () => {
    // Same-scale (USD->IDR, both conv 100): result minor == actualRate.
    expect(convertMinor(toMoney(1n), "USD", "IDR", encodeRate("2.5"))).toBe(2n) // -> even 2
    expect(convertMinor(toMoney(1n), "USD", "IDR", encodeRate("3.5"))).toBe(4n) // -> even 4
    expect(convertMinor(toMoney(-1n), "USD", "IDR", encodeRate("2.5"))).toBe(
      -2n
    )
  })
})

describe("impliedRateScaled", () => {
  it("derives the source->dest rate from two native leg amounts", () => {
    // 100 USD (10_000c) -> 1,625,000 IDR (162_500_000 sen) implies 16250.
    expect(
      impliedRateScaled(toMoney(10_000n), "USD", toMoney(162_500_000n), "IDR")
    ).toBe(encodeRate("16250"))
  })

  it("round-trips through convertMinor within 1 minor unit", () => {
    const src = toMoney(7_733n) // $77.33
    const dst = toMoney(125_661_250n) // Rp 1,256,612.50
    const rate = impliedRateScaled(src, "USD", dst, "IDR")
    const reproduced = convertMinor(src, "USD", "IDR", rate)
    const diff = reproduced - dst
    expect(diff <= 1n && diff >= -1n).toBe(true)
  })
})

describe("deriveTransferFx", () => {
  it("returns null fields for a same-currency transfer", () => {
    expect(
      deriveTransferFx(toMoney(-5_000n), "IDR", toMoney(5_000n), "IDR")
    ).toEqual({
      fxRateScaled: null,
      fromCurrency: null,
      toCurrency: null,
    })
  })

  it("records the implied source->dest rate for a cross-currency transfer", () => {
    expect(
      deriveTransferFx(toMoney(-10_000n), "USD", toMoney(162_500_000n), "IDR")
    ).toEqual({
      fxRateScaled: encodeRate("16250"),
      fromCurrency: "USD",
      toCurrency: "IDR",
    })
  })
})
