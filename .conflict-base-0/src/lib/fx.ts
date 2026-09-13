/**
 * FX — currency conversion on top of money.ts (ADR-0035, "Phase B").
 * =============================================================================
 *
 * money.ts deliberately REJECTS cross-currency arithmetic (`assertSameCurrency`
 * throws "Use FX conversion first (Phase B)"). This module is that phase: it
 * converts a signed minor-unit amount from one currency into another using a
 * stored exchange rate, staying in the exact `bigint` domain throughout.
 *
 * Rate representation
 * -------------------
 * A rate is a **major-unit -> major-unit** quote ("1 fromMajor = rate toMajor",
 * the human-intuitive form) stored as a **scaled `bigint`** at a fixed scale of
 * `RATE_SCALE = 1e12`: `rateScaled = round(rate * 1e12)`.
 *
 * Why 1e12 (vs money.ts's internal 1e9 mul scale)? Snapshots are stored
 * `foreign -> base`. If the base is a small-unit currency (e.g. IDR->USD is
 * ~0.0000615), a 1e9 scale leaves only ~5 significant figures. 1e12 keeps ~8
 * even for tiny rates; `bigint` cannot overflow on the large side. 12 fraction
 * digits exceeds real-world FX quote precision, so the stored integer
 * reproduces the applied rate exactly.
 *
 * Rounding
 * --------
 * Conversion is computed in a single integer expression with ONE
 * round-half-to-even (banker's rounding) step — the same convention money.ts's
 * `mulMoney` uses — so there is never a double-rounding bias.
 *
 * @see docs/adr/0035-currency-fx-snapshots-and-cross-currency-transfers.md
 */

import { CURRENCIES, type CurrencyCode } from "@/lib/data/currencies"
import { toMoney, type Money } from "./money"

/** Fixed scale for stored rates: a rate of `r` is persisted as `round(r * 1e12)`. */
export const RATE_SCALE = 1_000_000_000_000n

/** The identity rate (1.0) — used when a row's native currency equals the base. */
export const IDENTITY_RATE = RATE_SCALE

/** Number of fraction digits implied by `RATE_SCALE` (1e12 -> 12). */
const RATE_DECIMALS = 12

function minorConversion(currency: CurrencyCode): bigint {
  return BigInt(CURRENCIES[currency].minorUnitConversion)
}

/**
 * Divide `numerator / denominator` with round-half-to-even. `denominator` MUST
 * be positive; the sign is carried by `numerator`. Mirrors the rounding in
 * money.ts `mulMoney` so FX and scalar math agree.
 */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError(`divRoundHalfEven: denominator must be positive`)
  }
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient

  const absRemTwice = (remainder < 0n ? -remainder : remainder) * 2n
  if (absRemTwice < denominator) return quotient
  if (absRemTwice > denominator) {
    return numerator > 0n ? quotient + 1n : quotient - 1n
  }
  // Exactly half — round to even.
  if (quotient % 2n === 0n) return quotient
  return numerator > 0n ? quotient + 1n : quotient - 1n
}

/**
 * Parse a positive decimal rate string ("16250.75", "0.0000615", "16250") into
 * the scaled `bigint` representation. Excess precision beyond 12 fraction
 * digits is round-half-to-even'd, not truncated. Throws on malformed,
 * non-positive, or zero input — a corrupt/zero rate must fail loud rather than
 * silently produce a zero conversion.
 */
export function encodeRate(decimal: string): bigint {
  if (typeof decimal !== "string") {
    throw new TypeError(`encodeRate: expected string, got ${typeof decimal}`)
  }
  const trimmed = decimal.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `encodeRate: malformed rate: ${JSON.stringify(decimal)}`
    )
  }

  const [whole, fractionRaw = ""] = trimmed.split(".")

  let scaled: bigint
  if (fractionRaw.length <= RATE_DECIMALS) {
    scaled = BigInt(whole + fractionRaw.padEnd(RATE_DECIMALS, "0"))
  } else {
    const base = BigInt(whole + fractionRaw.slice(0, RATE_DECIMALS))
    const rest = fractionRaw.slice(RATE_DECIMALS)
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
      `encodeRate: rate must be positive, got ${JSON.stringify(decimal)}`
    )
  }
  return scaled
}

