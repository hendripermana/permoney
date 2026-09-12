import { type AccountRunway } from "./account-runway"
import {
  type RecurringCadence,
  type RecurringDirection,
  type RecurringSeries,
} from "./account-recurring"

// =============================================================================
// PER-263 fast-follow — "cash-flow forecast": account intelligence layer, next
// slice after runway (PER-222) and recurring detection (PER-225 Slice 4a).
//
// Runway (PER-222) answers "at my trailing average pace, when do I dip below
// my floor?" purely from a smoothed daily average. Recurring (PER-225) answers
// "what bills/income repeat, and when is the next one?" purely from discrete
// occurrences. Neither alone is causal: runway can't say WHY a dip happens,
// and recurring alone doesn't know the account's other day-to-day noise.
//
// This module fuses them into one day-by-day projection so the UI can say
// something like "dips below reserve around Sep 28, mainly your BPJS payment,
// before salary lands Oct 1" — a causal story, not just a number.
//
// THE DOUBLE-COUNTING TRAP (read this before touching the math below):
// `runway.netDailyFlowMinor` is a TRAILING AVERAGE over the account's real
// ledger — it already implicitly bakes in every recurring series' past
// occurrences (they are part of the same transaction history the average was
// computed from). If we naively added discrete future recurring events ON TOP
// of that average, every recurring flow would be counted twice: once
// smoothed into the average, once again as a discrete event. The fix: back
// each series' own average daily contribution out of the trailing average
// first (`backgroundDailyMinor = netDailyFlowMinor − recurringDailyMinor`),
// then walk forward day by day adding ONLY the background rate plus whatever
// discrete events land on that exact day. See `computeAccountCashFlowForecast`.
//
// Client-side, pure, no server/DB — same discipline as account-runway.ts and
// account-recurring.ts: bigint minor units for all money math; Number is used
// only for the day-count / averaging arithmetic that money math requires
// (rounded back to bigint immediately, same pattern as computeAccountRunway's
// own `netDailyFlowMinor`), never left as a floating-point money value.
//
// RESERVE-FRAMING DIVISION OF RESPONSIBILITY (important, don't relitigate):
// PR #341 fixed a production bug where "below reserve" alerting fired for
// accounts with NO configured reserve, because a null reserve silently
// defaulted to 0 and any positive balance trivially counted as "above" while
// any dip to exactly 0 read as "below" — a false alarm dressed up as a real
// one. This module does NOT repeat that mistake, but it also doesn't hide the
// math to avoid it: `projectedReserveBreachDate` is ALWAYS computed
// mathematically against whatever `reserveMinor` the caller passes in
// (callers pass `0n` when no reserve is configured, exactly like
// `computeAccountRunway` already does). It is the UI layer's job — not this
// module's — to check `hasReserve(reserveBalance)` before using "reserve
// breach" language; when there is no configured reserve, the UI must fall
// back to "runway to empty" framing instead. Keeping the gate in the UI (not
// duplicated in every pure-math caller) keeps this module a single source of
// truth for the arithmetic while the presentation layer alone decides how to
// talk about it.
// =============================================================================

const DAY_MS = 86_400_000

/** Minimum occurrence count below which a series' contribution is flagged
 * low-confidence in the forecast — matches the discipline elsewhere in the
 * account-intelligence family (see account-runway.ts's `lowConfidence`,
 * account-health.ts's factor transparency): never hide a thin sample behind a
 * clean-looking number. */
const THIN_SERIES_OCCURRENCE_THRESHOLD = 5

export interface ForecastEvent {
  seriesKey: string
  label: string
  direction: RecurringDirection
  /** Always ≥ 0 (magnitude); `direction` carries the sign, same convention
   * as `RecurringSeries.typicalAmountMinor`. */
  amountMinor: bigint
  occurrenceCount: number
  dateConfidence: "estimated" | "overdue"
}

export interface AccountCashFlowForecastPoint {
  date: Date
  projectedBalanceMinor: bigint
  events: ForecastEvent[]
  lowConfidence: boolean
}

