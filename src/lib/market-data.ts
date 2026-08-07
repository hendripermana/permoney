/**
 * Market data — pure encoding + normalization (ADR-0050 / PER-233).
 * =============================================================================
 *
 * This module is the PURE, DB-free core of the market-data subsystem: instrument
 * taxonomy, the price-scale encoding, the metal unit convention, and the
 * normalizer that turns provider observations into deduplicated canonical quote
 * rows. It imports no Prisma, no secrets, and no Node built-ins, so it is fully
 * unit-testable and safe to reuse from future UI. The DB-touching pipeline
 * (provider interface, fixture adapter, idempotent write path) lives in
 * `src/server/market-data.server.ts`.
 *
 * Price-scale encoding (the load-bearing decision)
 * ------------------------------------------------
 * A price is stored as a SCALED INTEGER `price = round(value * 10^priceScale)`,
 * and `priceScale` is persisted alongside it so every quote is self-describing
 * (no implicit per-kind knowledge, replayable normalization). Two conventions:
 *
 *   * FX pairs   — priceScale = 12, reusing `RATE_SCALE` / `encodeRate` from
 *     `@/lib/fx`. The value is "quote-currency major per 1 base-currency major"
 *     (e.g. USD/IDR = 16250.75 → 1 USD = 16250.75 IDR).
 *   * Spot (metal / security / crypto) — priceScale = 8 (`SPOT_PRICE_SCALE`).
 *     The value is "quote-currency major per instrument unit" (e.g. XAU =
 *     $2400.53 per troy ounce → 240053000000; BTC = $67000.12345678 →
 *     6700012345678). 8 fraction digits covers crypto's satoshi-grade precision.
 *
 * Metal unit convention
 * ---------------------
 * Metal quotes are stored CANONICALLY per TROY OUNCE. Per-gram is DERIVED
 * (`spotPriceScaledPerGram`) using the exact factor 1 troy ounce = 31.1034768 g,
 * with a single round-half-to-even step. Storing one canonical unit and deriving
 * the other keeps the store unambiguous while making both priceable.
 *
 * @see docs/adr/0050-market-data-ingestion.md
 * @see src/lib/fx.ts — the FX Rate encoding this module reuses/mirrors.
 */

import { encodeRate, RATE_SCALE } from "./fx"

/** The four market-data instrument kinds (CHECK domain in the migration). */
export const MARKET_INSTRUMENT_KINDS = [
  "fx",
  "metal",
  "security",
  "crypto",
] as const

export type MarketInstrumentKind = (typeof MARKET_INSTRUMENT_KINDS)[number]

export function isMarketInstrumentKind(
  value: string
): value is MarketInstrumentKind {
  return (MARKET_INSTRUMENT_KINDS as readonly string[]).includes(value)
}

/** Decimal digits implied by the FX price scale (`RATE_SCALE` = 1e12 → 12). */
export const FX_PRICE_DECIMALS = 12

/** Decimal digits implied by the spot price scale (1e8 → 8). */
export const SPOT_PRICE_DECIMALS = 8

/** Fixed scale for spot prices: `value` is persisted as `round(value * 1e8)`. */
export const SPOT_PRICE_SCALE = 100_000_000n

/**
 * Exact troy-ounce → gram factor, as a string so the caller controls rounding.
 * 1 troy ounce = 31.1034768 grams (international avoirdupois definition).
 */
export const TROY_OUNCE_GRAMS = "31.1034768"

/** Metals are stored canonically per this unit; per-gram is derived. */
export const METAL_QUOTE_UNIT = "troy_ounce" as const

/** The `priceScale` a given kind's quotes are stored at (12 for fx, else 8). */
export function priceScaleForKind(kind: MarketInstrumentKind): number {
  return kind === "fx" ? FX_PRICE_DECIMALS : SPOT_PRICE_DECIMALS
}

/**
 * Divide `numerator / denominator` with round-half-to-even. `denominator` MUST
 * be positive; sign is carried by `numerator`. Mirrors `@/lib/fx` and
 * `money.ts` so all scaled-integer math shares one rounding convention.
 */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("divRoundHalfEven: denominator must be positive")
  }
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient

  const absRemTwice = (remainder < 0n ? -remainder : remainder) * 2n
  if (absRemTwice < denominator) return quotient
  if (absRemTwice > denominator) {
    return numerator > 0n ? quotient + 1n : quotient - 1n
  }
  if (quotient % 2n === 0n) return quotient
  return numerator > 0n ? quotient + 1n : quotient - 1n
}

