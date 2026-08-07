import { describe, expect, test } from "vite-plus/test"
import { encodeRate } from "./fx"
import {
  decodeSpotPrice,
  encodePriceForKind,
  encodeSpotPrice,
  FX_PRICE_DECIMALS,
  isMarketInstrumentKind,
  MARKET_INSTRUMENT_KINDS,
  marketQuoteToHoldingPriceMinor,
  normalizeObservations,
  priceScaleForKind,
  SPOT_PRICE_DECIMALS,
  SPOT_PRICE_SCALE,
  spotPriceScaledPerGram,
  type MarketObservation,
} from "./market-data"

const AS_OF = new Date("2026-08-07T00:00:00.000Z")

describe("market-data price-scale encoding", () => {
  test("spot price scales by 1e8 with exact whole and fractional values", () => {
    expect(encodeSpotPrice("2400.53")).toBe(240_053_000_000n)
    expect(encodeSpotPrice("27")).toBe(2_700_000_000n)
    // Crypto-grade precision (8 dp) is preserved exactly.
    expect(encodeSpotPrice("67000.12345678")).toBe(6_700_012_345_678n)
    expect(SPOT_PRICE_SCALE).toBe(100_000_000n)
    expect(SPOT_PRICE_DECIMALS).toBe(8)
  })

  test("spot price rounds half-to-even beyond 8 fraction digits", () => {
    // A trailing exact-half rounds to the nearest EVEN 8th digit (banker's).
    expect(encodeSpotPrice("1.000000005")).toBe(100_000_000n) // 0 is even -> stays
    expect(encodeSpotPrice("1.000000015")).toBe(100_000_002n) // 1 is odd  -> up
    expect(encodeSpotPrice("1.000000025")).toBe(100_000_002n) // 2 is even -> stays
    expect(encodeSpotPrice("1.000000006")).toBe(100_000_001n) // >half     -> up
  })

  test("decodeSpotPrice is the inverse for representable values", () => {
    expect(decodeSpotPrice(encodeSpotPrice("2400.53"))).toBe("2400.53")
    expect(decodeSpotPrice(encodeSpotPrice("27"))).toBe("27")
    expect(decodeSpotPrice(encodeSpotPrice("0.00000001"))).toBe("0.00000001")
  })

  test("rejects malformed, zero, and non-positive prices", () => {
    expect(() => encodeSpotPrice("abc")).toThrow()
    expect(() => encodeSpotPrice("-5")).toThrow()
    expect(() => encodeSpotPrice("0")).toThrow()
    expect(() => encodeSpotPrice("0.0")).toThrow()
  })

  test("encodePriceForKind: fx reuses the 1e12 Rate encoding, spot uses 1e8", () => {
    expect(encodePriceForKind("fx", "16250.75")).toEqual({
      price: encodeRate("16250.75"),
      priceScale: FX_PRICE_DECIMALS,
    })
    expect(encodePriceForKind("metal", "2400.53")).toEqual({
      price: 240_053_000_000n,
      priceScale: SPOT_PRICE_DECIMALS,
    })
    expect(priceScaleForKind("fx")).toBe(12)
    expect(priceScaleForKind("crypto")).toBe(8)
  })
})

describe("metal unit convention (per troy ounce -> per gram)", () => {
  test("derives per-gram from a canonical per-ounce quote at the same scale", () => {
    // XAU $2400.53/oz -> per gram = 2400.53 / 31.1034768 = 77.18517... USD/g.
    const perOunce = encodeSpotPrice("2400.53")
    const perGram = spotPriceScaledPerGram(perOunce)
    // 2400.53 / 31.1034768 = 77.17883166... USD/g, at the same 1e8 scale.
    expect(perGram).toBe(7_717_883_166n)
    expect(decodeSpotPrice(perGram)).toBe("77.17883166")
  })

  test("rejects a non-positive ounce price", () => {
    expect(() => spotPriceScaledPerGram(0n)).toThrow()
  })
})

describe("market instrument kind guard", () => {
  test("accepts the four kinds and rejects others", () => {
    for (const kind of MARKET_INSTRUMENT_KINDS) {
      expect(isMarketInstrumentKind(kind)).toBe(true)
    }
    expect(isMarketInstrumentKind("bond")).toBe(false)
    expect(isMarketInstrumentKind("")).toBe(false)
  })
})

