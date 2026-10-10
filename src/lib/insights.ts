import {
  calendarDateInZone,
  transactionInPeriod,
  type BudgetPeriodInput,
} from "./budget-progress"

// =============================================================================
// PER-227 — household-level insights engine ("Permoney knows me"), slice 1.
//
// Computed-on-read over the canonical ledger: no new tables, no write-on-read,
// no periodic job (the design pass on Linear PER-227, 2026-10-11, locked the
// registry read-time direction after weighing a materialized-snapshot design —
// at ~3.4k rows the performance argument for materialization is zero, and an
// honest read-time fold cannot serve stale numbers).
//
// The shape is Design A's compact surface (ONE generic `Insight` envelope + a
// context builder + a private registry of derivations, each producing the same
// shape) carrying Design B's honesty vocabulary:
//   - `engineVersion` — every payload states which engine produced it, so a
//     future materialized artifact (delivered digest) can be keyed by it;
//   - typed window kinds (`calendar_month` today; `previous_month`,
//     `since_payday`, `rolling_90d` reserved for later slices) that carry the
//     family timezone they were resolved in — a window is meaningless without
//     the zone it was cut in (ADR-0037 / PER-263);
//   - per-derivation empty / skipped states and failure isolation
//     (`failedCount`) — one broken derivation must never blank the page;
//   - FX-pending rows are EXCLUDED and COUNTED (`fxPendingCount` +
//     `partial`), never silently folded in as zero. No confident zeros.
//
// Tracer slice #1 is `savings_flow`: "saved/invested" = transfer INTENT — a
// `Transfer.purpose` of `savings` / `investment_contribution`, or a
// destination account whose subtype is `savings` (locked decision: movement
// intent, NOT net balance growth). A qualifying transfer counts exactly ONCE
// in the family-tz calendar month of its date. Transfers are never income or
// expense — the cash-flow engine already excludes `type='transfer'` rows, and
// this fold only ever consumes transfer rows, so the two engines cannot
// double-count the same movement.
//
// Budgets are deliberately NOT the mechanism here: the household manages
// without them by choice, so zero budget rows is a valid state, never treated
// as a defect or an empty-insight reason.
//
// Later slices add derivations (payday anchor + `since_payday` window,
// emergency fund, recurring bills, month-over-month trend) and an in-app
// digest page. A materialized delivered-digest artifact keyed
// `(familyId, month, engineVersion)` is only considered once a real
// out-of-request consumer (email delivery) exists — never the open period,
// never write-on-read.
// =============================================================================

/** Bumped whenever a derivation's meaning changes, so stored artifacts (a
 * future digest) are never read under a newer engine than produced them. */
export const INSIGHTS_ENGINE_VERSION = 1

export const SAVINGS_FLOW_INSIGHT_ID = "savings_flow"

export type InsightTone = "positive" | "neutral" | "attention"

export type InsightWindowKind =
  | "calendar_month"
  | "previous_month"
  | "since_payday"
  | "rolling_90d"

/** The family-tz-anchored window an insight was computed over. `start`/`end`
 * are inclusive family-tz calendar dates (ADR-0037) — the same convention as
 * `BudgetPeriodInput`, so `transactionInPeriod` is the one membership rule. */
export interface InsightWindow extends BudgetPeriodInput {
  kind: InsightWindowKind
}

/** One headline number. Money values are base-currency minor units in the
 * wire form (bigint as a digit string — JSON cannot carry bigint); counts are
 * plain decimal strings. The UI layer owns locale formatting. */
export interface InsightMetric {
  key: string
  value: string
  /** Present for money metrics; absent for counts. */
  currency?: string
}

/**
 * Design A's single envelope. Every derivation produces exactly this shape,
 * so one generic card / digest renderer can surface any insight without
 * knowing which derivation generated it.
 */
export interface Insight {
  id: string
  tone: InsightTone
  title: string
  summary: string
  /** Optional second line of copy (owned by the derivation, so the generic
   * renderer never needs to know which insight it is showing). */
  detail?: string
  metrics: InsightMetric[]
  /** True when at least one qualifying row was excluded for a known,
   * user-relevant reason (today: no FX rate resolved). A partial insight may
   * show a smaller-than-reality number — but only alongside the count that
   * explains why, never as a silent zero. */
  partial: boolean
  /** Rows this insight deliberately excluded because no FX rate resolved yet. */
  fxPendingCount: number
  window: InsightWindow
  engineVersion: number
}

/** A derivation that deliberately produced nothing, with the reason recorded
 * so the digest and tests can tell "nothing to say" from "failed". */