/**
 * Encode a positive decimal spot price ("2400.53", "67000.12345678", "27") into
 * the `SPOT_PRICE_SCALE`-scaled bigint. Excess precision beyond 8 fraction
 * digits is round-half-to-even'd, not truncated. Throws on malformed,
 * non-positive, or zero input — a corrupt price must fail loud.
 */
export function encodeSpotPrice(decimal: string): bigint {
  if (typeof decimal !== "string") {
    throw new TypeError(
      `encodeSpotPrice: expected string, got ${typeof decimal}`
    )
  }
  const trimmed = decimal.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `encodeSpotPrice: malformed price: ${JSON.stringify(decimal)}`
    )
  }

  const [whole, fractionRaw = ""] = trimmed.split(".")

  let scaled: bigint
  if (fractionRaw.length <= SPOT_PRICE_DECIMALS) {
    scaled = BigInt(whole + fractionRaw.padEnd(SPOT_PRICE_DECIMALS, "0"))
  } else {
    const base = BigInt(whole + fractionRaw.slice(0, SPOT_PRICE_DECIMALS))
    const rest = fractionRaw.slice(SPOT_PRICE_DECIMALS)
    const restValue = BigInt(rest)
    const half = BigInt("5" + "0".repeat(rest.length - 1))
    if (restValue < half) {
      scaled = base
    } else if (restValue > half) {
      scaled = base + 1n
    } else {
      scaled = base % 2n === 0n ? base : base + 1n
    }
  }

  if (scaled <= 0n) {
    throw new RangeError(
      `encodeSpotPrice: price must be positive, got ${JSON.stringify(decimal)}`
    )
  }
  return scaled
}

/**
 * Render a `SPOT_PRICE_SCALE`-scaled price back to its minimal decimal string
 * (inverse of `encodeSpotPrice` for representable values). Trailing zeros
 * stripped.
 */
export function decodeSpotPrice(priceScaled: bigint): string {
  if (priceScaled <= 0n) {
    throw new RangeError(
      `decodeSpotPrice: price must be positive, got ${priceScaled}`
    )
  }
  const whole = priceScaled / SPOT_PRICE_SCALE
  const fraction = priceScaled % SPOT_PRICE_SCALE
  if (fraction === 0n) return whole.toString()
  const padded = fraction.toString().padStart(SPOT_PRICE_DECIMALS, "0")
  let end = padded.length
  while (end > 0 && padded[end - 1] === "0") end--
  return `${whole.toString()}.${padded.slice(0, end)}`
}

/**
 * Encode a kind's price decimal into `(price, priceScale)`. FX reuses the fx.ts
 * Rate encoding (scale 1e12); every other kind uses the spot scale (1e8). This
 * is the single place kind → scale is decided on the write path.
 */
export function encodePriceForKind(
  kind: MarketInstrumentKind,
  decimal: string
): { price: bigint; priceScale: number } {
  if (kind === "fx") {
    return { price: encodeRate(decimal), priceScale: FX_PRICE_DECIMALS }
  }
  return { price: encodeSpotPrice(decimal), priceScale: SPOT_PRICE_DECIMALS }
}

/**
 * Convert a metal spot price stored per TROY OUNCE (scale 1e8) into the same-
 * scale price per GRAM: perGram = round(perOunceScaled * 10_000_000 /
 * 311_034_768). Uses `TROY_OUNCE_GRAMS` (31.1034768) with a single
 * round-half-to-even step. The scale is unchanged (still 1e8).
 */
export function spotPriceScaledPerGram(perOunceScaled: bigint): bigint {
  if (perOunceScaled <= 0n) {
    throw new RangeError(
      `spotPriceScaledPerGram: price must be positive, got ${perOunceScaled}`
    )
  }
  // 31.1034768 g/oz, exact, as an integer ratio: 311034768 / 10000000.
  // perGram = perOunce / 31.1034768 = perOunce * 10_000_000 / 311_034_768.
  return divRoundHalfEven(perOunceScaled * 10_000_000n, 311_034_768n)
}

