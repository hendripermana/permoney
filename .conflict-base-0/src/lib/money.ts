/**
 * Money — BigInt minor-units arithmetic + formatting.
 * =============================================================================
 *
 * Single source of truth for monetary operations. Storage everywhere is `bigint`
 * in **minor units** (sen for IDR, cents for USD, satoshi for BTC, troy oz for
 * XAU — driven by `CURRENCIES[code].minorUnitConversion`).
 *
 * Why bigint and not number?
 * --------------------------
 * IEEE 754 binary floats cannot exactly represent most decimal fractions, so
 * `0.1 + 0.2 === 0.30000000000000004`. Compounded over a ledger that does
 * millions of additions across years, the drift becomes user-visible and
 * un-auditable. BigInt is exact arbitrary-precision integer arithmetic —
 * the answer Stripe, Wise, and every hardened fintech reaches independently.
 *
 * Why per-currency scale?
 * -----------------------
 * Naive "everything is cents" breaks for JPY (no subunit) and BTC (8-decimal
 * subunit). Each currency carries its own `minorUnitConversion` from the
 * Maybe Finance / ISO 4217 dataset, looked up per row. Cross-currency math
 * is REJECTED by the type system — see `assertSameCurrency` below.
 *
 * Wire serialization
 * ------------------
 * `JSON.stringify(10n)` throws. We never let raw bigint cross JSON. Use
 * `encodeMoney`/`decodeMoney` at the server-fn boundary; once revived on the
 * client (in TanStack DB collection's `select` callback), the entire client
 * codebase deals with `bigint` natively.
 *
 * @see docs/adr/0001-money-type-migration.md
 */

import { CURRENCIES, type CurrencyCode } from "@/lib/data/currencies"

// =============================================================================
// Branded type — optional but signals intent at function signatures.
// =============================================================================

/**
 * Tagged `bigint` representing a minor-unit amount in some currency.
 *
 * The brand is erased at runtime (it's just a `bigint`). It exists to make
 * accidental mixing with raw `bigint` ids or counters a type error. Use
 * `toMoney(bigintValue)` at trust boundaries to mint a `Money`.
 *
 * NOTE: the brand does NOT encode the currency at the type level — currencies
 * are carried alongside as a separate field. Encoding currency in the type
 * would require a phantom-typed Money<C> which is overkill for this codebase
 * and produces noisy generic ergonomics. Per-call `assertSameCurrency` is the
 * pragmatic guard.
 */
export type Money = bigint & { readonly __money: unique symbol }

/** Mint a Money from a raw bigint (zero-cost; runtime no-op). */
export function toMoney(value: bigint): Money {
  return value as Money
}

/** Constant zero, useful as initial value for sums. */
export const ZERO_MONEY: Money = 0n as Money

// =============================================================================
// Wire (de)serialization
// =============================================================================

/**
 * Convert a Money to a string suitable for JSON transport.
 *
 * Uses `bigint.toString()` (radix 10, no scientific notation) so the wire
 * value is unambiguous and round-trip safe. Negative amounts are encoded
 * with a leading `-`.
 */
export function encodeMoney(m: Money | bigint): string {
  return m.toString()
}

/**
 * Parse a wire string back to Money. Strict: throws on malformed input
 * rather than silently zero-ing — corrupt money data should fail loud.
 */
export function decodeMoney(wire: string): Money {
  if (typeof wire !== "string" || wire.length === 0) {
    throw new TypeError(
      `decodeMoney: expected non-empty string, got ${typeof wire}`
    )
  }
  if (!/^-?\d+$/.test(wire)) {
    throw new TypeError(
      `decodeMoney: malformed bigint string: ${JSON.stringify(wire)}`
    )
  }
  return BigInt(wire) as Money
}

/** Predicate variant — useful for boundary validation. */
export function isWireMoney(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value)
}

// =============================================================================
// Conversion: human-readable string  ↔  Money (minor units)
// =============================================================================

