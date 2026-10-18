import {
  detectRecurringSeries,
  type RecurringCadence,
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
import { buildLatestRateResolver, type RateResolver } from "./net-worth"
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
//   - typed window kinds (`calendar_month`, `since_payday`,
//     `trailing_6_months`, `next_30_days`, `previous_month` in use;
//     `rolling_90d` reserved for later slices) that carry the family timezone
//     they were resolved in
//     — a window is meaningless without the zone it was cut in
//     (ADR-0037 / PER-263);
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
// Slice #3 adds `emergency_fund`: "current saved" is the CURRENT BALANCE of
// every active ASSET account whose product subtype is `savings` (any
// accountType — Indonesian households park emergency money in money-market
// mutual funds), converted with the SAME latest-rate resolver the net-worth
// cards use, so this card can never disagree with net worth. The target is
// 6 × the average monthly spending burn over the six COMPLETE family-tz
// months before the requested month; a burn month counts only when recorded
// ledger history covers it end-to-end, and the months actually used are
// disclosed (`partial_window`). No qualifying account → a skip, never a
// confident zero. The full locked basis and the rejected alternatives are in
// the ADR-0059 PER-227 amendment.
//
// Slice #4 adds `recurring_bills`: the FIRST forward-looking card. Its window
// is today → today+30 calendar days in the family timezone (inclusive of both
// endpoints), and its amount is a PREDICTION — the summed mean of each
// detected expense series' recorded amounts (`typicalAmountMinor`), never a
// posted transaction. Honesty is therefore copy-led: the headline metric is
// labelled "Predicted from N past payments", the summary says "an estimate
// from recorded payments, not money already spent", and the tone is always
// `neutral` (an advisory escalation would read as a bill REMINDER, which the
// engine is not — see the ADR-0059 amendment for the rejected tone rules).
// Income never reaches the detector: the derivation filters `expenseRows`
// only, because the detector has no direction option. Overdue series still
// count as due; a series only drops out via the detector's own staleness
// guard (two cadence bands), so "how overdue" is bounded there, not here.
//
// Slice #5 adds `spending_trend`: the month-over-month comparison the
// flagship ask names directly, and the easiest card on this engine to make
// dishonest. The headline is the DELTA between this month's spend over days
// 1..N and LAST month's spend over days 1..N (family tz, N = today's
// day-of-month, inclusive) — LIKE FOR LIKE: a partial current month is never
// compared against a complete previous month as if they were equal, and no
// projection to a full month exists anywhere on the card (a projected month
// total is a fabricated number, and this engine does not fabricate). The
// complete previous month total is still shown — label-led, marked as
// context — so the user gets the full picture without the comparison
// implying an unfair one. The delta is reported NEUTRALLY: spending more is
// not automatically bad and spending less is not automatically good (a
// lower number can be a cancelled medicine), so the tone is `neutral` on
// every path; a positive delta always means "spent MORE" than the same days
// of last month (sign convention documented in the ADR-0059 amendment). For
// a PAST requested month both sides are complete months — the rule
// degenerates naturally to complete-vs-complete and `partial` is false; the
// current month being in progress is what sets `partial`, alongside copy
// that states the days elapsed.
//
// Later slices add an in-app digest page. A materialized delivered-digest artifact keyed
// `(familyId, month, engineVersion)` is only considered once a real
// out-of-request consumer (email delivery) exists — never the open period,
// never write-on-read.
// =============================================================================

/** Bumped whenever a derivation's meaning changes OR the registry's
 * composition changes — an artifact produced by an earlier engine is
 * incomplete for a later one, so it must never be read as if it were current.
 * Version 2 added `since_payday`. Version 3 added the period-incompleteness
 * qualifier (`periodPartial` / `periodGaps`, PER-443): the numbers themselves
 * are unchanged, but a v2 artifact carries no way to say "this window is only
 * partially recorded", so it must not be read as complete under v3. Version 4
 * adds `emergency_fund` (PER-227 slice #3): a v3 artifact simply lacks the
 * card, so it must not be read as a complete report under v4. Version 5 adds
 * `recurring_bills` and the forward-looking `next_30_days` window kind
 * (PER-227 slice #4): a v4 artifact simply lacks the card, so it must not be
 * read as a complete report under v5. Version 6 adds `spending_trend` and
 * puts the reserved `previous_month` window kind in use (PER-227 slice #5):
 * a v5 artifact simply lacks the card, so it must not be read as a complete
 * report under v6. */
export const INSIGHTS_ENGINE_VERSION = 6

export const SAVINGS_FLOW_INSIGHT_ID = "savings_flow"

export const SINCE_PAYDAY_INSIGHT_ID = "since_payday"

export const EMERGENCY_FUND_INSIGHT_ID = "emergency_fund"
export const RECURRING_BILLS_INSIGHT_ID = "recurring_bills"
export const SPENDING_TREND_INSIGHT_ID = "spending_trend"

export type InsightTone = "positive" | "neutral" | "attention"

export type InsightWindowKind =
  | "calendar_month"
  | "previous_month"
  | "since_payday"
  | "rolling_90d"
  | "trailing_6_months"
  | "next_30_days"

/** The family-tz-anchored window an insight was computed over. `start`/`end`
 * are inclusive family-tz calendar dates (ADR-0037) — the same convention as
 * `BudgetPeriodInput`, so `transactionInPeriod` is the one membership rule.
 * `trailing_6_months` is the emergency-fund burn window: the six COMPLETE
 * calendar months preceding the requested month (the requested month itself
 * is still accumulating and is deliberately excluded). `next_30_days` (slice
 * #4) is the only FORWARD-looking kind: `start` is "today" and `end` is
 * today + 30 calendar days in `timezone`, inclusive of both endpoints. It
 * describes scheduled future obligations, not recorded activity, so no honest
 * partial-period metadata can exist for it — such cards always report
 * `periodPartial: false`. `previous_month` (slice #5, now in use) is the
 * spending-trend BASELINE window: days 1..N of the month before the
 * requested month when the request is the in-progress month (N = the same
 * day-of-month the current side of the delta covers), or the FULL previous
 * month for a past request, when both sides are complete. The `Insight`
 * envelope carries only this ONE window — the baseline is the value the
 * delta is computed against, and the compared current period is disclosed in
 * the card's metrics (ADR-0059 slice-#5 amendment). */
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
  /** True when something user-relevant makes the shown figures smaller than
   * reality, and the card says what. Two causes exist TODAY, and the field
   * does not yet encode them uniformly: a row excluded because no FX rate
   * resolved (always paired with `fxPendingCount`) — every derivation sets
   * `partial` from that count alone — and, since slice #5, a requested
   * month still in progress (paired with copy and a metric that state the
   * days elapsed) — which ONLY `spending_trend` sets
   * (`fxPendingCount > 0 || isCurrentMonth`); the other four cards still
   * report `false` for an in-progress period. Unifying the vocabulary is a
   * cross-slice change DEFERRED to a follow-up (ADR-0059 slice-#5
   * amendment) rather than a silent redefinition of a shared wire field
   * mid-milestone. A partial insight may show a smaller-than-reality
   * number — but only alongside what explains why, never as a silent
   * understatement. */
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
  /** Expense rows whose family-tz dates can fall inside a payday window —
   * and the whole detection corpus for `recurring_bills` (slice #4). */
  expenseRows: ReadonlyArray<InsightFlowRow>
  /** Every live anchor-chain hole in the family (PER-443); each derivation
   * intersects its OWN window against them, so a gap that misses
   * `since_payday` still qualifies a calendar-month card and vice versa. */
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>
  /** Every family account, flat and UNFILTERED (PER-227 slice #3): the
   * designated-savings predicate (active + ASSET class + `savings` product
   * subtype) lives in the pure fold below, so unit tests can prove exactly
   * which accounts count — the seam never pre-filters. */
  accountRows: ReadonlyArray<InsightAccountRow>
  /** The latest foreign→base rate per pair (slice #3). The fold resolves
   * through `buildLatestRateResolver` — the SAME resolver the net-worth
   * cards use (ADR-0038 §5) — so this card can never disagree with net
   * worth about what a balance is worth in base currency. */
  fxRateRows: ReadonlyArray<InsightFxRateRow>
  /** Family-tz calendar dates (YYYY-MM-DD) of the FIRST and LAST non-deleted
   * ledger rows, or `null` when the family has no recorded history at all
   * (slice #3). The burn window counts only months this span covers
   * end-to-end — see `deriveEmergencyFund` (Rule E, ADR-0059 amendment). */
  historyRange: { start: string; end: string } | null
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
 * flat, DB-agnostic projection discipline as `InsightTransferRow`. Consumed
 * by two derivations:
 *   - `since_payday`: `accountId`, `date`, `amount`, `merchantName`,
 *     `description` feed `detectRecurringSeries` (native magnitudes — never
 *     displayed), and `date`, `baseAmount`, `isSplit`, `splitEntries`,
 *     `currency`, `baseCurrency`, `fxRateScaled` feed the cash-flow fold,
 *     byte-for-byte the same rules the budget/cash-flow engines apply to the
 *     same rows;
 *   - `emergency_fund` (expense rows only): the trailing-months burn folds
 *     through the SAME `addFlowRow` rules, so the target can never disagree
 *     with the cash-flow engine about what spending is.
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

/**
 * One family account as loaded by `src/server/insights.ts` — deliberately the
 * same flat, DB-agnostic projection discipline as the other row types, and
 * deliberately UNFILTERED (no class/subtype/deletion filtering in SQL): the
 * designated-savings predicate is a locked domain rule that belongs in the
 * pure fold, where unit tests can prove it. `nativeBalance` is the account's
 * CURRENT ledger balance in its own currency (minor units) — never
 * pre-converted, never a valuation snapshot.
 */
export interface InsightAccountRow {
  id: string
  name: string
  accountClass: string
  accountSubtype: string
  currency: string
  nativeBalance: bigint
  /** `null` = never soft-deleted; a timestamp = soft-deleted (PER-183 sets
   * `status="closed"`, `archivedAt` AND `deletedAt` together) and therefore
   * never designated savings. Note this alone is NOT the active test: an
   * ARCHIVED account also has `deletedAt === null` — see `status`/`archivedAt`
   * and `isDesignatedSavingsAccount`. */
  deletedAt: Date | null
  /** `"active" | "closed"` (DB CHECK domain). `"closed"` = archived (soft
   * close, PER-143): the balance row survives but is no longer actively
   * managed, so it is excluded from designated savings. */
  status: string
  /** Set when the account was archived; `null` while active. */
  archivedAt: Date | null
}

/**
 * One latest foreign→base FX rate pair as loaded by `src/server/insights.ts`
 * (PER-227 slice #3) — the exact shape `buildLatestRateResolver` consumes
 * (net-worth's shared resolver), so this engine resolves rates identically
 * to the net-worth cards (ADR-0038 §5, ADR-0058 D3).
 */
export interface InsightFxRateRow {
  fromCurrency: string
  toCurrency: string
  /** 1e12-scaled major→major rate. */
  rateScaled: bigint
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
  /** Every family account, unfiltered — see `InsightContext.accountRows`. */
  accountRows: ReadonlyArray<InsightAccountRow>
  /** Latest foreign→base rates — see `InsightContext.fxRateRows`. */
  fxRateRows: ReadonlyArray<InsightFxRateRow>
  /** First→last non-deleted ledger dates — see `InsightContext.historyRange`. */
  historyRange: { start: string; end: string } | null
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

/**
 * A `YYYY-MM` shifted by whole calendar months (negative = earlier). Pure
 * calendar arithmetic on the Y-M components (the same technique as
 * `subtractCalendarMonths` in src/server/reporting.ts); `Date.UTC` is not
 * needed because a month string has no day to clamp.
 */
export function shiftCalendarMonth(month: string, delta: number): string {
  const match = MONTH_PATTERN.exec(month)
  if (!match) {
    throw new Error(`shiftCalendarMonth: month must be YYYY-MM, got "${month}"`)
  }
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta
  const year = Math.floor(total / 12)
  const monthIndex = ((total % 12) + 12) % 12
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`
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
    accountRows: input.accountRows,
    fxRateRows: input.fxRateRows,
    historyRange: input.historyRange,
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
  window: BudgetPeriodInput
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

// ---------------------------------------------------------------------------
// Slice #3 — `emergency_fund`
// ---------------------------------------------------------------------------

/** How many months of spending the target covers (locked basis: 6× — see the
 * ADR-0059 PER-227 amendment for the rejected alternatives). */
const EMERGENCY_FUND_TARGET_MONTHS = 6

/** Below this many COMPLETE recorded months the burn average would be a
 * guess, not a fact — the card skips rather than averaging a window the
 * ledger barely covers (honesty rule, not a tuning knob). */
const EMERGENCY_FUND_MIN_MONTHS = 2

/** Max names printed in a capped name-list metric (counted accounts, due
 * bills), then `+n`. */
const MAX_LISTED_NAMES = 3

/**
 * The locked "saved" basis (PER-227 design pass, ADR-0059 amendment): an
 * account is designated savings when it is LIVE — `status === "active"` with
 * `archivedAt === null` AND `deletedAt === null` — of ASSET class, and its
 * product subtype is `savings` — ANY accountType
 * counts, because Indonesian households park emergency money in
 * money-market mutual funds (an INVESTMENT-class ASSET with the `savings`
 * subtype is the norm here, not an edge case). A LIABILITY account never
 * qualifies even if its product string says "savings": a savings-flavoured
 * credit product is debt, not a fund.
 *
 * ARCHIVED (`status="closed"`) accounts are excluded even though their
 * balance rows survive the soft close: archiving means the household stopped
 * actively managing that money, and counting it would silently OVERSTATE the
 * fund with no badge saying so. This is a deliberate asymmetry with net
 * worth and the reporting engines, which still include archived balances —
 * those answer "everything you own"; this card answers "live earmarked
 * money".
 */
function isDesignatedSavingsAccount(row: InsightAccountRow): boolean {
  return (
    row.status === "active" &&
    row.archivedAt === null &&
    row.deletedAt === null &&
    row.accountClass === "ASSET" &&
    row.accountSubtype === SAVINGS_SUBTYPE
  )
}

/** A capped name list as the cards print it: sorted LOCALLY inside the fold
 * (determinism is a local contract, never a dependency on the seam's read
 * order), at most `MAX_LISTED_NAMES` names, then `+n` — auditable (which
 * items make up the figure) without turning the card into a roster. Shared
 * by the emergency-fund "Counted accounts" metric and the recurring-bills
 * "Due bills" metric. The comparator is `localeCompare`, NOT code-unit
 * `<`/`>`: byte order puts "Zakat" before "dana darurat" (uppercase sorts
 * first), which is not alphabetical to a human (Sonar S2871). */
function formatSortedNameList(names: ReadonlyArray<string>): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const shown = sorted.slice(0, MAX_LISTED_NAMES)
  const rest = sorted.length - shown.length
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ")
}

/** Saved-side totals of the designated-savings fold. */
interface SavedFundTotals {
  saved: bigint
  fxPendingCount: number
  countedNames: ReadonlyArray<string>
}

/** Saved-side fold (PER-227 slice #3): the CURRENT balances of the
 * already-qualified accounts (qualification is `isDesignatedSavingsAccount`,
 * unit-tested directly), converted through the SAME latest-rate resolver the
 * net-worth cards use, so this card can never disagree with net worth. A
 * foreign balance with no rate is excluded AND counted; the counted-names
 * collection drives the auditable "Counted accounts" metric. Pure. */
function foldSavedFund(
  accounts: ReadonlyArray<InsightAccountRow>,
  baseCurrency: string,
  resolveRate: RateResolver
): SavedFundTotals {
  let saved = 0n
  let fxPendingCount = 0
  const countedNames: string[] = []
  for (const account of accounts) {
    if (account.currency !== baseCurrency) {
      const rate = resolveRate(account.currency)
      if (rate === null) {
        fxPendingCount += 1
        continue
      }
      saved += convertMinor(
        account.nativeBalance,
        account.currency as CurrencyCode,
        baseCurrency as CurrencyCode,
        rate
      ) as bigint
    } else {
      saved += account.nativeBalance
    }
    countedNames.push(account.name)
  }
  return { saved, fxPendingCount, countedNames }
}

/** Rule E (locked, ADR-0059 amendment): the trailing months recorded
 * end-to-end by the family ledger. A candidate month counts only when
 * `historyRange` — the family-tz dates of the first and last non-deleted
 * ledger rows — covers it start-to-end. A month the family joined mid-way is
 * EXCLUDED, never diluted (its burn would be a fragment presented as a
 * month); a month with zero rows inside the covered span still counts, with
 * zero burn. Months after a lapsed period (no rows since the last one) drop
 * out the same way. Pure. */
function coveredTrailingMonths(
  month: string,
  history: { start: string; end: string } | null,
  lookbackMonths: number
): string[] {
  if (history === null) return []
  const covered: string[] = []
  for (let i = lookbackMonths; i >= 1; i -= 1) {
    const candidate = shiftCalendarMonth(month, -i)
    const bounds = calendarMonthBounds(candidate)
    if (bounds.start >= history.start && bounds.end <= history.end) {
      covered.push(candidate)
    }
  }
  return covered
}

/** Burn totals of the trailing-months fold. */
interface BurnFundTotals {
  spent: bigint
  fxPendingCount: number
}

/** Burn-side fold (PER-227 slice #3): spending in the USED months only.
 * Month-key membership (not window membership) is what enforces Rule E — the
 * requested month and any history-incomplete month fall outside `usedMonths`
 * by construction. Money rules are the shared `addFlowRow` fold (split
 * parents contribute via their children at the parent's stored rate;
 * FX-pending rows excluded AND counted; transfers never appear here — the
 * burn consumes expense rows only, so a movement into savings can never
 * inflate spending and deflate the gap in one card). Pure. */
function foldBurnInUsedMonths(
  expenseRows: ReadonlyArray<InsightFlowRow>,
  usedMonths: ReadonlyArray<string>,
  timezone: string
): BurnFundTotals {
  const usedMonthSet = new Set(usedMonths)
  const totals: FlowTotals = { income: 0n, spent: 0n, fxPendingCount: 0 }
  for (const row of expenseRows) {
    const rowMonth = calendarDateInZone(row.date, timezone).slice(0, 7)
    if (usedMonthSet.has(rowMonth)) addFlowRow(totals, row, false)
  }
  return { spent: totals.spent, fxPendingCount: totals.fxPendingCount }
}

/** The rendered card, assembled from the two folds' results. Metric order is
 * the generic renderer's contract: the FIRST money metric is the headline
 * ("Saved"), every labelled metric after it a supporting line — no renderer
 * branch knows this insight's id. Tone: the family is "behind" only when the
 * gap is positive. Pure. */
function buildEmergencyFundInsight(input: {
  baseCurrency: string
  burnWindow: InsightWindow
  burn: BurnFundTotals
  monthsUsed: number
  saved: SavedFundTotals
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>
}): Insight {
  const { baseCurrency, burnWindow, burn, monthsUsed, saved } = input
  // Truncating division — never a rounded-up target the family must beat.
  const target =
    (burn.spent * BigInt(EMERGENCY_FUND_TARGET_MONTHS)) / BigInt(monthsUsed)
  const gap = target - saved.saved
  const fxPendingCount = saved.fxPendingCount + burn.fxPendingCount
  const partialWindow = monthsUsed < EMERGENCY_FUND_TARGET_MONTHS
  const periodGaps = periodGapsForWindow(input.anchorGaps, burnWindow)

  return {
    id: EMERGENCY_FUND_INSIGHT_ID,
    tone: gap > 0n ? "attention" : "positive",
    title: "Emergency fund",
    summary: "What you've set aside versus 6× your average monthly spending.",
    detail: `Based on ${monthsUsed} complete months of recorded spending.`,
    metrics: [
      {
        key: "saved",
        label: "Saved",
        value: saved.saved.toString(),
        currency: baseCurrency,
      },
      {
        key: "target",
        label: "Target",
        value: target.toString(),
        currency: baseCurrency,
      },
      {
        key: "gap",
        label: "Gap",
        value: gap.toString(),
        currency: baseCurrency,
      },
      ...(partialWindow
        ? [
            {
              key: "partial_window",
              label: "Months used",
              value: `${monthsUsed} of ${EMERGENCY_FUND_TARGET_MONTHS}`,
            },
          ]
        : []),
      {
        key: "counted_accounts",
        label: "Counted accounts",
        value: formatSortedNameList(saved.countedNames),
      },
      { key: "fx_pending_count", value: String(fxPendingCount) },
    ],
    partial: fxPendingCount > 0,
    fxPendingCount,
    periodPartial: periodGaps.length > 0,
    periodGaps,
    window: burnWindow,
    engineVersion: INSIGHTS_ENGINE_VERSION,
  }
}

/**
 * Slice #3 derivation — `emergency_fund`.
 *
 * Saved is the CURRENT BALANCE of every designated-savings account (the
 * locked basis A), converted through the SAME latest-rate resolver the
 * net-worth cards use, so this card can never disagree with net worth. The
 * target is 6 × the average monthly spending burn over the six COMPLETE
 * family-tz months before the requested month (the requested month is still
 * accumulating and is deliberately excluded). A burn month counts only when
 * recorded history covers it end-to-end (Rule E below), and the months
 * actually used are disclosed whenever fewer than six qualified.
 *
 * Money rules are byte-for-byte the budget/cash-flow engines': split parents
 * contribute via their children at the parent's stored rate, FX-pending rows
 * are excluded AND counted, transfers are neither income nor expense (the
 * burn consumes expense rows only, so a movement into savings can never
 * inflate spending and deflate the gap in one card).
 *
 * Skip-vs-zero honesty: no designated account → skip; every designated
 * balance pending an FX rate → skip; every burn row in the used months
 * pending an FX rate → skip (a zero burn reached only by excluding rows is
 * not a fact); too little recorded history → skip. A genuine ZERO balance
 * renders Rp 0 — that is a fact about the ledger, not an absence of one.
 */
function deriveEmergencyFund(context: InsightContext): DerivationOutcome {
  const { window: monthWindow, baseCurrency } = context
  const timezone = monthWindow.timezone
  // The report window IS the requested calendar month (see buildInsightContext).
  const month = monthWindow.start.slice(0, 7)

  // ---- Saved: current balances of designated-savings accounts ----
  const qualifying = context.accountRows.filter(isDesignatedSavingsAccount)
  if (qualifying.length === 0) {
    return {
      insight: null,
      skippedReason: "no account is designated as savings",
    }
  }

  const saved = foldSavedFund(
    qualifying,
    baseCurrency,
    buildLatestRateResolver(context.fxRateRows, baseCurrency)
  )
  if (saved.countedNames.length === 0) {
    return {
      insight: null,
      skippedReason:
        "every designated savings balance is pending an exchange rate",
    }
  }

  // ---- Target: 6 × the average monthly burn, trailing COMPLETE months ----
  const burnWindow: InsightWindow = {
    kind: "trailing_6_months",
    start: calendarMonthBounds(
      shiftCalendarMonth(month, -EMERGENCY_FUND_TARGET_MONTHS)
    ).start,
    end: calendarMonthBounds(shiftCalendarMonth(month, -1)).end,
    timezone,
  }

  // Rule E (locked, ADR-0059 amendment) lives in `coveredTrailingMonths`.
  const usedMonths = coveredTrailingMonths(
    month,
    context.historyRange,
    EMERGENCY_FUND_TARGET_MONTHS
  )
  const monthsUsed = usedMonths.length
  if (monthsUsed < EMERGENCY_FUND_MIN_MONTHS) {
    return {
      insight: null,
      skippedReason: "fewer than two complete months of recorded history",
    }
  }

  // Burn = spending in the USED months only — see `foldBurnInUsedMonths`
  // (month-key membership is what enforces Rule E).
  const burn = foldBurnInUsedMonths(context.expenseRows, usedMonths, timezone)

  // Skip-vs-zero, burn side: a zero burn is a FACT about the ledger (real
  // covered months with no spending — see the zero-burn month rule) only when
  // nothing was excluded to reach it. If every burn row in the used months is
  // FX-pending, the zero is an artifact of missing rates — rendering a
  // fabricated Rp 0 target with a `positive` tone would be exactly the
  // confident zero the honesty rules forbid.
  if (burn.spent === 0n && burn.fxPendingCount > 0) {
    return {
      insight: null,
      skippedReason: "every burn row in the window is pending an exchange rate",
    }
  }

  return {
    insight: buildEmergencyFundInsight({
      baseCurrency,
      burnWindow,
      burn,
      monthsUsed,
      saved,
      anchorGaps: context.anchorGaps,
    }),
  }
}

// ---------------------------------------------------------------------------
// Slice #4 — `recurring_bills`
// ---------------------------------------------------------------------------

/** Window length in calendar days, inclusive of both endpoints: due means
 * nextExpected on or before today + this many family-tz days. */
const RECURRING_BILLS_WINDOW_DAYS = 30

/** A series is only "predicted from recorded payments" when the ledger
 * actually covers a run of COMPLETE months behind it; below this many, the
 * projection rests on too little to render (honesty rule, not a tuning
 * knob — distinct from "nothing is due", which renders the empty card). */
const RECURRING_BILLS_MIN_MONTHS = 3

/** The detection lookback in complete months (the seam's expense load spans
 * 7 months, so at most 6 COMPLETE months can precede the current one). Also
 * the disclosure cap for the "Months of history" metric. */
const RECURRING_BILLS_LOOKBACK_MONTHS = 6

/** Deliberately duplicated from `DAY_MS` in `src/lib/account-recurring.ts`
 * rather than exported from there: that constant is module-private, and
 * exporting it would widen the knip export surface purely for cosmetics
 * (won't-do ruling, PER-227 review). */
const MS_PER_DAY = 86_400_000

/**
 * A family-tz calendar date (YYYY-MM-DD) shifted by whole calendar days.
 * Pure calendar arithmetic: `Date.UTC` is used only as a calendar calculator
 * to roll the day across month/year boundaries, never to represent a
 * wall-clock instant — the same technique as `calendarMonthBounds`.
 */
function addCalendarDays(date: string, days: number): string {
  const parts = date.split("-").map(Number)
  const shifted = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days))
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const day = String(shifted.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * The detector's input for the bills side, with the two honest exclusions
 * applied up front:
 *
 *   - EXPENSE rows only, mapped as expenses. `detectRecurringSeries` has no
 *     direction option (the anchor helper fixes every row to "income"), so
 *     this caller-side filter IS the direction rule: an income series (a
 *     salary) must never appear on a bills card.
 *   - Amounts are the frozen BASE-currency magnitudes (ADR-0035 §4), so
 *     every series' typical amount shares ONE currency and the due-soon sum
 *     is a valid base-minor figure. FX-pending rows (no frozen projection)
 *     are excluded AND counted — a native magnitude could not be summed
 *     into a base-currency prediction.
 *   - Rows dated AFTER today are dropped: a future row is a schedule, not
 *     an occurrence. Feeding it would drag `lastOccurrence` forward and can
 *     hide a bill that IS actually due (the previous occurrence is what
 *     anchors the projection).
 *
 * A split parent contributes its own amount (the whole receipt is one
 * occurrence) — never its children, which would shred one bill into
 * fragments the detector cannot cluster.
 */
function buildRecurringDetectionInput(context: InsightContext): {
  txns: Array<RecurringTxn>
  fxPendingCount: number
} {
  const timezone = context.window.timezone
  const today = calendarDateInZone(context.now, timezone)
  const txns: Array<RecurringTxn> = []
  let fxPendingCount = 0
  for (const row of context.expenseRows) {
    // Order matters for the pending count: the future-date drop runs FIRST,
    // scoped to the SAME rows detection will use — a future row is neither
    // an occurrence nor a pending occurrence, so it must be uncounted in
    // both branches (mirrors `emergency_fund`'s window-scoped pending count).
    if (calendarDateInZone(row.date, timezone) > today) continue
    if (
      row.baseAmount === null ||
      row.fxRateScaled === null ||
      row.baseCurrency === null
    ) {
      fxPendingCount += 1
      continue
    }
    const magnitude = row.baseAmount < 0n ? -row.baseAmount : row.baseAmount
    txns.push({
      accountId: row.accountId,
      date: row.date,
      amount: magnitude,
      type: "expense",
      merchant: row.merchantName === null ? null : { name: row.merchantName },
      description: row.description,
    })
  }
  return { txns, fxPendingCount }
}

/** Due-soon membership: the projected next occurrence's family-tz calendar
 * date is on or before the window end — the SAME date-string rule
 * `transactionInPeriod` uses. There is deliberately NO lower bound: an
 * OVERDUE series (nextExpected already past) is still a bill that must be
 * paid, and the detector's staleness guard already bounds how far past due
 * a series can stay (two cadence bands' worth of days). Re-sorted
 * soonest-due first with a locale label tie-break, because the detector's
 * own sort breaks ties by grouping key — code-unit order, not human
 * alphabetical (Sonar S2871 forbids `<`/`>` on the strings). */
function filterDueSoon(
  series: ReadonlyArray<RecurringSeries>,
  windowEnd: string,
  timezone: string
): RecurringSeries[] {
  const due = series.filter(
    (candidate) =>
      calendarDateInZone(candidate.nextExpected, timezone) <= windowEnd
  )
  return due.sort((a, b) => {
    const gap = a.nextExpected.getTime() - b.nextExpected.getTime()
    if (gap !== 0) return gap
    return a.label.localeCompare(b.label)
  })
}

/** Human relative-due text, computed in family-tz CALENDAR days: both dates
 * are parsed as UTC midnights of their YYYY-MM-DD forms, so the difference
 * is a pure date difference — never a wall-clock duration that a DST shift
 * could smear across a day boundary. */
function formatRelativeDue(
  nextExpected: Date,
  today: string,
  timezone: string
): string {
  const dueDate = calendarDateInZone(nextExpected, timezone)
  const days = Math.round(
    (Date.parse(dueDate) - Date.parse(today)) / MS_PER_DAY
  )
  if (days === 0) return "due today"
  if (days === 1) return "due tomorrow"
  if (days > 1) return `due in ${days} days`
  return `${-days} days overdue`
}

/** The cadence mix as the card prints it — a FIXED ladder (monthly, then
 * biweekly, then weekly: dominant cadences first by design), never a string
 * sort, which would print "biweekly, monthly, weekly" and bury the shape of
 * the household's obligation load. */
function cadenceMixText(series: ReadonlyArray<RecurringSeries>): string {
  const counts: Record<RecurringCadence, number> = {
    monthly: 0,
    biweekly: 0,
    weekly: 0,
  }
  for (const candidate of series) counts[candidate.cadence] += 1
  return (["monthly", "biweekly", "weekly"] as const)
    .filter((cadence) => counts[cadence] > 0)
    .map((cadence) => `${counts[cadence]} ${cadence}`)
    .join(", ")
}

/** The rendered card. Metric order is the generic renderer's contract: the
 * FIRST money metric is the headline, every labelled metric after it a
 * supporting line. Tone is ALWAYS `neutral`: the engine is diagnostic, and a
 * predicted obligation is not yet a fact to escalate (the ADR-0059 amendment
 * records why no `attention` rule exists here). `periodPartial` is always
 * `false` with no gaps: a forward window contains no recorded activity, so
 * PER-443's past-tense axis has nothing honest to report. Pure. */
function buildRecurringBillsInsight(input: {
  baseCurrency: string
  window: InsightWindow
  /** Full DETECTED series list (before the due-window filter) — the empty
   * copy keys off this so "detected but nothing due" never reads as
   * "nothing detected". */
  detectedCount: number
  due: ReadonlyArray<RecurringSeries>
  historyMonths: number
  fxPendingCount: number
  timezone: string
}): Insight {
  const {
    baseCurrency,
    window,
    detectedCount,
    due,
    historyMonths,
    fxPendingCount,
    timezone,
  } = input
  const predicted = due.reduce((sum, s) => sum + s.typicalAmountMinor, 0n)
  const paymentCount = due.reduce((sum, s) => sum + s.occurrenceCount, 0)
  const nearest = due[0]
  const isEmpty = due.length === 0
  // Interpolated so a window change cannot silently lie in the copy. The
  // window-kind NAME (`next_30_days`) is a string-literal union type and
  // cannot interpolate — it stays a literal by design.
  const windowLabel = `next ${RECURRING_BILLS_WINDOW_DAYS} days`

  return {
    id: RECURRING_BILLS_INSIGHT_ID,
    tone: "neutral",
    title: "Bills due soon",
    summary: isEmpty
      ? detectedCount === 0
        ? // Nothing DETECTED at all — a true claim about detection over the
          // covered COMPLETE months (the current partial month is also
          // searched, so this is a floor, never an overstatement).
          `No recurring outflows detected in the last ${historyMonths} complete months of recorded history.`
        : // Detected, but nothing lands inside the window — a fact about the
          // schedule, NEVER "not detected".
          `No recurring bills are due in the next ${RECURRING_BILLS_WINDOW_DAYS} days.`
      : `Predicted recurring outflows over the ${windowLabel} — an estimate from recorded payments, not money already spent.`,
    detail: isEmpty
      ? `Nothing is predicted to be due within the ${windowLabel}.`
      : `Based on ${paymentCount} past payments across ${historyMonths} months of recorded history.`,
    metrics: [
      {
        key: "predicted_total",
        label: isEmpty
          ? `Predicted for the ${windowLabel}`
          : `Predicted from ${paymentCount} past payments`,
        value: predicted.toString(),
        currency: baseCurrency,
      },
      { key: "series_count", label: "Bills due", value: String(due.length) },
      ...(nearest
        ? [
            {
              key: "nearest_bill",
              label: `Nearest (${nearest.label}, ${formatRelativeDue(nearest.nextExpected, window.start, timezone)})`,
              value: nearest.typicalAmountMinor.toString(),
              currency: baseCurrency,
            },
          ]
        : []),
      ...(isEmpty
        ? []
        : [
            {
              key: "cadence_mix",
              label: "Cadence",
              value: cadenceMixText(due),
            },
            {
              key: "due_bills",
              label: "Due bills",
              value: formatSortedNameList(due.map((s) => s.label)),
            },
          ]),
      {
        key: "history_months",
        label: "Months of history",
        value: String(historyMonths),
      },
      { key: "fx_pending_count", value: String(fxPendingCount) },
    ],
    partial: fxPendingCount > 0,
    fxPendingCount,
    periodPartial: false,
    periodGaps: [],
    window,
    engineVersion: INSIGHTS_ENGINE_VERSION,
  }
}

/**
 * Slice #4 derivation — `recurring_bills`.
 *
 * The registry's only FORWARD-looking card: predicted recurring outflows due
 * within the next 30 family-tz calendar days (inclusive of today and of
 * today+30), plus anything already overdue. The amount is the summed
 * `typicalAmountMinor` of the due series in base-minor units — a PREDICTION,
 * so the card says so in its label-led copy; the tone is always neutral.
 *
 * Two guards run before detection, each with its own skip reason:
 *   1. Current-month only (the same rule as since_payday): the window is
 *      "now"-relative by nature, and a historical month would render a
 *      LYING empty card — the detector's staleness guard drops series whose
 *      last occurrence is two cadence bands old, so the further back the
 *      month, the more bills silently vanish.
 *   2. History floor: fewer than three COMPLETE recorded months (Rule E's
 *      covered-months test, six-month lookback) and "predicted from recorded
 *      payments" is a guess. With adequate history and nothing due we RENDER
 *      the honest empty card — a fact about the schedule — never skip.
 */
function deriveRecurringBills(context: InsightContext): DerivationOutcome {
  const { window: monthWindow, baseCurrency, now } = context
  const timezone = monthWindow.timezone
  const month = monthWindow.start.slice(0, 7)
  const today = calendarDateInZone(now, timezone)

  if (month !== currentMonthInZone(now, timezone)) {
    return {
      insight: null,
      skippedReason: "recurring bills only apply to the family's current month",
    }
  }

  const coveredMonths = coveredTrailingMonths(
    month,
    context.historyRange,
    RECURRING_BILLS_LOOKBACK_MONTHS
  )
  if (coveredMonths.length < RECURRING_BILLS_MIN_MONTHS) {
    return {
      insight: null,
      skippedReason: "fewer than three complete months of recorded history",
    }
  }

  const { txns, fxPendingCount } = buildRecurringDetectionInput(context)
  const detected = detectRecurringSeries(txns, { now })
  const windowEnd = addCalendarDays(today, RECURRING_BILLS_WINDOW_DAYS)
  const due = filterDueSoon(detected, windowEnd, timezone)

  return {
    insight: buildRecurringBillsInsight({
      baseCurrency,
      window: {
        kind: "next_30_days",
        start: today,
        end: windowEnd,
        timezone,
      },
      detectedCount: detected.length,
      due,
      historyMonths: coveredMonths.length,
      fxPendingCount,
      timezone,
    }),
  }
}

// ---------------------------------------------------------------------------
// Slice #5 — `spending_trend`
// ---------------------------------------------------------------------------

/** The two sides of the like-for-like delta as family-tz calendar dates.
 * `currentStart..currentEnd` is the current side: days 1..N of the REQUESTED
 * month (N = today's day-of-month for the in-progress month; the whole month
 * for a past request). `previousStart..previousCompareEnd` is the previous
 * month's SAME-DAYS baseline (clipped to that month's actual length, so a
 * 31-day today against a 28-day February compares honestly); `previousEnd`
 * additionally spans the whole previous month for the context figure. */
interface TrendWindows {
  month: string
  previousMonth: string
  currentStart: string
  currentEnd: string
  previousStart: string
  previousEnd: string
  previousCompareEnd: string
  currentDays: number
  previousDays: number
}

/** Day-of-month of an inclusive family-tz calendar date (YYYY-MM-DD). */
function dayOfDate(date: string): number {
  return Number(date.slice(8, 10))
}

/**
 * Resolve both comparison windows for the requested month. `isCurrentMonth`
 * is what makes this card either PARTIAL (the in-progress month cuts both
 * sides at today, and `partial: true` follows) or COMPLETE (a past request
 * degenerates to full-month-vs-full-month — see `previousDays`). Pure calendar
 * arithmetic; `today` is the family-tz date, injected with `now`.
 */
function buildTrendWindows(
  month: string,
  today: string,
  isCurrentMonth: boolean
): TrendWindows {
  const current = calendarMonthBounds(month)
  const previous = calendarMonthBounds(shiftCalendarMonth(month, -1))
  const currentDays = isCurrentMonth ? dayOfDate(today) : dayOfDate(current.end)
  const previousDays = isCurrentMonth
    ? Math.min(currentDays, dayOfDate(previous.end))
    : dayOfDate(previous.end)
  return {
    month,
    previousMonth: shiftCalendarMonth(month, -1),
    currentStart: current.start,
    currentEnd: isCurrentMonth ? today : current.end,
    previousStart: previous.start,
    previousEnd: previous.end,
    previousCompareEnd: addCalendarDays(previous.start, previousDays - 1),
    currentDays,
    previousDays,
  }
}

/**
 * History floor (rule, not a tuning knob): every COMPLETE month the
 * comparison touches must be covered end-to-end by recorded history — the
 * previous month always, and the requested month too when it is a past
 * request (Rule E's coverage test, the same one `emergency_fund` uses).
 * The in-progress month is exempt by nature: its end has not happened yet.
 * Below this floor the delta would compare against a fragment or nothing at
 * all — a comparison against nothing is fabrication, so the card skips.
 *
 * Returns the skip REASON, and it must be true in the state that produces
 * it: "fewer than two complete months of recorded history" only when the
 * history genuinely is that short. A long-tenured family whose ledger
 * stopped mid-month fails the same coverage test for a different reason,
 * and the count claim would be false there — it gets its own reason.
 */
function trendHistorySkipReason(
  month: string,
  isCurrentMonth: boolean,
  history: { start: string; end: string } | null
): string | null {
  if (history === null) {
    return "fewer than two complete months of recorded history"
  }
  const required = isCurrentMonth
    ? [shiftCalendarMonth(month, -1)]
    : [shiftCalendarMonth(month, -1), month]
  const missing = required.filter((candidate) => {
    const bounds = calendarMonthBounds(candidate)
    return bounds.start < history.start || bounds.end > history.end
  })
  if (missing.length === 0) return null
  if (completeMonthsInHistory(history) < 2) {
    return "fewer than two complete months of recorded history"
  }
  return missing.includes(month)
    ? "the requested month was not recorded end-to-end"
    : "last month was not recorded end-to-end"
}

/** How many COMPLETE calendar months the recorded-history span covers
 * end-to-end — the honest count behind the "fewer than two complete months"
 * reason. A span that starts or stops mid-month counts only the months it
 * actually covers. */
function completeMonthsInHistory(history: {
  start: string
  end: string
}): number {
  let count = 0
  for (
    let candidate = history.start.slice(0, 7);
    candidate <= history.end.slice(0, 7);
    candidate = shiftCalendarMonth(candidate, 1)
  ) {
    const bounds = calendarMonthBounds(candidate)
    if (bounds.start >= history.start && bounds.end <= history.end) {
      count += 1
    }
  }
  return count
}

/** Which side(s) one row's family-tz date belongs to. A row is never in
 * both months, but `inPrevious` (full context month) is a superset of
 * `inPreviousCompare` (the like-for-like baseline). */
interface TrendMembership {
  inCurrent: boolean
  inPrevious: boolean
  inPreviousCompare: boolean
}

function classifyTrendDate(
  date: string,
  windows: TrendWindows
): TrendMembership {
  return {
    inCurrent: date >= windows.currentStart && date <= windows.currentEnd,
    inPrevious: date >= windows.previousStart && date <= windows.previousEnd,
    inPreviousCompare:
      date >= windows.previousStart && date <= windows.previousCompareEnd,
  }
}

/** Fold totals of the three displayed money figures, plus the two
 * FX-pending counts: `fxPendingCount` covers every row excluded from ANY
 * displayed figure (the current window and the complete previous month), and
 * `previousPeriodPendingCount` is scoped to the baseline window alone — it
 * exists only to keep a zero baseline honest (the skip guard below). */
interface TrendTotals {
  currentSpend: bigint
  previousSpend: bigint
  previousMonthTotal: bigint
  fxPendingCount: number
  previousPeriodPendingCount: number
}

/** One row into the totals. Money rules are byte-for-byte `addFlowRow`'s
 * (split parents contribute via their children at the parent's stored rate;
 * FX-pending rows excluded AND counted, counted ONCE even when the row
 * touches two of the figures). A row outside both months never reaches the
 * fold — notably the previous month's days after the cutoff: they feed the
 * context figure, never the like-for-like comparison. */
function foldTrendRow(
  totals: TrendTotals,
  row: InsightFlowRow,
  windows: TrendWindows,
  timezone: string
): void {
  const membership = classifyTrendDate(
    calendarDateInZone(row.date, timezone),
    windows
  )
  if (!membership.inCurrent && !membership.inPrevious) return

  const rowTotals: FlowTotals = { income: 0n, spent: 0n, fxPendingCount: 0 }
  addFlowRow(rowTotals, row, false)
  if (rowTotals.fxPendingCount > 0) {
    totals.fxPendingCount += rowTotals.fxPendingCount
    if (membership.inPreviousCompare) {
      totals.previousPeriodPendingCount += rowTotals.fxPendingCount
    }
    return
  }
  if (membership.inCurrent) totals.currentSpend += rowTotals.spent
  if (membership.inPrevious) totals.previousMonthTotal += rowTotals.spent
  if (membership.inPreviousCompare) totals.previousSpend += rowTotals.spent
}

/** Expense-rows fold over both windows — one pass, no double counting. Pure;
 * no clock (the dates were cut in `timezone`, the zone injected upstream). */
function foldTrendTotals(
  expenseRows: ReadonlyArray<InsightFlowRow>,
  windows: TrendWindows,
  timezone: string
): TrendTotals {
  const totals: TrendTotals = {
    currentSpend: 0n,
    previousSpend: 0n,
    previousMonthTotal: 0n,
    fxPendingCount: 0,
    previousPeriodPendingCount: 0,
  }
  for (const row of expenseRows) {
    foldTrendRow(totals, row, windows, timezone)
  }
  return totals
}

/** Delta as a percentage of the previous period, in TENTHS of a percent —
 * integer bigint math, never a float. `null` when the previous period
 * recorded nothing: zero is not a denominator, and Infinity/NaN must never
 * reach the wire (the zero-denominator rule, ADR-0059 slice-#5 amendment). */
function percentChangeTenths(
  delta: bigint,
  previousSpend: bigint
): bigint | null {
  if (previousSpend === 0n) return null
  return (delta * 1000n) / previousSpend
}

/** The percentage as the card prints it: an explicit `+` for "spent more"
 * (mirroring the delta's sign convention), one truncated decimal max, and
 * the documented no-comparison marker when there is no denominator. */
function formatPercentTenths(tenths: bigint | null): string {
  if (tenths === null) return "no comparison possible"
  if (tenths === 0n) return "0%"
  const sign = tenths < 0n ? "-" : "+"
  const magnitude = tenths < 0n ? -tenths : tenths
  const whole = magnitude / 10n
  const fraction = magnitude % 10n
  return fraction === 0n ? `${sign}${whole}%` : `${sign}${whole}.${fraction}%`
}

/** "June 2026" from "2026-06" — a fixed en-US locale so card copy is
 * deterministic (the same Intl discipline as `calendarDateInZone`). */
function monthLabel(month: string): string {
  const date = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
  )
  const name = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })
  return `${name} ${month.slice(0, 4)}`
}

/**
 * The gaps intersecting EITHER side of the delta, deduped by account+start:
 * a hole on either side understates the comparison, so both sides qualify
 * `periodPartial` — PER-443 §3 applied to this derivation's two COMPARED
 * windows with the same shared intersection `emergency_fund` uses for its
 * burn window. A gap that only overlaps the previous month AFTER the cutoff
 * touches the context figure alone, not the comparison, so it deliberately
 * does not flag the card (the context metric is labelled as context).
 */
function trendPeriodGaps(
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>,
  windows: TrendWindows,
  timezone: string
): InsightPeriodGap[] {
  const sides: BudgetPeriodInput[] = [
    { start: windows.currentStart, end: windows.currentEnd, timezone },
    { start: windows.previousStart, end: windows.previousCompareEnd, timezone },
  ]
  const seen = new Set<string>()
  const merged: InsightPeriodGap[] = []
  for (const side of sides) {
    for (const gap of periodGapsForWindow(anchorGaps, side)) {
      const key = `${gap.accountId}:${gap.fromDate}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(gap)
    }
  }
  return merged
}