/**
 * Kinds that can price a HOLDING (PER-238). An `fx` MarketInstrument is a
 * currency PAIR, not a per-unit price, so it can never back a holding's price.
 */
export type MarketPricedHoldingKind = Exclude<MarketInstrumentKind, "fx">

/**
 * Convert a canonical `MarketQuote` price into a holding's `lastPriceMinor`
 * (MINOR units of the holding's currency, per ONE holding unit) — PER-238.
 *
 * UNIT CONTRACT (the load-bearing part — must match the holding's quantity unit):
 *   * metal    — the quote is stored CANONICALLY per TROY OUNCE (spot scale 1e8);
 *     a metal holding's quantity is in GRAMS (ADR-0051 gold = grams), so we
 *     derive the per-gram price first (`spotPriceScaledPerGram`) before scaling
 *     to minor units.
 *   * security — the quote is per UNIT (a fund's NAV/unit, a share's last price)
 *     at spot scale 1e8; used directly (a reksadana/stock holding's quantity is
 *     units/shares).
 *   * crypto   — the quote is per COIN at spot scale 1e8; used directly.
 *   * fx       — NOT a holding price basis (excluded from the input type).
 *
 * `minorUnitConversion` is the currency's major→minor multiplier (100 for
 * IDR/USD, 1 for JPY). The result is
 *   lastPriceMinor = round( perUnitScaled * minorUnitConversion / 1e8 )
 * with round-half-to-even, matching every other scaled-integer conversion in the
 * codebase. Same-currency (quote currency == account currency) is enforced by
 * the caller; cross-currency (FX) is a later slice.
 *
 * Pure: no DB, no side effects. Throws on a non-positive price, an unexpected
 * price scale (metal/security/crypto quotes are always spot-scaled), or a
 * non-positive conversion — a corrupt price must fail loud, never mis-mark money.
 */
export function marketQuoteToHoldingPriceMinor(params: {
  kind: MarketPricedHoldingKind
  priceScaled: bigint
  priceScale: number
  minorUnitConversion: bigint
}): bigint {
  const { kind, priceScaled, priceScale, minorUnitConversion } = params
  if (priceScaled <= 0n) {
    throw new RangeError(
      `marketQuoteToHoldingPriceMinor: price must be positive, got ${priceScaled}`
    )
  }
  if (priceScale !== SPOT_PRICE_DECIMALS) {
    throw new RangeError(
      `marketQuoteToHoldingPriceMinor: expected spot price scale ${SPOT_PRICE_DECIMALS}, got ${priceScale} (an fx pair cannot price a holding)`
    )
  }
  if (minorUnitConversion <= 0n) {
    throw new RangeError(
      `marketQuoteToHoldingPriceMinor: minorUnitConversion must be positive, got ${minorUnitConversion}`
    )
  }
  const perUnitScaled =
    kind === "metal" ? spotPriceScaledPerGram(priceScaled) : priceScaled
  const scaleDivisor = 10n ** BigInt(SPOT_PRICE_DECIMALS)
  return divRoundHalfEven(perUnitScaled * minorUnitConversion, scaleDivisor)
}

/** Convert `RATE_SCALE` fx price + `SPOT_PRICE_SCALE` — exported for callers. */
export { RATE_SCALE }

/**
 * A single price observation as a provider hands it over (pre-normalization).
 * `priceDecimal` is the provider's human decimal; the normalizer encodes it.
 */
export interface MarketObservation {
  kind: MarketInstrumentKind
  symbol: string
  /** FX only: the base (from) currency. Required iff kind === "fx". */
  baseCurrency?: string
  /** The currency the price is quoted in (ISO-4217). */
  quoteCurrency: string
  /** Securities only: MIC / exchange code. */
  mic?: string
  asOf: Date
  priceDecimal: string
  providerRef?: string
}

/** The stable identity of an instrument, used for dedup + resolve-or-create. */
export interface MarketInstrumentIdentity {
  kind: MarketInstrumentKind
  symbol: string
  baseCurrency: string | null
  quoteCurrency: string
  mic: string | null
}