describe("normalizeObservations", () => {
  const fxObs: MarketObservation = {
    kind: "fx",
    symbol: "USD/IDR",
    baseCurrency: "USD",
    quoteCurrency: "IDR",
    asOf: AS_OF,
    priceDecimal: "16250.75",
    providerRef: "fx-1",
  }

  test("encodes valid observations by kind", () => {
    const result = normalizeObservations([
      fxObs,
      {
        kind: "metal",
        symbol: "XAU",
        quoteCurrency: "USD",
        asOf: AS_OF,
        priceDecimal: "2400.53",
      },
    ])
    expect(result.rejected).toEqual([])
    expect(result.quotes).toHaveLength(2)
    const fx = result.quotes.find((q) => q.identity.kind === "fx")
    expect(fx?.price).toBe(encodeRate("16250.75"))
    expect(fx?.priceScale).toBe(12)
    expect(fx?.identity.baseCurrency).toBe("USD")
    const metal = result.quotes.find((q) => q.identity.kind === "metal")
    expect(metal?.priceScale).toBe(8)
    expect(metal?.identity.baseCurrency).toBeNull()
  })

  test("dedups within a fetch by (identity, asOf) — last wins", () => {
    const result = normalizeObservations([
      { ...fxObs, priceDecimal: "16000" },
      { ...fxObs, priceDecimal: "16250.75" },
    ])
    expect(result.quotes).toHaveLength(1)
    expect(result.quotes[0]?.price).toBe(encodeRate("16250.75"))
  })

  test("keeps distinct asOf as separate quotes", () => {
    const later = new Date("2026-08-08T00:00:00.000Z")
    const result = normalizeObservations([fxObs, { ...fxObs, asOf: later }])
    expect(result.quotes).toHaveLength(2)
  })

  test("rejects invalid rows without throwing (graceful degradation)", () => {
    const result = normalizeObservations([
      fxObs,
      { ...fxObs, baseCurrency: undefined }, // fx missing base
      {
        kind: "crypto",
        symbol: "BTC",
        quoteCurrency: "usd", // bad shape
        asOf: AS_OF,
        priceDecimal: "67000",
      },
      {
        kind: "metal",
        symbol: "XAU",
        quoteCurrency: "USD",
        asOf: AS_OF,
        priceDecimal: "not-a-number",
      },
      {
        kind: "security",
        symbol: "",
        quoteCurrency: "USD",
        asOf: AS_OF,
        priceDecimal: "10",
      },
    ])
    expect(result.quotes).toHaveLength(1)
    expect(result.rejected).toHaveLength(4)
  })

  test("rejects a non-fx observation carrying a baseCurrency", () => {
    const result = normalizeObservations([
      {
        kind: "crypto",
        symbol: "BTC",
        baseCurrency: "USD",
        quoteCurrency: "USD",
        asOf: AS_OF,
        priceDecimal: "67000",
      },
    ])
    expect(result.quotes).toHaveLength(0)
    expect(result.rejected[0]?.reason).toContain("only valid for fx")
  })
})

// PER-238 — quote -> holding-price conversion (pure). Verifies the unit contract
// (metal per-gram derivation, security/crypto per-unit) and the scaled-integer →
// minor-unit scaling. IDR/USD minorUnitConversion = 100 (sen/cents).
describe("marketQuoteToHoldingPriceMinor (PER-238 quote -> holding price)", () => {
  test("security NAV/unit maps straight to minor units (per unit)", () => {
    // Reksadana NAV Rp 1,477.63/unit -> 147763 sen/unit.
    const nav = encodeSpotPrice("1477.63")
    expect(
      marketQuoteToHoldingPriceMinor({
        kind: "security",
        priceScaled: nav,
        priceScale: SPOT_PRICE_DECIMALS,
        minorUnitConversion: 100n,
      })
    ).toBe(147763n)
  })

  test("crypto per-coin price rounds 8dp precision to minor units", () => {
    // BTC $67000.12345678/coin -> 6700012 cents/coin (round-half-to-even).
    const btc = encodeSpotPrice("67000.12345678")
    expect(
      marketQuoteToHoldingPriceMinor({
        kind: "crypto",
        priceScaled: btc,
        priceScale: SPOT_PRICE_DECIMALS,
        minorUnitConversion: 100n,
      })
    ).toBe(6700012n)
  })

  test("metal price per TROY OUNCE is derived to per-GRAM then minor units", () => {
    // Gold $2400.53/oz -> per gram = 2400.53 / 31.1034768 = $77.178.../g -> 7718 cents/g.
    const perOunce = encodeSpotPrice("2400.53")
    // The derivation must match the canonical per-gram helper composed with scaling.
    const perGramScaled = spotPriceScaledPerGram(perOunce)
    expect(perGramScaled).toBe(7717883166n)
    expect(
      marketQuoteToHoldingPriceMinor({
        kind: "metal",
        priceScaled: perOunce,
        priceScale: SPOT_PRICE_DECIMALS,
        minorUnitConversion: 100n,
      })
    ).toBe(7718n)
  })

  test("a zero-fraction currency (JPY, conversion 1) keeps whole units", () => {
    // A ¥3500/share stock -> 3500 (no minor subdivision).
    const price = encodeSpotPrice("3500")
    expect(
      marketQuoteToHoldingPriceMinor({
        kind: "security",
        priceScaled: price,
        priceScale: SPOT_PRICE_DECIMALS,
        minorUnitConversion: 1n,
      })
    ).toBe(3500n)
  })

  test("rejects a non-spot price scale (an fx pair cannot price a holding)", () => {
    expect(() =>
      marketQuoteToHoldingPriceMinor({
        kind: "security",
        priceScaled: 100n,
        priceScale: FX_PRICE_DECIMALS, // 12 — fx scale, not a per-unit spot price
        minorUnitConversion: 100n,
      })
    ).toThrow()
  })

  test("rejects a non-positive price", () => {
    expect(() =>
      marketQuoteToHoldingPriceMinor({
        kind: "crypto",
        priceScaled: 0n,
        priceScale: SPOT_PRICE_DECIMALS,
        minorUnitConversion: 100n,
      })
    ).toThrow()
  })
})