/** The copy for an in-progress request: it MUST state the days elapsed, so
 * the card can never read as a whole-month claim (rule: the partial current
 * month is unmistakable). The "same days" claim is CONDITIONAL — it is only
 * true when the clamp did not fire; when the previous month is shorter than
 * today's day-of-month the copy says so truthfully (naming the shorter
 * month) instead of contradicting its own numbers. Past requests state the
 * degenerate case instead. */
function trendSummary(windows: TrendWindows, isCurrentMonth: boolean): string {
  if (!isCurrentMonth) {
    return `${monthLabel(windows.month)} versus ${monthLabel(windows.previousMonth)} — both months are complete, so the comparison is like for like.`
  }
  const daysClause =
    windows.currentDays === windows.previousDays
      ? "the same days of each month, never a partial month against a complete one."
      : `${monthLabel(windows.previousMonth)} has only ${windows.previousDays} days, so the comparison stops at the shorter month's length.`
  return `Days 1–${windows.currentDays} of this month versus days 1–${windows.previousDays} of last month — ${daysClause}`
}

/** The second copy line: why the complete-previous-month figure is context,
 * and (when the baseline is genuinely zero) that there is no percentage to
 * show. */
function trendDetail(totals: TrendTotals, isCurrentMonth: boolean): string {
  if (!isCurrentMonth) {
    return "Both months are fully elapsed, so the figures compare two complete months."
  }
  const contextNote =
    "Last month's complete total is shown for context — a whole month versus part of one is not a fair comparison."
  if (totals.previousSpend !== 0n) return contextNote
  return `No spending was recorded in the comparison period last month, so the percentage change has no base. ${contextNote}`
}