export interface InsightSkipped {
  id: string
  reason: string
}

export interface InsightReport {
  engineVersion: number
  window: InsightWindow
  insights: Insight[]
  /** Derivations that threw. Isolated: the rest of the report is still valid. */
  failedCount: number
  /** Derivations that ran and had nothing to surface (with why). */
  skipped: InsightSkipped[]
}

/** The minimum a derivation gets: the resolved window, the household's base
 * currency, and the canonical rows the server seam already loaded. */
export interface InsightContext {
  window: InsightWindow
  baseCurrency: string
  transferRows: ReadonlyArray<InsightTransferRow>
}

/**
 * One leg of a transfer as loaded by `src/server/insights.ts` — deliberately
 * a flat, DB-agnostic projection so the fold stays pure and unit-testable
 * without Prisma. `accountSubtype` is the leg OWNER's account subtype;
 * `toAccountSubtype` is the counterparty's — which one is the DESTINATION
 * depends on which leg this row is (see `pickCanonicalLeg`).
 */
export interface InsightTransferRow {
  id: string
  date: Date
  /** Frozen base-currency projection (ADR-0035 §4). `null` = FX-pending. */
  baseAmount: bigint | null
  accountSubtype: string | null
  toAccountSubtype: string | null
  /** The `Transfer` pairing this row is a leg of; `null` for a legacy /
   * unpaired transfer row (counted on its own, purpose unknown). */
  transferId: string | null
  transferPurpose: string | null
  transferOutflowTransactionId: string | null
  transferInflowTransactionId: string | null
}

export interface InsightContextInput {
  /** Family IANA timezone — the zone the month is cut in. */
  timezone: string
  /** `YYYY-MM`, already resolved in the family timezone by the caller. */
  month: string
  baseCurrency: string
  transferRows: ReadonlyArray<InsightTransferRow>
}

export interface DerivationOutcome {
  insight: Insight | null
  skippedReason?: string
}

export type InsightDerivation = (context: InsightContext) => DerivationOutcome

interface RegisteredDerivation {
  id: string
  run: InsightDerivation
}

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/

/**
 * Inclusive family-tz bounds of a calendar month. Pure calendar arithmetic on
 * the Y-M-D components; `Date.UTC` is used only as a calendar calculator to
 * find the month's last day (28–31), never to represent a wall-clock instant
 * — the same technique as `subtractCalendarMonths` in src/server/reporting.ts.
 */