/**
 * Render a scaled rate back to its minimal decimal string (inverse of
 * `encodeRate` for representable values). Trailing fraction zeros are stripped.
 */
export function decodeRate(rateScaled: bigint): string {
  if (rateScaled <= 0n) {
    throw new RangeError(`decodeRate: rate must be positive, got ${rateScaled}`)
  }
  const whole = rateScaled / RATE_SCALE
  const fraction = rateScaled % RATE_SCALE
  if (fraction === 0n) return whole.toString()
  // Strip trailing zeros from the fixed-width fraction WITHOUT a regex. The
  // input is bounded (exactly RATE_DECIMALS digits) so a regex was never a real
  // ReDoS risk, but an index walk is clearer and avoids the regex engine
  // entirely. `fraction !== 0n` here guarantees a non-empty result.
  const padded = fraction.toString().padStart(RATE_DECIMALS, "0")
  let end = padded.length
  while (end > 0 && padded[end - 1] === "0") end--
  return `${whole.toString()}.${padded.slice(0, end)}`
}

/**
 * Convert a signed minor-unit amount from `fromCurrency` into `toCurrency`
 * minor units using a scaled rate (major->major). Single banker's-rounding
 * step; preserves sign.
 *
 *   toMinor = round( fromMinor * rateScaled * toConv / (fromConv * RATE_SCALE) )
 */
export function convertMinor(
  fromMinor: Money | bigint,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rateScaled: bigint
): Money {
  if (rateScaled <= 0n) {
    throw new RangeError(
      `convertMinor: rateScaled must be positive, got ${rateScaled}`
    )
  }
  const fromConv = minorConversion(fromCurrency)
  const toConv = minorConversion(toCurrency)
  const numerator = (fromMinor as bigint) * rateScaled * toConv
  const denominator = fromConv * RATE_SCALE
  return toMoney(divRoundHalfEven(numerator, denominator))
}

/**
 * Derive the implied `source -> destination` rate (scaled) from the two native
 * leg amounts of a cross-currency transfer. The actual money that moved is
 * authoritative, so the rate is computed, never independently entered:
 *
 *   actualRate = destMajor / srcMajor
 *   rateScaled = round( |destMinor| * srcConv * RATE_SCALE / (|srcMinor| * destConv) )
 */
export function impliedRateScaled(
  srcMinor: Money | bigint,
  srcCurrency: CurrencyCode,
  destMinor: Money | bigint,
  destCurrency: CurrencyCode
): bigint {
  const src = srcMinor as bigint
  const dest = destMinor as bigint
  const absSrc = src < 0n ? -src : src
  const absDest = dest < 0n ? -dest : dest
  if (absSrc === 0n) {
    throw new RangeError("impliedRateScaled: source amount must be non-zero")
  }
  const srcConv = minorConversion(srcCurrency)
  const destConv = minorConversion(destCurrency)
  const numerator = absDest * srcConv * RATE_SCALE
  const denominator = absSrc * destConv
  return divRoundHalfEven(numerator, denominator)
}

/**
 * Compute the cross-currency fields recorded on a `Transfer` row (ADR-0035 §5):
 * the implied `source -> dest` rate plus the pair currencies. Same-currency
 * transfers carry no FX, so all three are `null`.
 */
export function deriveTransferFx(
  srcMinor: Money | bigint,
  srcCurrency: CurrencyCode,
  destMinor: Money | bigint,
  destCurrency: CurrencyCode
): {
  fxRateScaled: bigint | null
  fromCurrency: string | null
  toCurrency: string | null
} {
  if (srcCurrency === destCurrency) {
    return { fxRateScaled: null, fromCurrency: null, toCurrency: null }
  }
  return {
    fxRateScaled: impliedRateScaled(
      srcMinor,
      srcCurrency,
      destMinor,
      destCurrency
    ),
    fromCurrency: srcCurrency,
    toCurrency: destCurrency,
  }
}