/** Metric order is the generic renderer's contract: the FIRST money metric
 * (the like-for-like delta) is the headline, and every metric after it —
 * support lines included — carries a `label`. Sign convention: the delta's
 * value is signed base-minor units and a POSITIVE delta means "spent MORE"
 * than the same days of the previous month; the percentage mirrors it. The
 * complete-previous-month context figure rides along ONLY when it is real
 * context — an in-progress month (for a past request it would duplicate the
 * baseline). Pure. */
function trendMetrics(input: {
  windows: TrendWindows
  totals: TrendTotals
  baseCurrency: string
  isCurrentMonth: boolean
}): InsightMetric[] {
  const { windows, totals, baseCurrency, isCurrentMonth } = input
  const delta = totals.currentSpend - totals.previousSpend
  const baselineLabel = isCurrentMonth
    ? "the same days last month"
    : monthLabel(windows.previousMonth)
  // The context figure is CURRENT-MONTH ONLY: for a past request the baseline
  // window IS the whole previous month, so `previous_month_total` would
  // duplicate `spent_previous_period` byte-identically under two labels —
  // two labels for one number is noise, not honesty.
  const contextMetrics: InsightMetric[] = isCurrentMonth
    ? [
        {
          key: "previous_month_total",
          label: `Full ${monthLabel(
            windows.previousMonth
          )} — complete month, for context`,
          value: totals.previousMonthTotal.toString(),
          currency: baseCurrency,
        },
      ]
    : []
  return [
    {
      key: "delta",
      label: `Difference versus ${baselineLabel}`,
      value: delta.toString(),
      currency: baseCurrency,
    },
    {
      key: "spent_current_period",
      label: isCurrentMonth
        ? `Spent, days 1–${windows.currentDays} this month`
        : `Spent in ${monthLabel(windows.month)}`,
      value: totals.currentSpend.toString(),
      currency: baseCurrency,
    },
    {
      key: "spent_previous_period",
      label: isCurrentMonth
        ? `Spent, days 1–${windows.previousDays} of last month`
        : `Spent in ${monthLabel(windows.previousMonth)}`,
      value: totals.previousSpend.toString(),
      currency: baseCurrency,
    },
    ...contextMetrics,
    {
      key: "days_elapsed",
      label: "Days compared",
      value: `1–${windows.currentDays} vs 1–${windows.previousDays}`,
    },
    {
      key: "percent_change",
      label: `Difference versus ${baselineLabel}, in percent`,
      value: formatPercentTenths(
        percentChangeTenths(delta, totals.previousSpend)
      ),
    },
    {
      key: "fx_pending_count",
      label: "Rows pending an exchange rate",
      value: String(totals.fxPendingCount),
    },
  ]
}