/**
 * Convert a decimal string ("100.50", "15000", "-12.34") to Money in the
 * given currency's minor units.
 *
 * Strict: rejects empty strings, exponent notation, multiple signs,
 * fractional digits beyond the currency's precision (we throw rather than
 * silently truncate, because silent truncation in money is a bug surface).
 *
 * Accepts:
 *   - "100"      → 10000n for USD (×100)
 *   - "100.5"    → 10050n for USD
 *   - "100.50"   → 10050n for USD
 *   - "-12.34"   → -1234n for USD
 *   - "100"      → 100n   for JPY (×1)
 *   - "0.001"    → throws for USD (3 fraction digits, USD precision is 2)
 *   - "0.001"    → 100000n for BTC (×100_000_000, max 8 fraction digits)
 *   - "1e5"      → throws (no exponents)
 *   - "1,000.50" → throws (no separators — the form layer strips them)
 */
export function toMinorUnits(decimal: string, currency: CurrencyCode): Money {
  if (typeof decimal !== "string") {
    throw new TypeError(`toMinorUnits: expected string, got ${typeof decimal}`)
  }
  const trimmed = decimal.trim()
  if (trimmed === "") {
    throw new TypeError("toMinorUnits: empty string")
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `toMinorUnits: malformed decimal: ${JSON.stringify(decimal)} (use parseUserInput for user-formatted strings)`
    )
  }

  const def = CURRENCIES[currency]
  const conversion = BigInt(def.minorUnitConversion)
  const precision = decimalPlacesOf(def.minorUnitConversion)

  const negative = trimmed.startsWith("-")
  const body = negative ? trimmed.slice(1) : trimmed
  const [whole, fractionRaw = ""] = body.split(".")

  if (fractionRaw.length > precision) {
    throw new RangeError(
      `toMinorUnits: ${currency} supports ${precision} fraction digit(s), got ${fractionRaw.length} in ${JSON.stringify(decimal)}`
    )
  }

  // Pad fraction with trailing zeros up to the currency's precision so we can
  // concatenate (whole + fraction) and treat the result as a single bigint.
  const fraction = fractionRaw.padEnd(precision, "0")
  const combined = (whole === "" ? "0" : whole) + fraction
  const minor = BigInt(combined)
  void conversion // sanity — kept for documentation; final bigint is exact by construction
  return (negative ? -minor : minor) as Money
}

/**
 * Inverse of {@link toMinorUnits}: render a Money as a CANONICAL major-unit
 * decimal string (dot decimal, NO thousands separators, trailing zeros
 * trimmed) — e.g. `10050n` USD → `"100.5"`, `500000n` IDR → `"5000"`.
 *
 * Exact for every power-of-10 currency (all realistic ones): it does bigint
 * division, never `Number`, so large IDR balances never lose precision. Use
 * this to feed a parsed `Money` back into a server contract that accepts a
 * major-unit decimal string (e.g. `upsertHoldingFn`), so the value the user
 * saw in the live preview is exactly what gets re-parsed server-side.
 */
export function toDecimalString(
  money: Money | bigint,
  currency: CurrencyCode
): string {
  const def = CURRENCIES[currency]
  const conv = BigInt(def.minorUnitConversion)
  const m = money as bigint
  const negative = m < 0n
  const abs = negative ? -m : m
  const sign = negative ? "-" : ""
  if (conv === 1n) return sign + abs.toString()
  const whole = abs / conv
  const fraction = abs % conv
  // Width = decimal places = digits of the (power-of-10) conversion minus one.
  const width = def.minorUnitConversion.toString().length - 1
  const fractionStr = fraction
    .toString()
    .padStart(width, "0")
    .replace(/0+$/, "")
  return sign + whole.toString() + (fractionStr === "" ? "" : `.${fractionStr}`)
}

/**
 * Convert Money back to a structured decimal representation.
 *
 * Returns `{ whole, fraction, isNegative }` so display layers can format
 * with locale-appropriate separators without ever re-introducing `number`
 * for the integer part (which could overflow MAX_SAFE_INTEGER for very
 * large balances or low-precision currencies).
 *
 * For display-only contexts where Number precision is acceptable (charts,
 * CSV exports), use `toDisplayNumber`.
 */