export interface AccountCashFlowForecast {
  points: AccountCashFlowForecastPoint[]
  horizonDays: number
  /**
   * True when the balance is ALREADY at or under `reserveMinor` at the
   * moment the forecast starts (offset 0). This is the present-state fact
   * `runway.status === "below"` already carries — re-detecting it as a
   * "future breach" on day 1 would misreport an existing, possibly
   * long-standing condition as fresh news (a real bug caught in review: a
   * zero-balance, no-reserve-configured e-wallet would otherwise ALWAYS
   * report "reaches zero tomorrow" — every single day — since it never
   * meaningfully leaves that state). `projectedReserveBreachDate` is
   * therefore only ever computed for the OPPOSITE case (starting above the
   * floor); when this flag is true, see `projectedRecoveryDate` instead.
   */
  alreadyAtOrBelowFloor: boolean
  /**
   * First forecast day (within the horizon) whose projected balance is at or
   * under `reserveMinor`, or null if none. Only ever set when
   * `alreadyAtOrBelowFloor` is false — see that field's doc comment.
   */
  projectedReserveBreachDate: Date | null
  /**
   * First forecast day (within the horizon) whose projected balance climbs
   * back ABOVE `reserveMinor`. Only ever set when `alreadyAtOrBelowFloor` is
   * true — the causal counterpart to a breach: "when does this recover".
   */
  projectedRecoveryDate: Date | null
  hasRecurringSignal: boolean
}

function cadenceDaysFor(cadence: RecurringCadence): number {
  switch (cadence) {
    case "weekly":
      return 7
    case "biweekly":
      return 14
    case "monthly":
      return 30
  }
}

/** A single series' occurrence expanded to a concrete future date. */
interface ExpandedOccurrence {
  series: RecurringSeries
  dateMs: number
  dateConfidence: "estimated" | "overdue"
}

/**
 * Expand one series to every occurrence date within (now, now + horizonDays].
 * `nextExpected` is the series' only known future date — cadence gives every
 * subsequent one. When `nextExpected` is already in the past relative to
 * `now`, step forward by the cadence until it lands at/after `now`; that
 * FIRST landed occurrence is tagged "overdue" (a stale past date would be
 * dishonest — see account-recurring.ts's own "don't claim what you can't
 * prove" discipline) and every later one in the window is a normal
 * "estimated" future occurrence.
 */
function expandOccurrences(
  series: RecurringSeries,
  nowMs: number,
  horizonEndMs: number
): ExpandedOccurrence[] {
  const cadenceMs = cadenceDaysFor(series.cadence) * DAY_MS
  let nextMs = series.nextExpected.getTime()
  let overdue = false
  if (nextMs < nowMs) {
    overdue = true
    while (nextMs < nowMs) nextMs += cadenceMs
  }

  const occurrences: ExpandedOccurrence[] = []
  let occMs = nextMs
  let first = true
  while (occMs <= horizonEndMs) {
    occurrences.push({
      series,
      dateMs: occMs,
      dateConfidence: first && overdue ? "overdue" : "estimated",
    })
    occMs += cadenceMs
    first = false
  }
  return occurrences
}

/**
 * Fuse an already-computed `AccountRunway` and `RecurringSeries[]` into a
 * day-by-day balance projection. Pure and deterministic given `opts.now`.
 *
 * `reserveMinor` is the caller's already-resolved reserve floor (pass `0n`
 * when the account has no configured reserve — the same convention
 * `computeAccountRunway` uses). See the file header for why this module
 * always computes `projectedReserveBreachDate` regardless, leaving the
 * "is this a real reserve" framing decision to the UI.
 */
