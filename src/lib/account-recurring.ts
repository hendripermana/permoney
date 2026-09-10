import { type AnalyticsTxn } from "./account-analytics"

// =============================================================================
// PER-225 Slice 4a — recurring / bill detection: account intelligence layer,
// slice 4 (FIRST TRACER BULLET of a milestone — see the ticket's own "needs
// its own grill / likely 2+ slices" note).
//
// Detect recurring transactions (subscriptions, bills, salary) per account by
// clustering same-merchant/description occurrences on cadence (weekly /
// biweekly / monthly) + amount stability. Client-side heuristic over the
// already-loaded per-account ledger — same discipline as PER-222 (runway) and
// PER-223 (idle cash): pure math, no server model, no migration, no periodic
// job. The output shape is deliberately UI-agnostic so a future server
// insights engine (PER-227) or a "recurring-aware runway" follow-up slice can
// consume the same `RecurringSeries` without changing this contract.
//
// Deliberately OUT of scope for this slice (tracked as explicit follow-ups on
// the PER-225 milestone, not silently dropped):
//   - No detected-recurrence DATABASE model or periodic background job.
//   - No calendar view / dedicated "upcoming bills" route.
//   - No edit/confirm/dismiss UX — this is read-only ambient surfacing.
//   - No runway integration (PER-222 stays trailing-average, not
//     recurring-aware) — that is an explicit later slice per the ticket.
//   - Transfers are NOT considered (only "income"/"expense" rows). A
//     recurring transfer (e.g. a scheduled top-up to savings) is a real
//     pattern but doubles the disambiguation surface (which leg, which
//     direction) for a first slice; revisit once the milestone's UX is
//     validated (per the "Goal" feature lesson: prove a narrow slice first).
// =============================================================================

const DAY_MS = 86_400_000

export type RecurringCadence = "weekly" | "biweekly" | "monthly"

export type RecurringDirection = "in" | "out"

export interface RecurringSeries {
  /** Normalized grouping key (lowercased merchant name or description). */
  key: string
  /** Human-readable label — the merchant name, or the transaction description. */
  label: string
  cadence: RecurringCadence
  /** "in" for income (e.g. salary), "out" for expense (e.g. a subscription). */
  direction: RecurringDirection
  /** Average amount over the detected occurrences, in minor units (always ≥ 0). */
  typicalAmountMinor: bigint
  /** Number of occurrences that make up this detected series. */
  occurrenceCount: number
  /** The most recent occurrence's date. */
  lastOccurrence: Date
  /** Projected next date, from the last occurrence + the average gap. */
  nextExpected: Date
}

/** A transaction shape recurring detection can group — the per-account ledger
 * (`AnalyticsTxn`) plus `description`, the other half of the merchant/label
 * fallback (mirrors `matchesQuery` and `summarizeCategories` in
 * account-analytics.ts, which use the same two-field fallback). */
export type RecurringTxn = AnalyticsTxn & { description?: string | null }

interface CadenceBand {
  cadence: RecurringCadence
  minDays: number
  maxDays: number
}

// Tolerance bands (days) around each cadence's nominal period. Generous enough
// to absorb weekend/holiday shifts and calendar month-length variance (28–31
// days), but tight enough that two coincidentally same-amount, same-merchant
// transactions a random 10 and 45 days apart don't get misread as a cadence.
// Bands are non-overlapping so a candidate gap matches at most one cadence.
const CADENCE_BANDS: ReadonlyArray<CadenceBand> = [
  { cadence: "weekly", minDays: 5, maxDays: 9 }, // 7d ± ~2
  { cadence: "biweekly", minDays: 11, maxDays: 17 }, // 14d ± ~3
  { cadence: "monthly", minDays: 25, maxDays: 35 }, // 30d ± ~5
]

/** Amount stability tolerance: every occurrence may deviate from the group's
 * average amount by at most this fraction (±15%, the loose end of the
 * "±10–15%" the ticket calls for, chosen because real bills/subscriptions
 * drift with tax/FX/plan changes more than a fixed payroll amount does). */
export const AMOUNT_VARIANCE_TOLERANCE = 0.15

/** Minimum occurrences before a pattern is trusted as "recurring" — two
 * same-amount, same-merchant transactions are too easily coincidental. */
export const MIN_RECURRING_OCCURRENCES = 3

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

/** Normalize a merchant name / description into a stable grouping key:
 * lowercase, strip digits and punctuation (invoice numbers, card-ending
 * suffixes, "#4471"-style tags), collapse whitespace. "Netflix" and
 * "NETFLIX #4471" collapse to the same key; "Netflix" and "Spotify" never do. */
function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function labelFor(t: RecurringTxn): string | null {
  const raw = t.merchant?.name ?? t.description ?? null
  if (!raw) return null
  return raw.trim() || null
}

