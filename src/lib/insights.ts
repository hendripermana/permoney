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
//     `trailing_6_months` in use; `previous_month`, `rolling_90d` reserved
//     for later slices) that carry the family timezone they were resolved in
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
// Later slices add derivations (recurring bills, month-over-month trend) and
// an in-app digest page. A materialized delivered-digest artifact keyed
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
 * card, so it must not be read as a complete report under v4. */
export const INSIGHTS_ENGINE_VERSION = 4

export const SAVINGS_FLOW_INSIGHT_ID = "savings_flow"

export const SINCE_PAYDAY_INSIGHT_ID = "since_payday"

export const EMERGENCY_FUND_INSIGHT_ID = "emergency_fund"

export type InsightTone = "positive" | "neutral" | "attention"

export type InsightWindowKind =
  | "calendar_month"
  | "previous_month"
  | "since_payday"
  | "rolling_90d"
  | "trailing_6_months"

/** The family-tz-anchored window an insight was computed over. `start`/`end`
 * are inclusive family-tz calendar dates (ADR-0037) — the same convention as
 * `BudgetPeriodInput`, so `transactionInPeriod` is the one membership rule.
 * `trailing_6_months` is the emergency-fund burn window: the six COMPLETE
 * calendar months preceding the requested month (the requested month itself
 * is still accumulating and is deliberately excluded). `previous_month` stays
 * reserved for the month-over-month trend slice. */
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

/** Max account names printed in the counted-accounts metric, then `+n`. */
const MAX_COUNTED_ACCOUNT_NAMES = 3

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

/** The counted-account names as the card prints them: sorted LOCALLY inside
 * the fold (determinism is a local contract, never a dependency on the
 * seam's read order), at most three names, then `+n` — auditable (which
 * balances make up the figure) without turning the card into an account
 * roster. The comparator is `localeCompare`, NOT code-unit `<`/`>`: byte
 * order puts "Zakat" before "dana darurat" (uppercase sorts first), which
 * is not alphabetical to a human (Sonar S2871). */
function formatCountedAccountNames(names: ReadonlyArray<string>): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const shown = sorted.slice(0, MAX_COUNTED_ACCOUNT_NAMES)
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
  history: { start: string; end: string } | null
): string[] {
  if (history === null) return []
  const covered: string[] = []
  for (let i = EMERGENCY_FUND_TARGET_MONTHS; i >= 1; i -= 1) {
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
        value: formatCountedAccountNames(saved.countedNames),
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
  const usedMonths = coveredTrailingMonths(month, context.historyRange)
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

const REGISTERED_DERIVATIONS: ReadonlyArray<RegisteredDerivation> = [
  { id: SAVINGS_FLOW_INSIGHT_ID, run: deriveSavingsFlow },
  { id: SINCE_PAYDAY_INSIGHT_ID, run: deriveSincePayday },
  { id: EMERGENCY_FUND_INSIGHT_ID, run: deriveEmergencyFund },
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