/** The rendered card. Tone is ALWAYS `neutral` — spending more is not
 * automatically bad and spending less is not automatically good (a lower
 * number can be a cancelled medicine), so the card reports the delta and the
 * percentage as facts with no verdict (ADR-0059 slice-#5 amendment).
 * `partial` covers both honest causes: rows excluded for a missing FX rate,
 * and the requested month still in progress (the copy and `days_elapsed`
 * explain that one). Pure. */
function buildSpendingTrendInsight(input: {
  windows: TrendWindows
  totals: TrendTotals
  baseCurrency: string
  anchorGaps: ReadonlyArray<InsightAnchorGapRow>
  timezone: string
  isCurrentMonth: boolean
}): Insight {
  const { windows, totals, baseCurrency, timezone, isCurrentMonth } = input
  const periodGaps = trendPeriodGaps(input.anchorGaps, windows, timezone)
  return {
    id: SPENDING_TREND_INSIGHT_ID,
    tone: "neutral",
    title: "Spending trend",
    summary: trendSummary(windows, isCurrentMonth),
    detail: trendDetail(totals, isCurrentMonth),
    metrics: trendMetrics({ windows, totals, baseCurrency, isCurrentMonth }),
    partial: totals.fxPendingCount > 0 || isCurrentMonth,
    fxPendingCount: totals.fxPendingCount,
    periodPartial: periodGaps.length > 0,
    periodGaps,
    // The BASELINE window — see `InsightWindow`: the envelope carries one
    // window, and the value the delta is computed against is the honest
    // single description of this comparison. The compared current period is
    // disclosed in the metrics.
    window: {
      kind: "previous_month",
      start: windows.previousStart,
      end: windows.previousCompareEnd,
      timezone,
    },
    engineVersion: INSIGHTS_ENGINE_VERSION,
  }
}