export function fromMinorUnits(
  money: Money | bigint,
  currency: CurrencyCode
): { whole: bigint; fraction: number; isNegative: boolean } {
  const def = CURRENCIES[currency]
  const m = money as bigint
  const isNegative = m < 0n
  const abs = isNegative ? -m : m
  const conv = BigInt(def.minorUnitConversion)
  if (conv === 1n) {
    return { whole: abs, fraction: 0, isNegative }
  }
  const whole = abs / conv
  const fractionBigInt = abs % conv
  // `fraction` is < `minorUnitConversion` ≤ 10^8 (BTC), well below MAX_SAFE_INTEGER.
  return { whole, fraction: Number(fractionBigInt), isNegative }
}

/**
 * Lossy convenience for chart/CSV/legacy consumers. May lose precision for
 * amounts above `Number.MAX_SAFE_INTEGER / minorUnitConversion`.
 *
 * For USD that's ~$90 trillion — fine for charts. For BTC (8 decimals) that's
 * ~90M BTC — also fine. For IDR (2 decimals) that's ~Rp 90 quadrillion —
 * fine. We log a warning if the amount actually exceeds the safe range,
 * because at that scale the user genuinely needs to know.
 */
export function toDisplayNumber(
  money: Money | bigint,
  currency: CurrencyCode
): number {
  const def = CURRENCIES[currency]
  const m = money as bigint
  const isNegative = m < 0n
  const abs = isNegative ? -m : m
  // Convert via string division to preserve precision up to MAX_SAFE_INTEGER.
  const conv = BigInt(def.minorUnitConversion)
  const whole = abs / conv
  const fraction = abs % conv

  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    // eslint-disable-next-line no-console
    console.warn(
      `toDisplayNumber: ${currency} amount ${money.toString()} exceeds Number.MAX_SAFE_INTEGER — precision loss possible`
    )
  }

  const wholeNum = Number(whole)
  const fractionNum = Number(fraction) / def.minorUnitConversion
  const result = wholeNum + fractionNum
  return isNegative ? -result : result
}

// =============================================================================
// User-input parsing — tolerant of locale separators, currency symbols, etc.
// =============================================================================

/**
 * Locale-agnostic, forgiving money parser — the single source of truth for
 * turning any human-typed amount into `Money` minor units.
 * =============================================================================
 *
 * WHY flag-independent (does NOT read `CURRENCIES[c].delimiter`/`.separator`)?
 * --------------------------------------------------------------------------
 * The app DISPLAYS money via `Intl.NumberFormat` defaulting to en-US
 * (`Rp 5,085,360.00` — comma thousands, dot decimal), regardless of the
 * currency's Indonesian `separator`/`delimiter` metadata. If we parsed using
 * those per-currency flags, the exact string the user just READ and retyped
 * (`5,085,360.00`) would be misparsed — for IDR the `.` would be treated as a
 * thousands delimiter, stripping the decimal and inflating the value 100×
 * (PER-240). So parsing must NOT depend on the currency's locale flags. It
 * auto-detects the decimal separator from the string's own shape instead.
 *
 * ALGORITHM
 * ---------
 * 1. Trim; strip a leading currency symbol (`def.symbol`, e.g. `Rp`, `$`) and
 *    /or ISO-code prefix (in either order relative to a leading `-`); strip
 *    ALL internal whitespace; extract an optional single leading `-`.
 * 2. Consider only `.` and `,` as possible separators. Decide which is the
 *    DECIMAL separator:
 *      - BOTH occur → the LAST-occurring of the two is decimal, the other is
 *        thousands (handles both `5,085,360.00` US and `5.085.360,00` ID).
 *        The decimal separator must occur exactly once.
 *      - ONE type occurs:
 *          · more than once → thousands separator, no decimal (`15.000.000`).
 *          · exactly once → DECIMAL, UNLESS it has exactly 3 trailing digits
 *            AND ≥1 leading digit (`5,000` / `5.000`), which is treated as
 *            THOUSANDS (finance convention — critical so an Indonesian typing
 *            `Rp 5.000` dot-thousands is NOT rejected as over-precision).
 *            Everything else (`1000,00`, `1000.00`, `1000,5`, `0.32`, `.32`)
 *            is DECIMAL.
 * 3. When a thousands separator is present, validate the integer grouping
 *    (first group 1-3 digits, every later group exactly 3) so garbage like
 *    `1.2.3` is rejected rather than silently concatenated.
 * 4. Remove the thousands separator; normalize the decimal separator to `.`;
 *    prepend a `0` to a leading-dot value (`.32` → `0.32`); then delegate to
 *    `toMinorUnits` (which enforces `minorUnitConversion` + max fraction
 *    digits). Return `null` on ANY malformed / over-precision input; never
 *    throw.
 *
 * NOTE on the single-separator finance convention: for a currency that cannot
 * represent 3 fraction digits (fiat — IDR/USD 2dp, JPY 0dp), `1.234` (single
 * dot, 3 trailing digits) parses as **1,234** (thousands), NOT an over-
 * precision `1.234` → null — symmetric with `5,000`/`5.000`, matching the
 * dominant real-world Indonesian `Rp 5.000` input. For a high-precision
 * currency (BTC, 8dp) the SAME `1.234` stays a genuine decimal (1.234), so the
 * value is never 1000×-inflated. The rule is precision-aware. See PER-240.
 */