export function calendarMonthBounds(month: string): {
  start: string
  end: string
} {
  const match = MONTH_PATTERN.exec(month)
  if (!match) {
    throw new Error(
      `calendarMonthBounds: month must be YYYY-MM, got "${month}"`
    )
  }
  const year = Number(match[1])
  const monthIndex = Number(match[2])
  if (monthIndex < 1 || monthIndex > 12) {
    throw new Error(
      `calendarMonthBounds: month out of range 01-12, got "${month}"`
    )
  }
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`,
  }
}

/** The current `YYYY-MM` as seen in `timezone` — never the server's clock. */
export function currentMonthInZone(now: Date, timezone: string): string {
  return calendarDateInZone(now, timezone).slice(0, 7)
}

/** Purposes that mean "this transfer moved money into savings/investments". */
const SAVINGS_PURPOSES: ReadonlySet<string> = new Set([
  "savings",
  "investment_contribution",
])

/** Destination-account subtype that means "this is a savings vehicle", even
 * when no purpose label was attached (legacy rows, purpose override cleared). */
const SAVINGS_SUBTYPE = "savings"

/**
 * Build the per-report context once per request. Also the single place the
 * month string is validated — every derivation downstream can trust the
 * window.
 */
export function buildInsightContext(
  input: InsightContextInput
): InsightContext {
  const bounds = calendarMonthBounds(input.month)
  return {
    window: {
      kind: "calendar_month",
      start: bounds.start,
      end: bounds.end,
      timezone: input.timezone,
    },
    baseCurrency: input.baseCurrency,
    transferRows: input.transferRows,
  }
}

/** Group legs by their `Transfer` pairing; an unpaired row is its own group. */
function groupByTransfer(
  rows: ReadonlyArray<InsightTransferRow>
): Map<string, InsightTransferRow[]> {
  const groups = new Map<string, InsightTransferRow[]>()
  for (const row of rows) {
    const key = row.transferId ?? `tx:${row.id}`
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }
  return groups
}

/**
 * Pick the ONE leg that represents the movement's destination side: the
 * inflow leg when the pairing has one (money landing in the destination
 * account), else the outflow leg (a valuation-linked contribution has only a
 * cash outflow leg — the tracked side is a Valuation, not a Transaction), else
 * the row we have (legacy unpaired transfer). Counting the whole group this
 * way is what makes a two-leg transfer count exactly once.
 */
function pickCanonicalLeg(
  group: ReadonlyArray<InsightTransferRow>
): InsightTransferRow | null {
  const first = group[0]
  if (!first) return null
  return (
    group.find((row) => row.id === first.transferInflowTransactionId) ??
    group.find((row) => row.id === first.transferOutflowTransactionId) ??
    first
  )
}

/**
 * Slice #1 derivation — `savings_flow`.
 *
 * Qualifies a transfer when its purpose is `savings` /
 * `investment_contribution`, or its destination account subtype is `savings`.
 * The qualifying leg must fall inside the family-tz window (inclusive); the
 * amount is the leg's frozen base-currency projection magnitude. FX-pending
 * legs are excluded AND counted, so the card can say how much is missing.
 */
function deriveSavingsFlow(context: InsightContext): DerivationOutcome {
  const { window, baseCurrency, transferRows } = context
  if (transferRows.length === 0) {
    return { insight: null, skippedReason: "no transfers in the window" }
  }

  let saved = 0n
  let transferCount = 0
  let fxPendingCount = 0

  for (const group of groupByTransfer(transferRows).values()) {
    const canonical = pickCanonicalLeg(group)
    if (!canonical) continue

    const isInflowLeg = canonical.id === canonical.transferInflowTransactionId
    const destinationSubtype = isInflowLeg
      ? canonical.accountSubtype
      : canonical.toAccountSubtype
    const qualifies =
      (canonical.transferPurpose !== null &&
        SAVINGS_PURPOSES.has(canonical.transferPurpose)) ||
      destinationSubtype === SAVINGS_SUBTYPE
    if (!qualifies) continue

    // Window membership is judged on the canonical (destination) leg's date in
    // the family timezone — both legs of a classic transfer share it.
    if (!transactionInPeriod(canonical.date, window)) continue

    if (canonical.baseAmount === null) {
      fxPendingCount += 1
      continue
    }
    saved +=
      canonical.baseAmount < 0n ? -canonical.baseAmount : canonical.baseAmount
    transferCount += 1
  }

  if (transferCount === 0 && fxPendingCount === 0) {
    return {
      insight: null,
      skippedReason: "no savings or investment transfers in the window",
    }
  }

  return {
    insight: {
      id: SAVINGS_FLOW_INSIGHT_ID,
      tone: "positive",
      title: "Saved this month",
      summary: "Transfers into savings and investment accounts this month.",
      detail:
        transferCount > 0
          ? `Across ${transferCount} transfer${transferCount === 1 ? "" : "s"}.`
          : undefined,
      metrics: [
        { key: "saved", value: saved.toString(), currency: baseCurrency },
        { key: "transfer_count", value: String(transferCount) },
        { key: "fx_pending_count", value: String(fxPendingCount) },
      ],
      partial: fxPendingCount > 0,
      fxPendingCount,
      window,
      engineVersion: INSIGHTS_ENGINE_VERSION,
    },
  }
}

const REGISTERED_DERIVATIONS: ReadonlyArray<RegisteredDerivation> = [
  { id: SAVINGS_FLOW_INSIGHT_ID, run: deriveSavingsFlow },
]

/**
 * Run every registered derivation over one context. Failure isolation: a
 * derivation that throws is counted and skipped — the remaining insights are
 * still returned. The `derivations` parameter is a test seam (inject a
 * throwing derivation) and the extension point for later slices; production
 * callers omit it.
 */
export function computeInsights(
  input: InsightContextInput,
  derivations: ReadonlyArray<RegisteredDerivation> = REGISTERED_DERIVATIONS
): InsightReport {
  const context = buildInsightContext(input)
  const insights: Insight[] = []
  const skipped: InsightSkipped[] = []
  let failedCount = 0

  for (const derivation of derivations) {
    try {
      const outcome = derivation.run(context)
      if (outcome.insight) {
        insights.push(outcome.insight)
      } else if (outcome.skippedReason) {
        skipped.push({ id: derivation.id, reason: outcome.skippedReason })
      }
    } catch {
      failedCount += 1
    }
  }

  return {
    engineVersion: INSIGHTS_ENGINE_VERSION,
    window: context.window,
    insights,
    failedCount,
    skipped,
  }
}