/**
 * Slice #5 derivation — `spending_trend`.
 *
 * The like-for-like month comparison: this month's spend over days 1..N
 * versus LAST month's spend over days 1..N (family tz; N = today's
 * day-of-month for the in-progress month, clamped to the previous month's
 * length when that month is shorter — and the copy says so truthfully
 * rather than claiming "the same days"), headline delta = current −
 * previous (positive = spent more), reported neutrally with no verdict. The
 * complete previous month total rides along as a labelled context figure —
 * never as the comparison side, and never for a past request where it would
 * duplicate the baseline. For a past requested month both sides are
 * complete months and `partial` is false.
 *
 * Skips, each with a distinct reason: a month that has not started; a
 * history floor the request falls below — the previous month must be
 * covered end-to-end (Rule E), and a past request the requested month too;
 * the reason is truthful in its state: a genuinely short history gets
 * "fewer than two complete months of recorded history", a long-tenured
 * family whose ledger stopped mid-month gets the not-recorded-end-to-end
 * reason instead (a count claim would be false there); and a baseline whose
 * only rows are FX-pending
 * — a zero reached by excluding rows is not a fact about money, so the card
 * refuses to compare against it. A genuine zero baseline RENDERS: the delta
 * stands against 0 and the percentage says "no comparison possible".
 */