export function parseMoneyInput(
  raw: string,
  currency: CurrencyCode
): Money | null {
  if (typeof raw !== "string") return null
  const def = CURRENCIES[currency]

  // --- Step 1: normalize surface (symbol/ISO/whitespace/sign) ----------------
  let body = raw.trim()
  if (body === "") return null
  // Collapse all internal whitespace first ("1 000 000", "$ 100", "Rp 5.000").
  body = body.replace(/\s+/g, "")

  // Strip a leading currency symbol / ISO code that may appear before OR after
  // a leading sign ("$-100.50", "-$100"). Peel prefixes, then a single sign,
  // then prefixes again to cover both orderings.
  const stripPrefixes = (s: string): string => {
    let changed = true
    while (changed) {
      changed = false
      if (def.symbol !== "" && s.startsWith(def.symbol)) {
        s = s.slice(def.symbol.length)
        changed = true
      } else if (s.toUpperCase().startsWith(currency)) {
        s = s.slice(currency.length)
        changed = true
      }
    }
    return s
  }

  body = stripPrefixes(body)
  let negative = false
  if (body.startsWith("-")) {
    negative = true
    body = body.slice(1)
  }
  body = stripPrefixes(body)

  if (body === "") return null
  // Only digits and the two candidate separators may remain.
  if (!/^[0-9.,]+$/.test(body)) return null

  // --- Step 2: decide the decimal separator from the string's own shape ------
  const dotCount = (body.match(/\./g) ?? []).length
  const commaCount = (body.match(/,/g) ?? []).length

  let decSep: "." | "," | null = null
  let thouSep: "." | "," | null = null

  if (dotCount > 0 && commaCount > 0) {
    // Last-occurring separator is the decimal; the other is thousands.
    decSep = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ","
    thouSep = decSep === "." ? "," : "."
    const decCount = decSep === "." ? dotCount : commaCount
    if (decCount !== 1) return null // decimal separator must be unique
  } else if (dotCount > 0 || commaCount > 0) {
    const sep: "." | "," = dotCount > 0 ? "." : ","
    const count = dotCount > 0 ? dotCount : commaCount
    if (count > 1) {
      thouSep = sep // repeated single type → grouping only
    } else {
      const idx = body.indexOf(sep)
      const leading = body.slice(0, idx)
      const trailing = body.slice(idx + 1)
      // A single separator with exactly 3 trailing digits ("5,000" / "5.000")
      // is the finance-convention thousands group — BUT only for a currency
      // that cannot represent 3 fraction digits (fiat: IDR/USD 2dp, JPY 0dp).
      // For a high-precision currency (BTC, 8dp) "1.234" is a genuine decimal
      // amount, so it must stay decimal. Precision-aware disambiguation keeps
      // the IDR `Rp 5.000`→5000 reading while never 1000×-inflating BTC.
      const maxFraction = decimalPlacesOf(def.minorUnitConversion)
      if (/^\d{3}$/.test(trailing) && /\d/.test(leading) && maxFraction < 3) {
        thouSep = sep // "5,000" / "5.000" → thousands (fiat only)
      } else {
        decSep = sep // "1000.00", "0.32", ".32", "1000,5", BTC "1.234" → decimal
      }
    }
  }

  // --- Step 3: split integer / fraction and validate thousands grouping ------
  let integerPart: string
  let fractionPart: string | null = null
  if (decSep !== null) {
    const idx = body.indexOf(decSep)
    integerPart = body.slice(0, idx)
    fractionPart = body.slice(idx + 1)
  } else {
    integerPart = body
  }

  if (thouSep !== null) {
    const groups = integerPart.split(thouSep)
    if (groups.length < 2) return null
    const [first, ...rest] = groups
    if (!/^\d{1,3}$/.test(first)) return null
    if (!rest.every((g) => /^\d{3}$/.test(g))) return null
    integerPart = groups.join("")
  }

  // --- Step 4: build a canonical decimal string and delegate -----------------
  if (integerPart === "") integerPart = "0" // ".32" → "0.32"
  if (!/^\d+$/.test(integerPart)) return null
  if (fractionPart !== null && !/^\d*$/.test(fractionPart)) return null

  const normalized =
    (negative ? "-" : "") +
    integerPart +
    (fractionPart !== null ? `.${fractionPart}` : "")

  try {
    return toMinorUnits(normalized, currency)
  } catch {
    return null
  }
}

