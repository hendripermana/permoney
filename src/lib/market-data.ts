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

// =============================================================================
// BSI gold feed — logam-mulia-api parsing (PER-235 / ADR-0050 slice 3)
// =============================================================================
//
// We self-host `iamutaki/logam-mulia-api` (MIT, a Cloudflare Worker) as a
// SEPARATE service that scrapes Indonesian gold sources and exposes clean JSON.
// Permoney consumes only its HTTPS JSON; the fragile scraping stays in the
// worker. This section is the PURE parser + unit conversion — no network, no
// Prisma, no secrets — so it is fully unit-testable. The network adapter and
// ingest trigger live in `src/server/market-data.server.ts`.
//
// UNIT DECISION (load-bearing): BSI publishes gold prices per GRAM, but the
// canonical metal store is per TROY OUNCE (PER-233 metal convention; PER-238's
// `marketQuoteToHoldingPriceMinor` DERIVES per-gram from a per-ounce quote via
// `spotPriceScaledPerGram`). To stay consistent with that ONE metal unit — and
// so a linked gold holding auto-prices correctly through the UNCHANGED PER-238
// refresh — this parser converts BSI's per-gram price to a per-TROY-OUNCE
// `priceDecimal` before handing it to the normalizer. The conversion is exact
// (integer per-gram prices round-trip with zero loss), so a holding still marks
// at exactly `pricePerGram × grams`.

/** Canonical symbol of the self-hosted BSI gold price series (a metal). */
export const BSI_GOLD_SYMBOL = "XAU-BSI"

/** Quote `source` / provider label for the BSI gold feed (endpoint path). */
export const BSI_GOLD_SOURCE = "bankbsi"

/** BSI gold is quoted in Indonesian rupiah. */
export const BSI_GOLD_QUOTE_CURRENCY = "IDR"

/**
 * Which published price we treat as the quote. `buybackPrice` is what BSI pays
 * to buy a gram BACK from you — the realizable current value of gold you HOLD —
 * so it is the honest mark for a holding's worth. Flip to `sellPrice` (the price
 * to acquire a new gram) ONLY if the creator confirms their BSI app shows that
 * number as the position value. Kept a named constant so the flip is one line.
 */
export type GoldPriceField = "buybackPrice" | "sellPrice"
export const BSI_GOLD_PRICE_FIELD: GoldPriceField = "buybackPrice"

/** One published price row from logam-mulia-api (documented response shape). */
export interface LogamMuliaPriceRow {
  source: string
  material: string
  materialType: string
  weight: number
  weightUnit: string
  sellPrice: number
  buybackPrice: number
  currency: string
  recordedDate: string
}

/** The logam-mulia-api response envelope (documented response shape). */
export interface LogamMuliaResponse {
  success: boolean
  data: LogamMuliaPriceRow[]
  count: number
  timestamp: string
  cached?: boolean
}

