// =============================================================================
// ADR-0056 — Zakat Maal calculator: nisab (minimum threshold) value.
// =============================================================================
//
// Points of UNANIMOUS agreement across all four Sunni madhabs (safe to
// hard-code, per the ADR's research summary):
//   - Gold's own nisab:   20 mithqal = 87.48 grams EXACTLY (AAOIFI Shari'a
//     Standard No. 35). The popular "85 grams" figure some Indonesian
//     sources use is a rounding simplification, not a competing scholarly
//     position — this module always uses the precise 87.48g.
//   - Silver's own nisab: 612.36 grams (AAOIFI).
//   - Zakat rate: 2.5% (1/40) — see `ZAKAT_RATE_NUMERATOR`/`_DENOMINATOR`.
//
// Which METAL values a mixed cash/wealth portfolio (gold vs silver) IS a
// real, documented scholarly disagreement (Maliki/Shafi'i/Hanbali use gold;
// Hanafi and Qaradawi's Fiqh az-Zakat prefer silver as more precautionary) —
// that choice is `ZakatSettings.nisabBasis`, a user setting, never hard-coded
// here.
//
// All math is EXACT bigint arithmetic — no floating point anywhere, even as
// an intermediate step. `nisab_value = nisab_grams × price_per_gram`, and the
// nisab grams figures (87.48, 612.36) carry exactly 2 decimal digits, so they
// are represented as integers scaled by 100 and divided back out at the end
// with a single explicit rounding step. This mirrors the discipline already
// established in `src/lib/money.ts` (bigint minor units, explicit rounding
// mode) rather than reusing `mulMoney`'s float-scalar path, which is correct
// for a fractional TAX RATE but would reintroduce float imprecision for a
// value this load-bearing.
// =============================================================================

export type NisabBasis = "gold" | "silver"

/** Grams scaled ×100 (both figures carry exactly 2 decimal digits). */
const GRAMS_SCALE = 100n

/** 20 mithqal, per AAOIFI Shari'a Standard No. 35 — NOT the popular "85g"
 * rounding. */
export const GOLD_NISAB_GRAMS_SCALED = 8748n // 87.48 × 100
/** Per AAOIFI Shari'a Standard No. 35. */
export const SILVER_NISAB_GRAMS_SCALED = 61236n // 612.36 × 100

export const GOLD_NISAB_GRAMS = 87.48
export const SILVER_NISAB_GRAMS = 612.36

/** 2.5% (1/40) — unanimous across all four Sunni madhabs, no dispute. */
export const ZAKAT_RATE_NUMERATOR = 1n
export const ZAKAT_RATE_DENOMINATOR = 40n

/**
 * Round-half-to-even bigint division — the same convention `money.ts` and
 * `market-data.ts` use for scaled-integer conversions, so a Zakat figure
 * rounds the identical way every other monetary computation in this codebase
 * does. Sign-aware (handles a negative numerator correctly, though nisab/
 * Zakat math never produces one in practice).
 */
export function divRoundHalfEven(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) {
    throw new RangeError(
      `divRoundHalfEven: divisor must be positive, got ${divisor}`
    )
  }
  const negative = numerator < 0n
  const abs = negative ? -numerator : numerator
  const quotient = abs / divisor
  const remainder = abs % divisor
  const twice = remainder * 2n
  let rounded = quotient
  if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) {
    rounded = quotient + 1n
  }
  return negative ? -rounded : rounded
}

/**
 * `nisab_value = nisab_grams(basis) × pricePerGramMinor`, exact bigint math,
 * rounded half-to-even to the nearest minor unit. `pricePerGramMinor` is the
 * CURRENT market price of one gram of the chosen metal, in the family's
 * currency's minor units (the server layer derives this from the existing
 * gold market-data feed via `marketQuoteToHoldingPriceMinor` — see
 * `src/server/zakat.ts`).
 *
 * Throws on a non-positive price — a corrupt/zero price must fail loud, never
 * silently produce a nisab of zero (which would make everyone appear
 * obligated).
 */
export function computeNisabValue(
  basis: NisabBasis,
  pricePerGramMinor: bigint
): bigint {
  if (pricePerGramMinor <= 0n) {
    throw new RangeError(
      `computeNisabValue: pricePerGramMinor must be positive, got ${pricePerGramMinor}`
    )
  }
  const gramsScaled =
    basis === "gold" ? GOLD_NISAB_GRAMS_SCALED : SILVER_NISAB_GRAMS_SCALED
  return divRoundHalfEven(pricePerGramMinor * gramsScaled, GRAMS_SCALE)
}

/**
 * `2.5% of netWealthMinor`, exact bigint math, rounded half-to-even. Returns
 * 0 for a non-positive input (no negative Zakat).
 */
export function computeZakatDue(netWealthMinor: bigint): bigint {
  if (netWealthMinor <= 0n) return 0n
  return divRoundHalfEven(
    netWealthMinor * ZAKAT_RATE_NUMERATOR,
    ZAKAT_RATE_DENOMINATOR
  )
}