export function computeAccountCashFlowForecast(
  currentBalanceMinor: bigint,
  reserveMinor: bigint,
  runway: AccountRunway,
  recurring: ReadonlyArray<RecurringSeries>,
  opts?: { horizonDays?: number; now?: Date }
): AccountCashFlowForecast {
  const horizonDays = opts?.horizonDays ?? 45
  const now = opts?.now ?? new Date()
  const nowMs = now.getTime()
  const horizonEndMs = nowMs + horizonDays * DAY_MS

  // Each series' own average daily contribution, so it can be backed out of
  // the trailing average (see the file header's double-counting trap). Uses
  // Number only for the per-day RATE, rounded back to a bigint minor-unit
  // amount — the same discipline computeAccountRunway itself uses for
  // `netDailyFlowMinor`, never left as a floating-point money value.
  let recurringDailyMinor = 0n
  for (const series of recurring) {
    const cadenceDays = cadenceDaysFor(series.cadence)
    const signedAmount =
      series.direction === "in"
        ? Number(series.typicalAmountMinor)
        : -Number(series.typicalAmountMinor)
    recurringDailyMinor += BigInt(Math.round(signedAmount / cadenceDays))
  }
  const backgroundDailyMinor = runway.netDailyFlowMinor - recurringDailyMinor

  const allOccurrences = recurring.flatMap((series) =>
    expandOccurrences(series, nowMs, horizonEndMs)
  )

  // Bucket occurrences by day offset (1..horizonDays) from `now`. Overdue
  // occurrences are stepped forward to land at/after `now` (see
  // expandOccurrences), so an offset of 0 ("due today") is placed at the
  // first forecast point rather than dropped.
  const eventsByDayOffset = new Map<number, ExpandedOccurrence[]>()
  for (const occ of allOccurrences) {
    const rawOffset = Math.round((occ.dateMs - nowMs) / DAY_MS)
    const offset = Math.max(1, rawOffset)
    if (offset > horizonDays) continue
    const bucket = eventsByDayOffset.get(offset)
    if (bucket) bucket.push(occ)
    else eventsByDayOffset.set(offset, [occ])
  }

  // A point's confidence rests on the WHOLE background rate that flows into
  // every day (runway's own trailing-average confidence, plus every series
  // whose average was folded into that background — not just the series that
  // happen to have a discrete event landing on a given day), so this is
  // computed once and applied uniformly rather than flickering per day.
  const hasThinSeries = recurring.some(
    (s) => s.occurrenceCount < THIN_SERIES_OCCURRENCE_THRESHOLD
  )
  const lowConfidence = runway.lowConfidence || hasThinSeries

  const alreadyAtOrBelowFloor = currentBalanceMinor <= reserveMinor

  const points: AccountCashFlowForecastPoint[] = []
  let balance = currentBalanceMinor
  let projectedReserveBreachDate: Date | null = null
  let projectedRecoveryDate: Date | null = null

  for (let offset = 1; offset <= horizonDays; offset++) {
    balance += backgroundDailyMinor
    const occurrencesToday = eventsByDayOffset.get(offset) ?? []
    const events: ForecastEvent[] = occurrencesToday.map((occ) => {
      balance +=
        occ.series.direction === "in"
          ? occ.series.typicalAmountMinor
          : -occ.series.typicalAmountMinor
      return {
        seriesKey: occ.series.key,
        label: occ.series.label,
        direction: occ.series.direction,
        amountMinor: occ.series.typicalAmountMinor,
        occurrenceCount: occ.series.occurrenceCount,
        dateConfidence: occ.dateConfidence,
      }
    })

    const date = new Date(nowMs + offset * DAY_MS)
    if (alreadyAtOrBelowFloor) {
      if (projectedRecoveryDate === null && balance > reserveMinor) {
        projectedRecoveryDate = date
      }
    } else if (projectedReserveBreachDate === null && balance <= reserveMinor) {
      projectedReserveBreachDate = date
    }
    points.push({ date, projectedBalanceMinor: balance, events, lowConfidence })
  }

  return {
    points,
    horizonDays,
    alreadyAtOrBelowFloor,
    projectedReserveBreachDate,
    projectedRecoveryDate,
    hasRecurringSignal: recurring.length > 0,
  }
}
