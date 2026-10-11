import {
  detectRecurringSeries,
  type RecurringSeries,
  type RecurringTxn,
} from "./account-recurring"
import { gapsInWindow } from "./anchor-gaps"
import {
  calendarDateInZone,
  transactionInPeriod,
  type BudgetPeriodInput,
} from "./budget-progress"
import { convertMinor } from "./fx"
import type { CurrencyCode } from "@/lib/data/currencies"

// =============================================================================
// PER-227 — household-level insights engine ("Permoney knows me"), slices 1-2.
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
// Slice #2 adds `since_payday`: the anchor is the family-wide salary series
// (the LARGEST recurring monthly INCOME series, via `detectRecurringSeries`),
// the window runs from that occurrence's family-tz calendar date through
// "today", and the figures are household cash flow inside that window — all
// income minus all spending (locked decision 2026-10-11). A family with no
// detectable monthly income series gets NO since-payday card: an invented
// payday would be the opposite of "Permoney knows me".
//
// Later slices add derivations (emergency fund, recurring bills,
// month-over-month trend) and an in-app digest page. A materialized
// delivered-digest artifact keyed `(familyId, month, engineVersion)` is only
// considered once a real out-of-request consumer (email delivery) exists —
// never the open period, never write-on-read.
// =============================================================================

/** Bumped whenever a derivation's meaning changes OR the registry's
 * composition changes — an artifact produced by an earlier engine is
 * incomplete for a later one, so it must never be read as if it were current.
 * Version 2 added `since_payday`. Version 3 added the period-incompleteness
 * qualifier (`periodPartial` / `periodGaps`, PER-443): the numbers themselves
 * are unchanged, but a v2 artifact carries no way to say "this window is only
 * partially recorded", so it must not be read as complete under v3. */
export const INSIGHTS_ENGINE_VERSION = 3

export const SAVINGS_FLOW_INSIGHT_ID = "savings_flow"

export const SINCE_PAYDAY_INSIGHT_ID = "since_payday"

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
  /** Human label owned by the derivation. The headline money figure is
   * identified by POSITION (first money metric); every labelled metric after
   * it is rendered as a supporting line by the generic surfaces. */
  label?: string
}

/**
 * One anchor-chain hole (PER-443) intersecting an insight's window, in the
 * shape the card renders: account-currency money as a wire string, display-
 * ready calendar dates. There is no cross-currency conversion here — the gap
 * belongs to one account and is reported in that account's own currency,
 * exactly as the accounts page does.
 */