interface Occurrence {
  ms: number
  amount: bigint // absolute magnitude (AnalyticsTxn convention)
  type: string
  label: string // raw (unnormalized) label, most recent wins for display
}

function chronological(a: Occurrence, b: Occurrence): number {
  return a.ms - b.ms
}

function bandForGaps(gapsDays: ReadonlyArray<number>): CadenceBand | null {
  for (const band of CADENCE_BANDS) {
    if (gapsDays.every((g) => g >= band.minDays && g <= band.maxDays)) {
      return band
    }
  }
  return null
}

/**
 * Detect recurring transaction series (subscriptions, bills, salary) from an
 * account's ledger. `txns` should already be the per-account ledger (e.g. via
 * `applyFilters` — the PER-202 lens); only "income"/"expense" rows are
 * considered (see the file header for why transfers are out of scope for this
 * slice). Pure and deterministic given `now`.
 */
export function detectRecurringSeries(
  txns: ReadonlyArray<RecurringTxn>,
  opts?: {
    now?: Date
    minOccurrences?: number
    amountVarianceTolerance?: number
  }
): RecurringSeries[] {
  const now = opts?.now ?? new Date()
  const minOccurrences = opts?.minOccurrences ?? MIN_RECURRING_OCCURRENCES
  const amountVariance =
    opts?.amountVarianceTolerance ?? AMOUNT_VARIANCE_TOLERANCE

  const groups = new Map<string, Occurrence[]>()
  for (const t of txns) {
    if (t.type !== "income" && t.type !== "expense") continue
    const label = labelFor(t)
    if (!label) continue
    const key = normalizeKey(label)
    if (!key) continue
    const occurrence: Occurrence = {
      ms: toTime(t.date),
      amount: t.amount,
      type: t.type,
      label,
    }
    const existing = groups.get(key)
    if (existing) existing.push(occurrence)
    else groups.set(key, [occurrence])
  }

  const results: RecurringSeries[] = []

  for (const [key, occurrences] of groups) {
    if (occurrences.length < minOccurrences) continue
    occurrences.sort(chronological)

    const gapsDays: number[] = []
    for (let i = 1; i < occurrences.length; i++) {
      gapsDays.push((occurrences[i].ms - occurrences[i - 1].ms) / DAY_MS)
    }
    const band = bandForGaps(gapsDays)
    if (!band) continue // irregular cadence — not a trustworthy pattern

    // Amount stability: every occurrence within `amountVariance` of the
    // group's mean. Money stays bigint for the mean/typical figure; only the
    // per-occurrence deviation RATIO uses Number (a bounded, display-only
    // quantity, never money math — same discipline as account-idle-cash.ts).
    const total = occurrences.reduce((sum, o) => sum + o.amount, 0n)
    const meanMinor = total / BigInt(occurrences.length)
    if (meanMinor <= 0n) continue
    const meanNumber = Number(meanMinor)
    const withinVariance = occurrences.every((o) => {
      const deviation = Math.abs(Number(o.amount) - meanNumber) / meanNumber
      return deviation <= amountVariance
    })
    if (!withinVariance) continue

    const last = occurrences[occurrences.length - 1]
    const avgGapDays = gapsDays.reduce((sum, g) => sum + g, 0) / gapsDays.length
    const lastOccurrence = new Date(last.ms)
    const nextExpected = new Date(last.ms + Math.round(avgGapDays) * DAY_MS)

    // Honesty guard: if the last occurrence is far enough in the past that
    // the series has clearly stopped recurring (more than 2 cadence-bands'
    // worth of days since), don't project a stale "next expected" date — a
    // cancelled subscription showing a confidently-wrong next date would be
    // the opposite of ambient/trustworthy (mirrors PER-223's "don't claim
    // what you can't prove" idle-cash honesty guard).
    const sinceLastDays = (now.getTime() - last.ms) / DAY_MS
    if (sinceLastDays > band.maxDays * 2) continue

    // Direction: the most common type among the occurrences (ties favor the
    // most recent occurrence's type). Same merchant flipping between income
    // and expense is unusual but not impossible (e.g. a merchant that both
    // bills and refunds) — majority vote keeps a single coherent label.
    const incomeCount = occurrences.filter((o) => o.type === "income").length
    const direction: RecurringDirection =
      incomeCount * 2 > occurrences.length
        ? "in"
        : incomeCount * 2 === occurrences.length
          ? last.type === "income"
            ? "in"
            : "out"
          : "out"

    results.push({
      key,
      label: last.label,
      cadence: band.cadence,
      direction,
      typicalAmountMinor: meanMinor,
      occurrenceCount: occurrences.length,
      lastOccurrence,
      nextExpected,
    })
  }

  // Soonest-expected first — the most immediately actionable signal leads.
  results.sort((a, b) => a.nextExpected.getTime() - b.nextExpected.getTime())
  return results
}
