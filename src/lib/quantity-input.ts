/**
 * Quantity (units) text-input parsing — the quantity twin of `parseMoneyInput`.
 * =============================================================================
 *
 * Why this exists. `quantityToScaled` (src/lib/holdings.ts) is the STRICT
 * server-contract parser: it accepts only canonical dot-decimal text
 * (`/^\d+(\.\d+)?$/`) and stays exactly that. A person typing units by hand is
 * not canonical: an Indonesian user writes `1.354` meaning "one thousand three
 * hundred fifty-four" (dot = thousands separator; Bibit even displays
 * `1.354,5432`), and the strict parser silently read it as 1.354 units — a
 * 1000x error with no message. Permoney is global, so `1,354.5` (en-US) and
 * `1.354,5` (id-ID) both exist and neither may be assumed. This module turns
 * raw text into either ONE canonical dot-decimal string (which always satisfies
 * `quantityToScaled`), an explicit AMBIGUOUS result the UI must resolve with the
 * user, or an error. It never guesses silently.
 *
 * Rules (units are non-negative, so no sign is accepted):
 *  1. Trim. Ordinary / non-breaking / thin spaces are allowed ONLY as grouping
 *     inside the integer part (`1 354,5`, groups of exactly 3 digits after the
 *     first); any other stray space is invalid. Digits, `.` and `,` are the only
 *     other characters; letters, signs and symbols are rejected.
 *  2. BOTH `.` and `,` present: the LAST one is the decimal separator; the other
 *     must be a valid thousands separator (integer part = 1–3 digits, then
 *     groups of exactly 3). `1.354,5432` and `1,354.5432` both read 1354.5432.
 *  3. ONE kind of separator, more than once (`1.354.000`, `1,354,000`): it is a
 *     thousands separator; groups must be exactly 3 digits -> `1354000`.
 *  4. ONE separator, exactly once:
 *       - the integer part starts with `0` (`0.123`, `0,123`): decimal — a
 *         thousands group can never start with 0.
 *       - followed by exactly 3 digits AND preceded by 1–3 digits
 *         (`1.354`, `1,354`, `12.500`): AMBIGUOUS. Both readings are returned
 *         (decimal first, thousands second) and the caller must ask the user.
 *       - anything else (`1.35`, `1,3545`, `12.5`, `1354,5`): decimal.
 *  5. At most 8 fraction digits (`QUANTITY_SCALE_DIGITS`, the column scale).
 *  6. A separator with nothing after it (`1354.`) or a lone separator is
 *     invalid (usually a half-typed number); a leading separator (`.5`) is a
 *     decimal with an implied leading zero.
 *
 * The returned canonical `value` (leading zeros in the integer part stripped,
 * fraction digits kept exactly as typed) is guaranteed to satisfy
 * `quantityToScaled`; the server contract is untouched.
 *
 * Pure and framework-free — unit-tested in quantity-input.test.ts.
 */

/** Column scale (Decimal(38, 8)); mirrors QUANTITY_SCALE_DIGITS in holdings.ts. */
const MAX_FRACTION_DIGITS = 8

export type QuantityParseResult =
  | { status: "empty" }
  | {
      status: "ok"
      /** Canonical dot-decimal text, e.g. "1354.5432". Always quantityToScaled-safe. */
      value: string
    }
  | {
      status: "ambiguous"
      /**
       * BOTH canonical readings of the same text: [decimal reading, thousands
       * reading], e.g. `1.354` -> ["1.354", "1354"].
       */
      candidates: [string, string]
    }
  | {
      status: "invalid"
      /** User-facing English explanation. */
      reason: string
    }