function deriveSpendingTrend(context: InsightContext): DerivationOutcome {
  const { window: monthWindow, baseCurrency, now } = context
  const timezone = monthWindow.timezone
  const month = monthWindow.start.slice(0, 7)
  const currentMonth = currentMonthInZone(now, timezone)

  if (month > currentMonth) {
    return {
      insight: null,
      skippedReason: "the requested month has not started yet",
    }
  }
  const isCurrentMonth = month === currentMonth
  const historySkipReason = trendHistorySkipReason(
    month,
    isCurrentMonth,
    context.historyRange
  )
  if (historySkipReason !== null) {
    return {
      insight: null,
      skippedReason: historySkipReason,
    }
  }

  const windows = buildTrendWindows(
    month,
    calendarDateInZone(now, timezone),
    isCurrentMonth
  )
  const totals = foldTrendTotals(context.expenseRows, windows, timezone)

  // Skip-vs-zero, baseline side (the `emergency_fund` burn-guard precedent):
  // the previous period recorded rows, but every one of them is pending an
  // FX rate, so its 0 is an artifact of missing rates — "no spending was
  // recorded" would be false, and comparing against a fabricated zero would
  // be exactly the confidence §3 forbids.
  if (totals.previousSpend === 0n && totals.previousPeriodPendingCount > 0) {
    return {
      insight: null,
      skippedReason:
        "every spending row in the comparison period is pending an exchange rate",
    }
  }

  return {
    insight: buildSpendingTrendInsight({
      windows,
      totals,
      baseCurrency,
      anchorGaps: context.anchorGaps,
      timezone,
      isCurrentMonth,
    }),
  }
}

const REGISTERED_DERIVATIONS: ReadonlyArray<RegisteredDerivation> = [
  { id: SAVINGS_FLOW_INSIGHT_ID, run: deriveSavingsFlow },
  { id: SINCE_PAYDAY_INSIGHT_ID, run: deriveSincePayday },
  { id: EMERGENCY_FUND_INSIGHT_ID, run: deriveEmergencyFund },
  { id: RECURRING_BILLS_INSIGHT_ID, run: deriveRecurringBills },
  { id: SPENDING_TREND_INSIGHT_ID, run: deriveSpendingTrend },
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