export interface InsightPeriodGap {
  accountId: string
  accountName: string
  currency: string
  /** Family-tz calendar dates (YYYY-MM-DD) of the unrecorded segment. */
  fromDate: string
  toDate: string
  /** |unrecorded movement| in the segment, account-currency minor units. */
  amount: string
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
  /** True when at least one LIVE anchor-chain gap intersects this insight's
   * window: activity in that period was never recorded, so the money figures
   * may be understated. Deliberately separate from `partial` (FX-only) — a
   * period problem is not an exchange-rate problem, and each badge must be
   * able to say exactly one thing (PER-443, ADR-0059 §7). */
  periodPartial: boolean
  /** The live gaps intersecting this window. Empty when the window covers a
   * fully recorded period. */
  periodGaps: InsightPeriodGap[]
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
 * currency, the request instant, and the canonical rows the server seam
 * already loaded. */
export interface InsightContext {
  window: InsightWindow
  baseCurrency: string
  /** The request instant, resolved by the caller — a derivation never reads
   * the clock itself, so window math stays deterministic in tests. */
  now: Date
  transferRows: ReadonlyArray<InsightTransferRow>
  /** Income rows over the payday-anchor lookback (see `src/server/insights.ts`
   * for how far back, and why). */
  incomeRows: ReadonlyArray<InsightFlowRow>
  /** Expense rows whose family-tz dates can fall inside a payday window. */
  expenseRows: ReadonlyArray<InsightFlowRow>
  /** Every live anchor-chain hole in the family (PER-443); each derivation
   * intersects its OWN window against them, so a gap that misses
   * `since_payday` still qualifies a calendar-month card and vice versa. */
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>
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

/**
 * One income/expense row as loaded by `src/server/insights.ts` — the same
 * flat, DB-agnostic projection discipline as `InsightTransferRow`. Only the
 * `since_payday` derivation consumes these:
 *   - `accountId`, `date`, `amount`, `merchantName`, `description` feed
 *     `detectRecurringSeries` (native magnitudes — never displayed);
 *   - `date`, `baseAmount`, `isSplit`, `splitEntries`, `currency`,
 *     `baseCurrency`, `fxRateScaled` feed the cash-flow fold, byte-for-byte
 *     the same rules the budget/cash-flow engines apply to the same rows.
 */
export interface InsightFlowRow {
  /** The row owner's account — required by `RecurringTxn`; detection does not
   * group per account (the family-wide salary series). */
  accountId: string
  date: Date
  /** Native-currency amount magnitude — series detection only. */
  amount: bigint
  /** Frozen base-currency projection (ADR-0035 §4). `null` = FX-pending. */
  baseAmount: bigint | null
  currency: string
  baseCurrency: string | null
  fxRateScaled: bigint | null
  isSplit: boolean
  /** Split child allocations (native, parent currency) — folded through the
   * parent's stored rate, exactly as `computeCashFlowReport` does. */
  splitEntries: ReadonlyArray<{ amount: bigint }>
  /** Detection label: the merchant name, else the description. */
  merchantName: string | null
  description: string | null
}

/**
 * One live anchor-chain hole as loaded by `src/server/insights.ts` — the same
 * flat, DB-agnostic projection discipline as the other row types. `amount` is
 * the |unrecorded movement| in the ACCOUNT's currency (bigint; never converted
 * across currencies, so FX-pending can't touch it). `fromSource`/`toSource`
 * feed the shared migration-softening rule (src/lib/anchor-gaps.ts), so this
 * engine can never disagree with the accounts badge about which gaps are
 * "known by design".
 */
export interface InsightAnchorGapRow {
  accountId: string
  accountName: string
  currency: string
  fromDate: string
  toDate: string
  amount: bigint
  fromSource: string | null
  toSource: string | null
}

/** The resolved payday anchor of the open cycle: the most recent occurrence of
 * the family's largest monthly income series, as family-tz calendar dates. */
export interface PaydayAnchor {
  /** Family-tz date (YYYY-MM-DD) of the anchor occurrence — window start. */
  paydayDate: string
  /** Family-tz date the series is next expected on (a projection — the copy
   * must say "expected", never state it as fact). */
  nextExpectedDate: string
}

export interface InsightContextInput {
  /** Family IANA timezone — the zone every window is cut in. */
  timezone: string
  /** `YYYY-MM`, already resolved in the family timezone by the caller. */
  month: string
  baseCurrency: string
  /** The request instant (injected — the server passes `new Date()`; tests
   * pass a fixed instant so window math is deterministic). */
  now: Date
  transferRows: ReadonlyArray<InsightTransferRow>
  incomeRows: ReadonlyArray<InsightFlowRow>
  expenseRows: ReadonlyArray<InsightFlowRow>
  /** Every live anchor-chain hole in the family (PER-443) — see
   * `InsightContext.anchorGaps`. */
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>
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
    now: input.now,
    transferRows: input.transferRows,
    incomeRows: input.incomeRows,
    expenseRows: input.expenseRows,
    anchorGaps: input.anchorGaps,
  }
}

/**
 * The live gaps an insight over `window` must disclose, in the card's shape.
 * One shared definition (src/lib/anchor-gaps.ts): migration-softened pairs are
 * "known by design" and drop out; a gap touching only one boundary day still
 * counts. Pure — no clock, no DB.
 */
function periodGapsForWindow(
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>,
  window: InsightWindow
): InsightPeriodGap[] {
  return gapsInWindow(anchorGaps, window).map((gap) => ({
    accountId: gap.accountId,
    accountName: gap.accountName,
    currency: gap.currency,
    fromDate: gap.fromDate,
    toDate: gap.toDate,
    amount: gap.amount.toString(),
  }))
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

  const periodGaps = periodGapsForWindow(context.anchorGaps, window)

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
      periodPartial: periodGaps.length > 0,
      periodGaps,
      window,
      engineVersion: INSIGHTS_ENGINE_VERSION,
    },
  }
}

// ---------------------------------------------------------------------------
// Slice #2 — `since_payday`
// ---------------------------------------------------------------------------

/** `InsightFlowRow` → the recurring detector's input shape. These rows are
 * income rows by contract (the server loads only `type="income"` for the
 * anchor lookback), so the type is fixed rather than carried per row. */
function toRecurringTxn(row: InsightFlowRow): RecurringTxn {
  return {
    accountId: row.accountId,
    date: row.date,
    amount: row.amount,
    type: "income",
    merchant: row.merchantName === null ? null : { name: row.merchantName },
    description: row.description,
  }
}

/** Anchor preference: the LARGER typical amount wins; ties fall to the more
 * recent occurrence, then to the grouping key — fully deterministic. */
function beatsForAnchor(
  candidate: RecurringSeries,
  current: RecurringSeries
): boolean {
  if (candidate.typicalAmountMinor !== current.typicalAmountMinor) {
    return candidate.typicalAmountMinor > current.typicalAmountMinor
  }
  const lastGap =
    candidate.lastOccurrence.getTime() - current.lastOccurrence.getTime()
  if (lastGap !== 0) return lastGap > 0
  return candidate.key < current.key
}

/**
 * Resolve the payday anchor: the most recent occurrence of the family's
 * largest MONTHLY recurring income series (the salary, by the locked rule).
 * `null` when no such series exists — the caller must skip the card, never
 * invent a payday. Pure; `now` is injected because the detector's staleness
 * guard needs it (a series whose last occurrence is more than two cadence
 * bands old is not a live salary and is dropped there).
 */