/** A normalized, ready-to-persist canonical quote (still keyed by identity). */
export interface NormalizedQuote {
  identity: MarketInstrumentIdentity
  asOf: Date
  price: bigint
  priceScale: number
  quoteCurrency: string
  providerRef: string | null
}

export interface NormalizeResult {
  quotes: NormalizedQuote[]
  /** Human-readable reasons observations were dropped (validation/dup). */
  rejected: { observation: MarketObservation; reason: string }[]
}

function identityOf(obs: MarketObservation): MarketInstrumentIdentity {
  return {
    kind: obs.kind,
    symbol: obs.symbol.trim(),
    baseCurrency: obs.kind === "fx" ? (obs.baseCurrency ?? "").trim() : null,
    quoteCurrency: obs.quoteCurrency.trim(),
    mic: obs.kind === "security" ? (obs.mic ?? null) : null,
  }
}

/** Stable string key for an identity + asOf, used to dedup within one fetch. */
export function quoteDedupKey(
  identity: MarketInstrumentIdentity,
  asOf: Date
): string {
  return [
    identity.kind,
    identity.symbol,
    identity.baseCurrency ?? "",
    identity.quoteCurrency,
    identity.mic ?? "",
    asOf.toISOString(),
  ].join("|")
}

/**
 * Validate + encode + DEDUPLICATE provider observations into canonical quotes.
 *
 * - Validates kind, symbol, currency shapes, fx base-currency presence, and a
 *   parseable positive price; invalid rows are collected in `rejected`, never
 *   thrown (graceful degradation — one bad row must not kill the batch).
 * - Encodes the price via `encodePriceForKind` (fx → 1e12, spot → 1e8).
 * - Deduplicates within the fetch by (identity, asOf): the LAST observation
 *   wins (providers list newest-last by convention here), so a fetch that
 *   repeats an instrument yields exactly one canonical quote.
 *
 * Pure: no DB, no side effects. The server pipeline resolves each `identity`
 * to a `MarketInstrument` id and idempotently upserts on
 * (marketInstrumentId, asOf, source).
 */
export function normalizeObservations(
  observations: readonly MarketObservation[]
): NormalizeResult {
  const byKey = new Map<string, NormalizedQuote>()
  const rejected: NormalizeResult["rejected"] = []
  const currencyShape = /^[A-Z]{3,5}$/

  for (const obs of observations) {
    if (!isMarketInstrumentKind(obs.kind)) {
      // `obs.kind` narrows to `never` here (its static type is a valid kind);
      // a runtime-invalid value can still arrive from an untyped provider.
      rejected.push({
        observation: obs,
        reason: `unknown kind "${String(obs.kind)}"`,
      })
      continue
    }
    const identity = identityOf(obs)
    if (identity.symbol.length === 0) {
      rejected.push({ observation: obs, reason: "empty symbol" })
      continue
    }
    if (!currencyShape.test(identity.quoteCurrency)) {
      rejected.push({
        observation: obs,
        reason: `bad quoteCurrency "${obs.quoteCurrency}"`,
      })
      continue
    }
    if (obs.kind === "fx" && !currencyShape.test(identity.baseCurrency ?? "")) {
      rejected.push({
        observation: obs,
        reason: "fx observation missing/invalid baseCurrency",
      })
      continue
    }
    if (obs.kind !== "fx" && obs.baseCurrency) {
      rejected.push({
        observation: obs,
        reason: `baseCurrency only valid for fx (got kind "${obs.kind}")`,
      })
      continue
    }
    if (Number.isNaN(obs.asOf.getTime())) {
      rejected.push({ observation: obs, reason: "invalid asOf" })
      continue
    }

    let encoded: { price: bigint; priceScale: number }
    try {
      encoded = encodePriceForKind(obs.kind, obs.priceDecimal)
    } catch (error) {
      rejected.push({
        observation: obs,
        reason: error instanceof Error ? error.message : "unencodable price",
      })
      continue
    }

    byKey.set(quoteDedupKey(identity, obs.asOf), {
      identity,
      asOf: obs.asOf,
      price: encoded.price,
      priceScale: encoded.priceScale,
      quoteCurrency: identity.quoteCurrency,
      providerRef: obs.providerRef ?? null,
    })
  }

  return { quotes: [...byKey.values()], rejected }
}