/**
 * @deprecated Prefer {@link parseMoneyInput}. Retained as a thin alias so the
 * existing call sites keep working; it now delegates to the locale-agnostic
 * parser (PER-240) — the currency's `separator`/`delimiter` flags are NO
 * LONGER consulted for parsing.
 */
export function parseUserInput(
  raw: string,
  currency: CurrencyCode
): Money | null {
  return parseMoneyInput(raw, currency)
}

// =============================================================================
// Display formatting
// =============================================================================

export interface FormatMoneyOptions {
  /** BCP 47 locale tag. Defaults to user's runtime locale (or "en-US" on server). */
  readonly locale?: string
  /** Whether to include the symbol (default true). */
  readonly showSymbol?: boolean
  /** Compact notation for large numbers ("Rp 1,2 jt"). Default false. */
  readonly compact?: boolean
}

/**
 * Format Money for display using `Intl.NumberFormat`. Locale-aware.
 *
 * Uses the runtime's `Intl` for separator/grouping rules rather than re-
 * implementing them from `currency.separator/delimiter` — `Intl` understands
 * locale-specific quirks (Swiss French uses ' as thousands separator) better
 * than the YAML data could.
 */
export function formatMoney(
  money: Money | bigint,
  currency: CurrencyCode,
  options: FormatMoneyOptions = {}
): string {
  const { locale, showSymbol = true, compact = false } = options
  const def = CURRENCIES[currency]
  const num = toDisplayNumber(money, currency)

  // If the currency has an Intl-recognized ISO code, leverage native
  // `style: "currency"` — gives correct symbol placement, narrowSymbol form,
  // and locale-appropriate grouping. For metals (XAU/XAG) and crypto (BTC),
  // `Intl.NumberFormat` will throw — fall back to manual format.
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: showSymbol ? "currency" : "decimal",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: def.defaultPrecision,
      maximumFractionDigits: def.defaultPrecision,
      notation: compact ? "compact" : "standard",
    })
    return formatter.format(num)
  } catch {
    // Manual fallback for non-ISO codes (XAU, XAG, BTC, etc.)
    const sign = num < 0 ? "-" : ""
    const absStr = Math.abs(num).toFixed(def.defaultPrecision)
    return showSymbol
      ? def.defaultFormat
          .replace("%u", def.symbol)
          .replace("%n", `${sign}${absStr}`)
      : `${sign}${absStr}`
  }
}