export function resolvePaydayAnchor(
  incomeRows: ReadonlyArray<InsightFlowRow>,
  now: Date,
  timezone: string
): PaydayAnchor | null {
  const series = detectRecurringSeries(incomeRows.map(toRecurringTxn), { now })
  let top: RecurringSeries | null = null
  for (const candidate of series) {
    if (candidate.cadence !== "monthly") continue
    if (top === null || beatsForAnchor(candidate, top)) top = candidate
  }
  if (top === null) return null
  return {
    paydayDate: calendarDateInZone(top.lastOccurrence, timezone),
    nextExpectedDate: calendarDateInZone(top.nextExpected, timezone),
  }
}

interface FlowTotals {
  income: bigint
  spent: bigint
  fxPendingCount: number
}

/** Positive base magnitude of one split child via the parent's stored rate —
 * byte-for-byte the fold `computeBudgetProgress`/`computeCashFlowReport`
 * apply to the same rows. */
function splitChildBase(
  row: InsightFlowRow,
  entry: { amount: bigint }
): bigint {
  // Caller guarantees the parent is non-pending (rate + base currency set).
  const base = convertMinor(
    entry.amount,
    row.currency as CurrencyCode,
    row.baseCurrency as CurrencyCode,
    row.fxRateScaled as bigint
  ) as bigint
  return base < 0n ? -base : base
}

/** Fold one window-member row into the totals. A split parent contributes via
 * its children; an FX-pending row (or pending split parent) is counted once
 * and contributes nothing — excluded AND counted, never a silent zero. */
function addFlowRow(
  totals: FlowTotals,
  row: InsightFlowRow,
  isIncome: boolean
): void {
  if (row.isSplit) {
    const parentPending =
      row.baseAmount === null ||
      row.fxRateScaled === null ||
      row.baseCurrency === null
    if (parentPending) {
      totals.fxPendingCount += 1
      return
    }
    for (const entry of row.splitEntries) {
      const magnitude = splitChildBase(row, entry)
      if (isIncome) totals.income += magnitude
      else totals.spent += magnitude
    }
    return
  }

  if (row.baseAmount === null) {
    totals.fxPendingCount += 1
    return
  }
  const magnitude = row.baseAmount < 0n ? -row.baseAmount : row.baseAmount
  if (isIncome) totals.income += magnitude
  else totals.spent += magnitude
}

/**
 * Slice #2 derivation — `since_payday`.
 *
 * Runs ONLY for the family's current month: the window is "now"-relative by
 * nature, so a historical digest must not grow a card folded from a stale
 * clock. The window starts on the anchor occurrence's family-tz calendar date
 * and ends today (inclusive); `left` is household cash flow inside it — all
 * income minus all spending (locked decision, 2026-10-11). Transfers never
 * enter either side: a movement into savings is neither spending nor income,
 * so `savings_flow` and `since_payday` cannot double-count one movement.
 */
function deriveSincePayday(context: InsightContext): DerivationOutcome {
  const { window: monthWindow, baseCurrency, now } = context
  const timezone = monthWindow.timezone
  const today = calendarDateInZone(now, timezone)
  if (monthWindow.start.slice(0, 7) !== today.slice(0, 7)) {
    return {
      insight: null,
      skippedReason: "since payday only applies to the family's current month",
    }
  }

  const anchor = resolvePaydayAnchor(context.incomeRows, now, timezone)
  if (anchor === null) {
    return {
      insight: null,
      skippedReason: "no monthly recurring income series detected",
    }
  }

  const window: InsightWindow = {
    kind: "since_payday",
    start: anchor.paydayDate,
    end: today,
    timezone,
  }

  const totals: FlowTotals = { income: 0n, spent: 0n, fxPendingCount: 0 }
  for (const row of context.incomeRows) {
    if (transactionInPeriod(row.date, window)) addFlowRow(totals, row, true)
  }
  for (const row of context.expenseRows) {
    if (transactionInPeriod(row.date, window)) addFlowRow(totals, row, false)
  }

  const left = totals.income - totals.spent
  const periodGaps = periodGapsForWindow(context.anchorGaps, window)

  return {
    insight: {
      id: SINCE_PAYDAY_INSIGHT_ID,
      tone: left < 0n ? "attention" : "positive",
      title: "Left since payday",
      summary: `Income minus spending since your last payday (${anchor.paydayDate}).`,
      detail: `Next payday expected ${anchor.nextExpectedDate}.`,
      metrics: [
        {
          key: "left",
          label: "Left",
          value: left.toString(),
          currency: baseCurrency,
        },
        {
          key: "spent",
          label: "Spent",
          value: totals.spent.toString(),
          currency: baseCurrency,
        },
        { key: "fx_pending_count", value: String(totals.fxPendingCount) },
      ],
      partial: totals.fxPendingCount > 0,
      fxPendingCount: totals.fxPendingCount,
      periodPartial: periodGaps.length > 0,
      periodGaps,
      window,
      engineVersion: INSIGHTS_ENGINE_VERSION,
    },
  }
}

const REGISTERED_DERIVATIONS: ReadonlyArray<RegisteredDerivation> = [
  { id: SAVINGS_FLOW_INSIGHT_ID, run: deriveSavingsFlow },
  { id: SINCE_PAYDAY_INSIGHT_ID, run: deriveSincePayday },
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