// Grouping spaces: ordinary, no-break (U+00A0), thin (U+2009) and narrow
// no-break (U+202F). Built from code points so the invisible characters stay
// explicit in the source (formatters otherwise inline them as raw glyphs).
const GROUPING_SPACE_CLASS = `[${String.fromCodePoint(0x20, 0xa0, 0x2009, 0x202f)}]`
const GROUPING_SPACE_ANYWHERE = new RegExp(GROUPING_SPACE_CLASS)
const GROUPING_SPACES_GLOBAL = new RegExp(GROUPING_SPACE_CLASS, "g")
const GROUPED_INTEGER_PREFIX = new RegExp(
  `^(\\d{1,3}(?:${GROUPING_SPACE_CLASS}\\d{3})+)(?=[.,]|$)`
)
// U+2212 MINUS SIGN — what some keyboards/autocorrect produce instead of "-".
const MINUS = String.fromCodePoint(0x2212)

const INVALID_CHARACTERS =
  "Use digits only, with . or , as the decimal or thousands separator."
const INVALID_GROUPING =
  "Thousands groups must have exactly 3 digits (for example 1,354,000 or 1.354.000)."

function invalid(reason: string): QuantityParseResult {
  return { status: "invalid", reason }
}

/** Strip leading zeros of an integer string but keep a single "0". */
function normalizeInteger(digits: string): string {
  const stripped = digits.replace(/^0+(?=\d)/, "")
  return stripped === "" ? "0" : stripped
}

/**
 * Validate a thousands-grouped integer (`1.354.000` split on its separator):
 * first group 1–3 digits and not starting with 0 (unless it is the only group),
 * every following group exactly 3 digits. Returns the joined digits or null.
 */
function joinThousandsGroups(groups: ReadonlyArray<string>): string | null {
  const [first, ...rest] = groups
  if (first === undefined || !/^\d{1,3}$/.test(first)) return null
  if (groups.length > 1 && first.startsWith("0")) return null
  if (!rest.every((group) => /^\d{3}$/.test(group))) return null
  return groups.join("")
}

function decimalResult(
  integerDigits: string,
  fraction: string
): QuantityParseResult {
  if (fraction.length > MAX_FRACTION_DIGITS) {
    return invalid(
      `At most ${MAX_FRACTION_DIGITS} decimal places are supported (you entered ${fraction.length}).`
    )
  }
  return {
    status: "ok",
    value:
      fraction === ""
        ? normalizeInteger(integerDigits)
        : `${normalizeInteger(integerDigits)}.${fraction}`,
  }
}

export function parseQuantityInput(raw: string): QuantityParseResult {
  let text = raw.trim()
  if (text === "") return { status: "empty" }

  if (text.startsWith("-") || text.startsWith("+") || text.startsWith(MINUS)) {
    return invalid("Quantity can't be negative or signed — enter units only.")
  }

  // Rule 1 — spaces are legal only as thousands grouping inside the integer
  // part (`1 354`, `12 345 678,5`). Collapse exactly that prefix, then any
  // remaining whitespace is a stray space.
  if (GROUPING_SPACE_ANYWHERE.test(text)) {
    const prefix = GROUPED_INTEGER_PREFIX.exec(text)?.[1]
    if (prefix === undefined) {
      return invalid(
        "Spaces are only allowed to group thousands (for example 1 354,5)."
      )
    }
    text =
      prefix.replace(GROUPING_SPACES_GLOBAL, "") + text.slice(prefix.length)
  }

  if (!/^[\d.,]+$/.test(text)) return invalid(INVALID_CHARACTERS)

  const dotCount = text.split(".").length - 1
  const commaCount = text.split(",").length - 1

  // Rule 2 — both separators present: the last one is the decimal separator.
  if (dotCount > 0 && commaCount > 0) {
    const decimalChar =
      text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ","
    const thousandsChar = decimalChar === "." ? "," : "."
    const decimalIndex = text.lastIndexOf(decimalChar)
    const integerPart = text.slice(0, decimalIndex)
    const fraction = text.slice(decimalIndex + 1)
    // Nothing can follow the LAST separator but digits (rule 1 filtered the rest).
    if (fraction === "")
      return invalid("Add digits after the decimal separator.")
    const digits = joinThousandsGroups(integerPart.split(thousandsChar))
    if (digits === null) return invalid(INVALID_GROUPING)
    return decimalResult(digits, fraction)
  }

  // Plain integer.
  if (dotCount === 0 && commaCount === 0) {
    return decimalResult(text, "")
  }

  const separator = dotCount > 0 ? "." : ","
  const separatorCount = dotCount + commaCount

  // Rule 3 — the same separator repeated is a thousands separator.
  if (separatorCount > 1) {
    const digits = joinThousandsGroups(text.split(separator))
    if (digits === null) return invalid(INVALID_GROUPING)
    return decimalResult(digits, "")
  }

  // Rule 4 — exactly one separator.
  const separatorIndex = text.indexOf(separator)
  const before = text.slice(0, separatorIndex)
  const after = text.slice(separatorIndex + 1)
  if (after === "") return invalid("Add digits after the decimal separator.")

  // A thousands group can never start with 0, and an empty integer part is a
  // bare decimal (`.5`) — both are unambiguously decimal.
  if (before === "" || before.startsWith("0")) {
    return decimalResult(before === "" ? "0" : before, after)
  }

  if (after.length === 3 && before.length >= 1 && before.length <= 3) {
    const decimalReading = decimalResult(before, after)
    if (decimalReading.status !== "ok") return decimalReading
    return {
      status: "ambiguous",
      candidates: [decimalReading.value, normalizeInteger(before + after)],
    }
  }

  return decimalResult(before, after)
}