/** The outcome of parsing a logam-mulia-api payload into observations. */
export interface LogamMuliaParseResult {
  status: "ok" | "error"
  /** Human-readable reason when `status` is "error" (graceful skip, no throw). */
  error?: string
  observations: MarketObservation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function renderScaledDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const divisor = 10n ** BigInt(decimals)
  const whole = value / divisor
  const frac = value % divisor
  if (frac === 0n) return whole.toString()
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${whole.toString()}.${fracText}`
}

/**
 * Convert a metal price quoted per GRAM (major currency units, as the gold feeds
 * publish it) into the per-TROY-OUNCE decimal string the canonical metal store
 * uses. Exact BigInt math via `TROY_OUNCE_GRAMS` (31.1034768 = 311034768 / 1e7)
 * — no float. An integer per-gram price round-trips through
 * `spotPriceScaledPerGram` with ZERO loss. Throws on a non-finite / non-positive
 * input (a corrupt price must fail loud, never mis-mark money).
 */
export function goldPerGramMajorToPerOunceDecimal(
  perGramMajor: number
): string {
  if (!Number.isFinite(perGramMajor) || perGramMajor <= 0) {
    throw new RangeError(
      `goldPerGramMajorToPerOunceDecimal: price must be a positive finite number, got ${perGramMajor}`
    )
  }
  return goldPerGramDecimalToPerOunceDecimal(perGramMajor.toString())
}

/**
 * Exact per-GRAM decimal string → per-TROY-OUNCE decimal string (the string core
 * of `goldPerGramMajorToPerOunceDecimal`, used when the per-gram price is derived
 * via BigInt from a source whose entry is priced per some other weight — see
 * `perGramBuybackDecimal`). No float: `× 311034768 / 1e7`. Throws on a malformed
 * or non-positive input.
 */
function goldPerGramDecimalToPerOunceDecimal(gramText: string): string {
  const trimmed = gramText.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(
      `goldPerGramDecimalToPerOunceDecimal: unrepresentable price ${gramText}`
    )
  }
  const [whole, fraction = ""] = trimmed.split(".")
  const gramScaled = BigInt(whole + fraction) // value × 10^fraction.length
  if (gramScaled <= 0n) {
    throw new RangeError(
      `goldPerGramDecimalToPerOunceDecimal: price must be positive, got ${gramText}`
    )
  }
  const ounceScaled = gramScaled * 311_034_768n // × 10^(fraction.length + 7)
  return renderScaledDecimal(ounceScaled, fraction.length + 7)
}

/**
 * Parse a positive decimal string ("2650000", "0.01", "0.5") into a scaled
 * BigInt plus its fraction-digit count, so the caller can do exact rational math
 * with no float error. Throws on a malformed / non-positive-shaped input.
 */
function decimalToScaled(text: string): { scaled: bigint; fracDigits: number } {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) {
    throw new RangeError(`decimalToScaled: not a positive decimal: ${text}`)
  }
  const [whole, frac = ""] = t.split(".")
  return { scaled: BigInt(whole + frac), fracDigits: frac.length }
}

/**
 * Exact per-GRAM (major-currency) decimal for a chosen feed entry:
 * `perGram = priceMajor / weightGrams`, computed as an exact rational with
 * BigInt (NO float division — `26500 / 0.01` in IEEE-754 is NOT 2_650_000) and
 * rounded half-to-even to at most `SPOT_PRICE_DECIMALS` (8) fraction digits.
 *
 * This is the GENERAL rule that unifies the three gold sources' differing shapes:
 *   - a `weight == 1 gr` bar (bankbsi / anekalogam plain LM) → perGram = buyback,
 *   - a `weight == 0.01 gram` row (pegadaian) → perGram = buyback × 100,
 *   - any other bar → perGram = buyback / weightInGrams.
 * Integer per-gram results round-trip through `spotPriceScaledPerGram` with zero
 * loss, so a linked holding still marks at exactly `pricePerGram × grams`.
 */
function perGramBuybackDecimal(
  priceMajor: number,
  weightGrams: number
): string {
  const b = decimalToScaled(String(priceMajor))
  const w = decimalToScaled(String(weightGrams))
  // perGram = (b.scaled / 10^b.frac) / (w.scaled / 10^w.frac)
  //         = (b.scaled × 10^w.frac) / (w.scaled × 10^b.frac)
  const num = b.scaled * 10n ** BigInt(w.fracDigits)
  const den = w.scaled * 10n ** BigInt(b.fracDigits)
  if (den <= 0n) {
    throw new RangeError(`perGramBuybackDecimal: weight must be positive`)
  }
  const scaled = divRoundHalfEven(num * 10n ** BigInt(SPOT_PRICE_DECIMALS), den)
  if (scaled <= 0n) {
    throw new RangeError(`perGramBuybackDecimal: non-positive per-gram price`)
  }
  return renderScaledDecimal(scaled, SPOT_PRICE_DECIMALS)
}

/**
 * A feed row's weight expressed in GRAMS, or `null` when the row's weight/unit is
 * not a usable positive gram weight. Accepts the gram units the three sources use
 * (`gr` — bankbsi/anekalogam, `gram`/`grams` — pegadaian); any other unit is
 * rejected (fail closed rather than mis-scale a price).
 */
function weightInGrams(weight: unknown, unit: unknown): number | null {
  const w = Number(weight)
  if (!Number.isFinite(w) || w <= 0) return null
  const u = typeof unit === "string" ? unit.trim().toLowerCase() : ""
  if (u === "gr" || u === "gram" || u === "grams") return w
  return null
}

/**
 * Choose the pricing row from a gold feed's `data` array. Prefers a plain
 * 1-gram bar (the exact per-gram source: bankbsi's single row, anekalogam's `1gr`
 * entry); failing that, the smallest-weight valid entry (so pegadaian's
 * `0.01 gram` row and any multi-weight list still yield a per-gram price via the
 * general `buyback / weightInGrams` rule). Rows with a non-gram unit or a
 * non-positive price are skipped. Returns `null` when no row is usable.
 */
function chooseGoldEntry(
  data: readonly unknown[],
  priceField: GoldPriceField
): {
  row: Record<string, unknown>
  weightGrams: number
  priceMajor: number
} | null {
  const candidates: {
    row: Record<string, unknown>
    weightGrams: number
    priceMajor: number
  }[] = []
  for (const candidate of data) {
    if (!isRecord(candidate)) continue
    const grams = weightInGrams(candidate.weight, candidate.weightUnit)
    if (grams === null) continue
    const priceMajor = Number(candidate[priceField])
    if (!Number.isFinite(priceMajor) || priceMajor <= 0) continue
    candidates.push({ row: candidate, weightGrams: grams, priceMajor })
  }
  if (candidates.length === 0) return null
  const oneGram = candidates.find((entry) => entry.weightGrams === 1)
  if (oneGram) return oneGram
  return candidates.reduce((best, entry) =>
    entry.weightGrams < best.weightGrams ? entry : best
  )
}

function resolveGoldAsOf(
  recordedDate: unknown,
  timestamp: unknown,
  fallback: Date | undefined
): Date | null {
  if (typeof recordedDate === "string" && recordedDate.trim().length > 0) {
    const d = new Date(`${recordedDate.trim()}T00:00:00.000Z`)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof timestamp === "string" && timestamp.trim().length > 0) {
    const d = new Date(timestamp)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (fallback && !Number.isNaN(fallback.getTime())) return fallback
  return null
}

/**
 * Parse a logam-mulia-api gold payload (from ANY of the fallback-chain sources —
 * `bankbsi`, `anekalogam`, `pegadaian`; PER-235c) into a single canonical metal
 * observation (per TROY OUNCE — see the unit decision above). The sources share
 * the `{ success, data: [ { weight, weightUnit, buybackPrice, ... } ] }` envelope
 * but differ in shape (bankbsi: one `1 gr` row; anekalogam: many rows; pegadaian:
 * one `0.01 gram` row); `chooseGoldEntry` + `perGramBuybackDecimal` normalize any
 * of them to a per-gram buyback, then to per-troy-ounce. The observation always
 * carries the SAME `XAU-BSI` symbol (all sources price the one gold series) — the
 * winning source is recorded as the quote `source`/provenance by the caller.
 *
 * Defensive: any shape problem (`success !== true`, empty/absent `data`, no
 * usable priced gram row, an unparseable date) yields `status: "error"` with a
 * reason and ZERO observations — NEVER a throw — so the ingest pipeline degrades
 * gracefully and keeps the last good quote.
 *
 * Pure: no DB, no network, no secrets.
 */
export function parseLogamMuliaGoldResponse(
  payload: unknown,
  opts?: {
    priceField?: GoldPriceField
    fallbackAsOf?: Date
    /** Provenance fallback for `providerRef` when the row omits its own source. */
    sourceLabel?: string
  }
): LogamMuliaParseResult {
  const priceField = opts?.priceField ?? BSI_GOLD_PRICE_FIELD
  const err = (reason: string): LogamMuliaParseResult => ({
    status: "error",
    error: reason,
    observations: [],
  })

  if (!isRecord(payload)) return err("payload is not an object")
  if (payload.success !== true) {
    return err(`provider reported success=${String(payload.success)}`)
  }
  const data = payload.data
  if (!Array.isArray(data) || data.length === 0) {
    return err("payload data is empty")
  }

  const chosen = chooseGoldEntry(data, priceField)
  if (chosen === null) {
    return err(
      `no usable ${priceField} row (need a positive price on a gram-weighted row)`
    )
  }
  const { row } = chosen

  const currency = typeof row.currency === "string" ? row.currency.trim() : ""
  if (currency.length === 0) return err("row is missing a currency")

  const asOf = resolveGoldAsOf(
    row.recordedDate,
    payload.timestamp,
    opts?.fallbackAsOf
  )
  if (asOf === null) return err("row has no parseable recordedDate/timestamp")

  let priceDecimal: string
  try {
    const perGram = perGramBuybackDecimal(chosen.priceMajor, chosen.weightGrams)
    priceDecimal = goldPerGramDecimalToPerOunceDecimal(perGram)
  } catch (error) {
    return err(error instanceof Error ? error.message : "unconvertible price")
  }

  return {
    status: "ok",
    observations: [
      {
        kind: "metal",
        symbol: BSI_GOLD_SYMBOL,
        quoteCurrency: currency,
        asOf,
        priceDecimal,
        providerRef:
          typeof row.source === "string"
            ? row.source
            : (opts?.sourceLabel ?? BSI_GOLD_SOURCE),
      },
    ],
  }
}