// =============================================================================
// Arithmetic — every operator returns Money, never `number`.
// =============================================================================

export function addMoney(a: Money | bigint, b: Money | bigint): Money {
  return (a + b) as Money
}

export function subMoney(a: Money | bigint, b: Money | bigint): Money {
  return (a - b) as Money
}

export function negateMoney(a: Money | bigint): Money {
  // Cast through bigint to bypass the branded-type unary-minus lint rule:
  // `-Money` is well-defined at runtime (Money is bigint), but oxlint's
  // strict mode rejects unary ops on nominal brands without an explicit hop.
  return -(a as bigint) as Money
}

export function absMoney(a: Money | bigint): Money {
  const b = a as bigint
  return (b < 0n ? -b : b) as Money
}

/**
 * Multiply Money by a scalar (e.g. 0.1 for 10% tax). Uses **banker's rounding**
 * (round half to even) for fractional results — the IEEE 754 default and the
 * standard for financial calculations to avoid bias when summing many rounded
 * values.
 *
 * The scalar is `number` because tax rates, FX rates, and percentage shares
 * are inherently fractional. We multiply in a high-precision intermediate
 * (scale by 1e9) then divide back, keeping the bigint domain throughout.
 */
export function mulMoney(a: Money | bigint, scalar: number): Money {
  if (!Number.isFinite(scalar)) {
    throw new RangeError(`mulMoney: scalar must be finite, got ${scalar}`)
  }
  // 1e9 chosen so we have 9 digits of scalar precision (enough for any
  // realistic tax/FX rate) without overflowing the intermediate bigint.
  const SCALE = 1_000_000_000n
  const scaled = BigInt(Math.round(scalar * 1_000_000_000))
  const product = a * scaled
  // Banker's rounding: use round-half-to-even. Apply only when there's a
  // remainder; otherwise the divide is exact.
  const quotient = product / SCALE
  const remainder = product % SCALE
  if (remainder === 0n) return quotient as Money

  // Half-comparison must respect sign of the remainder.
  const halfScale = SCALE / 2n
  const absRem = remainder < 0n ? -remainder : remainder

  if (absRem < halfScale) return quotient as Money
  if (absRem > halfScale) {
    return (remainder > 0n ? quotient + 1n : quotient - 1n) as Money
  }
  // Exactly half — round to even.
  if (quotient % 2n === 0n) return quotient as Money
  return (remainder > 0n ? quotient + 1n : quotient - 1n) as Money
}

/** Sum a sequence of Money values. Returns 0n on empty iterables. */
export function sumMoney(items: Iterable<Money | bigint>): Money {
  let acc = 0n
  for (const item of items) acc += item
  return acc as Money
}

// =============================================================================
// Cross-currency safety
// =============================================================================

/**
 * Throws if two amounts are in different currencies. Use before any binary
 * arithmetic on Money values that originated from different rows.
 */
export function assertSameCurrency(
  a: CurrencyCode,
  b: CurrencyCode,
  context = "money operation"
): void {
  if (a !== b) {
    throw new Error(
      `Cross-currency ${context} not supported: ${a} vs ${b}. Use FX conversion first (Phase B).`
    )
  }
}

// =============================================================================
// Internals
// =============================================================================

/**
 * Compute the number of decimal places represented by a `minorUnitConversion`
 * value. 100 → 2, 1000 → 3, 100_000_000 → 8, 1 → 0.
 *
 * Validates that the conversion is a positive power of 10; non-power-of-10
 * conversions don't fit our decimal-string parsing model and indicate
 * corrupt currency metadata.
 */
function decimalPlacesOf(conversion: number): number {
  if (!Number.isInteger(conversion) || conversion < 1) {
    throw new RangeError(
      `Invalid minorUnitConversion: ${conversion} (must be positive integer)`
    )
  }
  if (conversion === 1) return 0
  let n = conversion
  let places = 0
  while (n > 1) {
    if (n % 10 !== 0) {
      throw new RangeError(
        `minorUnitConversion ${conversion} is not a power of 10`
      )
    }
    n = n / 10
    places++
  }
  return places
}