/**
 * Text to write into the field when the user picks one ambiguity candidate (or
 * when prefilling a stored quantity): the candidate itself, except that a
 * decimal reading like "1.354" would re-parse as ambiguous, so a harmless
 * trailing zero ("1.3540" — same value) makes it unambiguous.
 */
export function unambiguousQuantityText(canonical: string): string {
  return parseQuantityInput(canonical).status === "ambiguous"
    ? `${canonical}0`
    : canonical
}

/**
 * en-US grouping for a canonical dot-decimal quantity, preserving the digits as
 * typed (no rounding, no fraction trimming): "1354.5432" -> "1,354.5432".
 */
export function formatQuantityGrouped(canonical: string): string {
  const [whole = "0", fraction] = canonical.split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
] as const

function belowThousandInWords(n: number): string {
  const parts: Array<string> = []
  const hundreds = Math.floor(n / 100)
  const remainder = n % 100
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`)
  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(ONES[remainder] ?? "")
    } else {
      const ten = TENS[Math.floor(remainder / 10)] ?? ""
      const one = remainder % 10
      parts.push(one === 0 ? ten : `${ten}-${ONES[one]}`)
    }
  }
  return parts.join(" ")
}

/**
 * English words for a canonical quantity of up to 999,999 whole units, with the
 * fraction spelled digit by digit ("1354" -> "one thousand three hundred
 * fifty-four", "1.354" -> "one point three five four"). Used to let a
 * non-technical user tell the two ambiguity readings apart; returns null for
 * anything larger than the ambiguity prompt can produce.
 */
export function quantityInWords(canonical: string): string | null {
  const [wholeText = "", fraction] = canonical.split(".")
  if (!/^\d{1,6}$/.test(wholeText)) return null
  const whole = Number(wholeText)
  const thousands = Math.floor(whole / 1000)
  const rest = whole % 1000
  const parts: Array<string> = []
  if (thousands > 0) parts.push(`${belowThousandInWords(thousands)} thousand`)
  if (rest > 0) parts.push(belowThousandInWords(rest))
  const wholeWords = parts.length === 0 ? "zero" : parts.join(" ")
  if (fraction === undefined) return wholeWords
  const digits = [...fraction].map((digit) => ONES[Number(digit)]).join(" ")
  return `${wholeWords} point ${digits}`
}
