import { toGregorian, toHijri } from "hijri-converter"

// =============================================================================
// ADR-0056 — Zakat Maal calculator: Hijri (Islamic lunar) calendar helpers.
// =============================================================================
//
// The Hawl (Zakat holding period) is ONE HIJRI YEAR, not a fixed 355-day
// Gregorian offset — the ADR explicitly forbids that shortcut ("a
// personal-finance app that gets Islamic dates approximately right is worse
// than one that is silent about them"). This module is a thin, pure wrapper
// around `hijri-converter` (MIT, zero runtime dependencies, a JS port of the
// widely-used Python `hijri-converter` library implementing the tabular
// Umm al-Qura calendar) — chosen over the alternatives evaluated for this
// feature specifically because it has NO transitive dependencies (unlike
// `moment-hijri`, which pulls in the large, maintenance-mode `moment`
// package for a single date-conversion need) while still being a real,
// well-regarded calendar implementation rather than a hand-rolled one.
//
// Hijri months alternate between 29 and 30 days DEPENDING ON THE SPECIFIC
// YEAR (the Umm al-Qura table, not a fixed pattern) — so "the same day next
// Hijri year" can land on a day that doesn't exist in that year's version of
// the month (e.g. day 30 of a month that has only 29 days that year). This
// mirrors Gregorian Feb 29 in a non-leap year, and is handled the same way:
// clamp to the month's actual last day rather than silently rolling into the
// next month (which is what naively calling the library's own
// `toGregorian(year, month, 30)` does when day 30 doesn't exist — verified
// directly against the library before writing this clamp).
// =============================================================================

const DAY_MS = 86_400_000

export interface HijriDate {
  year: number
  month: number // 1-12
  day: number
}

/** Truncate a Date to a UTC calendar day (midnight UTC) — Hijri conversion
 * operates on calendar days, never wall-clock time. */
function toUtcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
}

/** Convert a Gregorian `Date` (its UTC calendar day) to the equivalent Hijri
 * calendar date. */
export function gregorianToHijri(date: Date): HijriDate {
  const d = toUtcMidnight(date)
  const { hy, hm, hd } = toHijri(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate()
  )
  return { year: hy, month: hm, day: hd }
}

/** Convert a Hijri calendar date to the equivalent Gregorian `Date` (UTC
 * midnight). */
export function hijriToGregorian(hijri: HijriDate): Date {
  const { gy, gm, gd } = toGregorian(hijri.year, hijri.month, hijri.day)
  return new Date(Date.UTC(gy, gm - 1, gd))
}

/**
 * The Gregorian date of day 1 of a given Hijri (year, month) — used to
 * measure that month's real length without assuming a fixed 29/30 pattern.
 */
function startOfHijriMonthGregorian(year: number, month: number): Date {
  return hijriToGregorian({ year, month, day: 1 })
}

/** The next Hijri (year, month), wrapping month 12 into year+1 month 1. */
function nextHijriMonth(
  year: number,
  month: number
): { year: number; month: number } {
  return month === 12
    ? { year: year + 1, month: 1 }
    : { year, month: month + 1 }
}

/**
 * The real number of days in a specific Hijri (year, month) — derived from
 * the Gregorian distance between its first day and the next month's first
 * day (exact, table-driven; never assumes 29 or 30).
 */
export function daysInHijriMonth(year: number, month: number): number {
  const start = startOfHijriMonthGregorian(year, month)
  const next = nextHijriMonth(year, month)
  const end = startOfHijriMonthGregorian(next.year, next.month)
  return Math.round((end.getTime() - start.getTime()) / DAY_MS)
}

/**
 * Add a whole number of Hijri years to a Hijri date, clamping the day to the
 * target year's actual month length when the original day doesn't exist
 * there (e.g. day 30 of a month that has only 29 days in the target year).
 * `years` may be negative (subtracting years) for symmetry, though this
 * feature only ever adds forward.
 */
export function addHijriYears(hijri: HijriDate, years: number): HijriDate {
  const targetYear = hijri.year + years
  const maxDay = daysInHijriMonth(targetYear, hijri.month)
  return {
    year: targetYear,
    month: hijri.month,
    day: Math.min(hijri.day, maxDay),
  }
}

/**
 * The Gregorian date exactly `years` Hijri years after `date` — the Hawl
 * anniversary primitive every eligibility rule in this feature builds on.
 * Precise: converts to Hijri, adds whole Hijri years (with real month-length
 * clamping), converts back — never a fixed 354/355-day Gregorian offset.
 */
export function hijriAnniversary(date: Date, years = 1): Date {
  const hijri = gregorianToHijri(date)
  return hijriToGregorian(addHijriYears(hijri, years))
}

/**
 * The number of WHOLE Hijri years elapsed from `start` to `asOf` (floor —
 * 0 when `asOf` is before the first anniversary). Found by iteratively
 * advancing the anniversary date until it would exceed `asOf`; bounded to a
 * generous 200 iterations (200 Hijri years) so a corrupt/far-future input can
 * never loop unboundedly.
 */
export function wholeHijriYearsElapsed(start: Date, asOf: Date): number {
  if (asOf.getTime() < start.getTime()) return 0
  let years = 0
  for (let candidate = 1; candidate <= 200; candidate++) {
    const anniversary = hijriAnniversary(start, candidate)
    if (anniversary.getTime() > asOf.getTime()) break
    years = candidate
  }
  return years
}
