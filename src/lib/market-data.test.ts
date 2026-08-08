import { describe, expect, test } from "vite-plus/test"
import { encodeRate } from "./fx"
import {
  BSI_GOLD_SOURCE,
  BSI_GOLD_SYMBOL,
  decodeSpotPrice,
  encodePriceForKind,
  encodeSpotPrice,
  FX_PRICE_DECIMALS,
  goldPerGramMajorToPerOunceDecimal,
  isMarketInstrumentKind,
  MARKET_INSTRUMENT_KINDS,
  marketQuoteToHoldingPriceMinor,
  normalizeObservations,
  parseLogamMuliaGoldResponse,
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

// =============================================================================
// BSI gold feed — logam-mulia-api parsing (PER-235)
// =============================================================================

// The documented logam-mulia-api response contract (recorded as the fixture).
const GOLD_PAYLOAD = {
  success: true,
  data: [
    {
      source: "bankbsi",
      material: "gold",
      materialType: "BSI",
      weight: 1,
      weightUnit: "gr",
      sellPrice: 2_700_000,
      buybackPrice: 2_650_000,
      currency: "IDR",
      recordedDate: "2026-05-16",
    },
  ],
  count: 1,
  timestamp: "2026-05-16T05:06:58.888Z",
  cached: true,
}

describe("goldPerGramMajorToPerOunceDecimal (per-gram -> per-troy-ounce, exact)", () => {
  test("converts an integer per-gram price with zero float error", () => {
    // Rp 2,650,000/gram × 31.1034768 g/oz = Rp 82,424,213.52/oz.
    expect(goldPerGramMajorToPerOunceDecimal(2_650_000)).toBe("82424213.52")
    // Rp 2,700,000/gram × 31.1034768 = Rp 83,979,387.36/oz.
    expect(goldPerGramMajorToPerOunceDecimal(2_700_000)).toBe("83979387.36")
  })

  test("round-trips per-ounce -> per-gram with ZERO loss (integer per-gram)", () => {
    const perOunceDecimal = goldPerGramMajorToPerOunceDecimal(2_650_000)
    const perOunceScaled = encodeSpotPrice(perOunceDecimal)
    // The PER-238 derivation gives back exactly 2,650,000 × 1e8 (per gram).
    expect(spotPriceScaledPerGram(perOunceScaled)).toBe(
      2_650_000n * SPOT_PRICE_SCALE
    )
  })

  test("throws on a non-positive or non-finite price", () => {
    expect(() => goldPerGramMajorToPerOunceDecimal(0)).toThrow()
    expect(() => goldPerGramMajorToPerOunceDecimal(-1)).toThrow()
    expect(() => goldPerGramMajorToPerOunceDecimal(Number.NaN)).toThrow()
  })
})

describe("parseLogamMuliaGoldResponse", () => {
  test("maps the bankbsi fixture -> one per-troy-ounce metal observation (buyback)", () => {
    const result = parseLogamMuliaGoldResponse(GOLD_PAYLOAD)
    expect(result.status).toBe("ok")
    expect(result.observations).toHaveLength(1)
    const obs = result.observations[0]
    expect(obs?.kind).toBe("metal")
    expect(obs?.symbol).toBe(BSI_GOLD_SYMBOL) // "XAU-BSI"
    expect(obs?.quoteCurrency).toBe("IDR")
    expect(obs?.priceDecimal).toBe("82424213.52") // buyback per gram -> per oz
    expect(obs?.providerRef).toBe(BSI_GOLD_SOURCE) // "bankbsi"
    expect(obs?.asOf.toISOString()).toBe("2026-05-16T00:00:00.000Z")
  })

  test("normalizes to a canonical spot quote (priceScale=8) whose per-gram mark equals buyback", () => {
    const result = parseLogamMuliaGoldResponse(GOLD_PAYLOAD)
    const normalized = normalizeObservations(result.observations)
    expect(normalized.rejected).toHaveLength(0)
    const quote = normalized.quotes[0]
    expect(quote?.priceScale).toBe(8)
    expect(quote?.price).toBe(encodeSpotPrice("82424213.52"))
    // Priced through the UNCHANGED PER-238 metal path: Rp 2,650,000/gram in sen.
    const perGramMinor = marketQuoteToHoldingPriceMinor({
      kind: "metal",
      priceScaled: quote?.price ?? 0n,
      priceScale: quote?.priceScale ?? 0,
      minorUnitConversion: 100n,
    })
    expect(perGramMinor).toBe(265_000_000n) // Rp 2,650,000.00
  })

  test("honors the sellPrice option", () => {
    const result = parseLogamMuliaGoldResponse(GOLD_PAYLOAD, {
      priceField: "sellPrice",
    })
    expect(result.observations[0]?.priceDecimal).toBe("83979387.36")
  })

  test("picks the 1-gram row when several weights are present", () => {
    const multi = {
      ...GOLD_PAYLOAD,
      data: [
        { ...GOLD_PAYLOAD.data[0], weight: 5, buybackPrice: 13_000_000 },
        GOLD_PAYLOAD.data[0],
        { ...GOLD_PAYLOAD.data[0], weight: 10, buybackPrice: 26_000_000 },
      ],
    }
    const result = parseLogamMuliaGoldResponse(multi)
    expect(result.status).toBe("ok")
    expect(result.observations[0]?.priceDecimal).toBe("82424213.52")
  })

  test("success:false -> graceful skip (no throw, no observations)", () => {
    const result = parseLogamMuliaGoldResponse({
      ...GOLD_PAYLOAD,
      success: false,
    })
    expect(result.status).toBe("error")
    expect(result.observations).toHaveLength(0)
    expect(result.error).toContain("success")
  })

  test("empty data -> graceful skip", () => {
    const result = parseLogamMuliaGoldResponse({ ...GOLD_PAYLOAD, data: [] })
    expect(result.status).toBe("error")
    expect(result.observations).toHaveLength(0)
  })

  test("no 1-gram row -> falls back to buyback / weightInGrams (PER-235c general rule)", () => {
    // A single 5-gram bar priced Rp 13,250,000 -> per-gram Rp 2,650,000 -> the
    // same per-troy-ounce mark as the 1-gram row. The general rule prices ANY
    // gram-weighted bar, so a source that omits the 1-gram row is no longer a skip.
    const result = parseLogamMuliaGoldResponse({
      ...GOLD_PAYLOAD,
      data: [{ ...GOLD_PAYLOAD.data[0], weight: 5, buybackPrice: 13_250_000 }],
    })
    expect(result.status).toBe("ok")
    expect(result.observations[0]?.priceDecimal).toBe("82424213.52")
  })

  test("anekalogam shape (many bars) -> prefers the 1-gram bar", () => {
    // Antam LM list: 0.5gr, 1gr, 2gr. The 1-gram bar's buyback is the per-gram.
    const anekalogam = {
      success: true,
      data: [
        {
          source: "anekalogam",
          weight: 0.5,
          weightUnit: "gr",
          buybackPrice: 1_310_000,
          currency: "IDR",
          recordedDate: "2026-05-16",
        },
        {
          source: "anekalogam",
          weight: 1,
          weightUnit: "gr",
          buybackPrice: 2_620_000,
          currency: "IDR",
          recordedDate: "2026-05-16",
        },
        {
          source: "anekalogam",
          weight: 2,
          weightUnit: "gr",
          buybackPrice: 5_240_000,
          currency: "IDR",
          recordedDate: "2026-05-16",
        },
      ],
      count: 3,
      timestamp: "2026-05-16T05:06:58.888Z",
    }
    const result = parseLogamMuliaGoldResponse(anekalogam, {
      sourceLabel: "anekalogam",
    })
    expect(result.status).toBe("ok")
    // Rp 2,620,000/gram -> per troy ounce (exact).
    expect(result.observations[0]?.priceDecimal).toBe(
      goldPerGramMajorToPerOunceDecimal(2_620_000)
    )
    expect(result.observations[0]?.providerRef).toBe("anekalogam")
    // Round-trips per-ounce -> per-gram minor with ZERO loss.
    const quote = normalizeObservations(result.observations).quotes[0]
    const perGramMinor = marketQuoteToHoldingPriceMinor({
      kind: "metal",
      priceScaled: quote?.price ?? 0n,
      priceScale: quote?.priceScale ?? 0,
      minorUnitConversion: 100n,
    })
    expect(perGramMinor).toBe(262_000_000n) // Rp 2,620,000.00
  })

  test("pegadaian shape (weight 0.01 gram) -> per-gram = buyback x 100 (exact)", () => {
    const pegadaian = {
      success: true,
      data: [
        {
          source: "pegadaian",
          weight: 0.01,
          weightUnit: "gram",
          buybackPrice: 25_900,
          currency: "IDR",
          recordedDate: "2026-05-16",
        },
      ],
      count: 1,
      timestamp: "2026-05-16T05:06:58.888Z",
    }
    const result = parseLogamMuliaGoldResponse(pegadaian, {
      sourceLabel: "pegadaian",
    })
    expect(result.status).toBe("ok")
    // Rp 25,900 per 0.01 gram = Rp 2,590,000/gram -> per troy ounce (exact).
    expect(result.observations[0]?.priceDecimal).toBe(
      goldPerGramMajorToPerOunceDecimal(2_590_000)
    )
    expect(result.observations[0]?.providerRef).toBe("pegadaian")
    const quote = normalizeObservations(result.observations).quotes[0]
    const perGramMinor = marketQuoteToHoldingPriceMinor({
      kind: "metal",
      priceScaled: quote?.price ?? 0n,
      priceScale: quote?.priceScale ?? 0,
      minorUnitConversion: 100n,
    })
    expect(perGramMinor).toBe(259_000_000n) // Rp 2,590,000.00 (exact x100)
  })

  test("a non-gram unit row -> graceful skip (no usable row)", () => {
    const result = parseLogamMuliaGoldResponse({
      ...GOLD_PAYLOAD,
      data: [{ ...GOLD_PAYLOAD.data[0], weight: 1, weightUnit: "oz" }],
    })
    expect(result.status).toBe("error")
    expect(result.error).toContain("no usable")
  })

  test("malformed payloads -> graceful skip (no throw)", () => {
    expect(parseLogamMuliaGoldResponse(null).status).toBe("error")
    expect(parseLogamMuliaGoldResponse("nope").status).toBe("error")
    expect(parseLogamMuliaGoldResponse({}).status).toBe("error")
    expect(
      parseLogamMuliaGoldResponse({ success: true, data: "not-array" }).status
    ).toBe("error")
  })

  test("a non-positive price -> graceful skip", () => {
    const result = parseLogamMuliaGoldResponse({
      ...GOLD_PAYLOAD,
      data: [{ ...GOLD_PAYLOAD.data[0], buybackPrice: 0 }],
    })
    expect(result.status).toBe("error")
  })
})
