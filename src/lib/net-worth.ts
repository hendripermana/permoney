import type { CurrencyCode } from "@/lib/data/currencies"
import { convertMinor } from "@/lib/fx"

// =============================================================================
// PER-154 / ADR-0038 — Net-worth time series (computed-on-read, mark-to-market).
//
// Pure, Prisma-free math shared by two consumers:
//   - `normalizeNetWorthAt` — the single point-normalizer. Given each account's
//     native balance at a moment + a rate resolver, it produces the base-currency
//     decomposition { netWorth, assets, liabilities } + the per-currency
//     `unconverted` list. The live `NetWorthInBaseCard` and the series both call
//     it, so card-total == series-last-point holds BY CONSTRUCTION (ADR-0038 §5).
//   - `buildNetWorthSeries` — derives each account's NATIVE balance at every
//     sampled date via a single-pass fold (replayed from inception, so activity
//     before `from` shifts the first point), then calls `normalizeNetWorthAt`
//     per point. FX is as-of-date mark-to-market: the rate resolver is clamped to
//     the greatest snapshot `asOfDate <= T`; a future-dated rate never leaks.
//
// Cash (transaction_flow) balance-as-of-T mirrors `computeCanonicalBalance`
// (ADR-0043 §2 / PER-201) EXACTLY, so the series' last point equals the
// materialized `Account.balance` by construction (ADR-0038 §6). The anchor is the
// LATEST balance-assertion valuation (opening | reconciliation | manual) with
// `valuationDate <= T`; the balance is `anchor.value + Σ afterAnchor(anchor, ≤ T)`
// where a flow is "after the anchor" iff `date > anchor.date` OR
// `createdAt > anchor.createdAt` (both disjuncts load-bearing — a live
// reconciliation asserts a value that ABSORBS all prior-and-already-recorded
// flow, while a back-dated txn added after that anchor is still counted; see
// PER-201; the exact per-provenance rule — ground_truth is instant-bounded by
// `observedAt` since 2026-09-20 — is `isAfterAnchor` below). A cash account with
// no anchor at T contributes 0 (pre-inception).
// Recognizing reconciliation/manual anchors — not just `opening` — is what fixes
// PER-204: migrated/reconciled accounts are anchored by `reconciliation`, never
// `opening`, so the old opening-only fold zeroed every one of them.
//
// All money is signed minor units (ASSET balance >= 0, LIABILITY balance <= 0),
// the same sign convention as `Account.balance` / `Valuation.value`.
// =============================================================================

export const MAX_SERIES_POINTS = 366

export type SeriesInterval = "day" | "week" | "month"

/**
 * Balance-assertion valuation types — the anchors a cash (transaction_flow)
 * account's balance is derived from. The SINGLE source of truth for this set;
 * `computeCanonicalBalance` (src/server/valuations.ts) imports it so the batch
 * in-memory fold here and the per-account DB derivation there can never drift on
 * which valuation types reset a cash balance (ADR-0043 §1). `market` is excluded
 * — it never asserts a cash balance. Kept in this Prisma-free module so the
 * server file depends on the pure one, never the reverse.
 */
export const ANCHOR_VALUATION_TYPES = [
  "opening",
  "reconciliation",
  "manual",
] as const

const ANCHOR_VALUATION_TYPE_SET: ReadonlySet<string> = new Set(
  ANCHOR_VALUATION_TYPES
)

/**
 * Is this valuation type an ANCHOR (a balance assertion) rather than a mere
 * observation? The same predicate the `valuation_provenance_domain` CHECK
 * encodes: exactly the anchor types carry a `provenance`, `market` never does.
 */
export function isAnchorValuationType(type: string): boolean {
  return ANCHOR_VALUATION_TYPE_SET.has(type)
}

/**
 * Where an anchor's asserted value came from (PER-264 / ADR-0043 "anchor
 * provenance" amendment). The SINGLE source of truth for this domain, mirrored
 * by the `valuation_provenance_domain` CHECK in the database.
 *
 * - `ground_truth` — an INDEPENDENT observation of reality: the live "Reconcile
 *   account" tap, and later a bank-fetched statement balance. It already
 *   reflects every event up to that moment, whether or not Permoney knew.
 * - `derived` — COMPUTED by summing ledger rows Permoney already held when the
 *   anchor was written (Sure-migration anchors, the Σ-holdings anchor, the
 *   balance-preserving seed anchor) — and EVERY `opening` balance, which is
 *   dated at account-creation time rather than at a user-chosen "track me from
 *   here" date (ADR-0043 amendment, "Scope narrowed 2026-08-29").
 */
export const ANCHOR_PROVENANCES = ["ground_truth", "derived"] as const
export type AnchorProvenance = (typeof ANCHOR_PROVENANCES)[number]

const ANCHOR_PROVENANCE_SET: ReadonlySet<string> = new Set(ANCHOR_PROVENANCES)

/**
 * Narrow a raw `Valuation.provenance` column value onto the closed domain.
 * Anything unrecognised (NULL on a legacy row, or a value written before the
 * CHECK existed) falls back to `derived`, which preserves PER-201's strictly
 * more permissive rule — an unknown anchor never silently starts DROPPING a
 * backdated transaction the materialized balance already counted.
 */
export function toAnchorProvenance(
  raw: string | null | undefined
): AnchorProvenance {
  return raw != null && ANCHOR_PROVENANCE_SET.has(raw)
    ? (raw as AnchorProvenance)
    : "derived"
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * ADR-0043 amendment (2026-09-20) — the instant a `ground_truth` anchor's
 * segmentation is bounded by: `observedAt` when the anchor recorded WHEN it was
 * observed, else the legacy midnight of its `valuationDate` (`@db.Date`).
 *
 *   afterAnchor(A)(t) for ground_truth ≡ t.date > groundTruthBoundary(A)
 *
 * The SINGLE definition of this rule: the Prisma `where` in
 * `sumTransactionFlowAfterAnchor` (balance formula + ANCHOR_CHAIN `through`
 * bound), the account-anchor view's `transactionsAfter` count, the balance-
 * override gate, and the in-memory fold below all call it, so they cannot
 * disagree about which side of an anchor a transaction sits on (ADR-0043 §6).
 */
export function groundTruthBoundary(anchor: {
  valuationDate: Date
  observedAt: Date | null
}): Date {
  return anchor.observedAt ?? anchor.valuationDate
}

/**
 * Should a NEW anchor record `observedAt`? Only when its `valuationDate` is the
 * same UTC calendar day as the write instant — i.e. the human is observing
 * "now", so the instant within the day is meaningful. A back-dated valuation
 * asserts a balance as of a past DAY (the time of day is unknown) and keeps the
 * legacy date-only rule.
 *
 * UTC by design, matching `Valuation.valuationDate` (a UTC-midnight `@db.Date`)
 * and the server's UTC `startOfNextCalendarDay`. Caveat: a user whose local
 * date is already the next UTC day (e.g. 00:00-07:00 WIB) picking "today"
 * sends a valuationDate one UTC day ahead of `now`; that anchor is not yet
 * effective and, when it becomes so at UTC midnight, has no observedAt. It
 * falls back to the legacy date-only rule, exactly as before this amendment.
 */
export function isObservedNow(valuationDate: Date, writtenAt: Date): boolean {
  return (
    valuationDate.toISOString().slice(0, 10) ===
    writtenAt.toISOString().slice(0, 10)
  )
}

/**
 * The `afterAnchor` predicate (ADR-0043 §2 / PER-201, refined by PER-264 and
 * the 2026-09-20 observedAt amendment), the in-memory twin of the Prisma
 * `where` built in `sumTransactionFlowAfterAnchor` (src/server/valuations.ts).
 * Keep the two shapes identical; the ADR-0038 §6 invariant test enforces
 * parity.
 *
 *   afterAnchor(A)(t) ≡ A.provenance = "derived"
 *                          ? (t.date > A.valuationDate OR t.createdAt > A.createdAt)
 *                          : (t.date > groundTruthBoundary(A))
 *
 * DERIVED: dates are compared as YYYY-MM-DD strings in the family timezone
 * (lexicographic == calendar); a same-day `txnDate === anchorDate` fails
 * `txnDate > anchorDate` and falls through to the createdAt disjunct, exactly
 * as the DB's PER-276 calendar-day predicate does. The disjunction is
 * load-bearing in BOTH directions (a future-dated txn recorded before the
 * anchor; a back-dated txn recorded after it — PER-201's fix).
 *
 * GROUND_TRUTH: compared by INSTANT against the anchor's boundary, exactly like
 * the DB — `Transaction.date` is a real instant, the boundary is `observedAt`
 * or, for a legacy/back-dated anchor, the midnight starting the anchor's day.
 * (Before the amendment this twin compared calendar-day strings and so treated
 * a same-day transaction as absorbed while the DB counted it; the two now
 * agree.) The createdAt disjunct is still exactly the PER-264 bug: the human
 * already looked at their real wallet, so a transaction dated at/before that
 * observation was ALREADY inside the asserted number and counting it again
 * invents money (PER-264's OVO case).
 */
function isAfterAnchor(anchor: CashAnchor, txn: CashFlowRow): boolean {
  if (anchor.provenance === "derived") {
    return txn.date > anchor.date || txn.createdAt > anchor.createdAt
  }
  return txn.instantMs > groundTruthBoundaryMs(anchor)
}

function groundTruthBoundaryMs(anchor: CashAnchor): number {
  return anchor.observedAt !== null
    ? anchor.observedAt.getTime()
    : Date.parse(`${anchor.date}T00:00:00.000Z`)
}

/** The YYYY-MM-DD calendar day after `date` (pure UTC arithmetic, no DST). */
function nextCalendarDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10)
}

// ---- shared point normalizer ------------------------------------------------

export interface PointBalance {
  accountClass: string
  currency: string
  native: bigint
}

/** Resolve a foreign->base rate (scaled) for a currency, or null if none. */
export type RateResolver = (fromCurrency: string) => bigint | null

/**
 * Builds the `fromCurrency -> base` rate resolver from a LATEST-only FX overview
 * (one row per pair; the first-wins guard keeps it correct even if a pair ever
 * appears twice). Shared by every live card that normalizes to the family base
 * so they resolve rates identically (ADR-0038 §5, ADR-0058 D3).
 */
export function buildLatestRateResolver(
  rates: ReadonlyArray<{
    fromCurrency: string
    toCurrency: string
    rateScaled: string | bigint
  }>,
  baseCurrency: string
): RateResolver {
  const latest = new Map<string, bigint>()
  for (const rate of rates) {
    if (rate.toCurrency !== baseCurrency) continue
    if (!latest.has(rate.fromCurrency)) {
      latest.set(rate.fromCurrency, BigInt(rate.rateScaled))
    }
  }
  return (currency) => latest.get(currency) ?? null
}

export interface NetWorthBreakdown {
  netWorth: bigint
  assets: bigint
  liabilities: bigint
  unconverted: Array<{ currency: string; native: bigint }>
}

/**
 * Normalize a set of native balances to the base currency at one moment.
 *
 * - base-currency accounts pass through as identity;
 * - foreign accounts convert via `convertMinor` with the resolved rate;
 * - a foreign account with no resolvable rate is EXCLUDED from the totals and
 *   surfaced in `unconverted` (ADR-0038 §3 — never zeroed, never extrapolated).
 *
 * `assets` is the signed sum of ASSET-class base contributions; `liabilities`
 * is the negated signed sum of LIABILITY-class base contributions. Therefore
 * `netWorth === assets - liabilities` exactly, by construction (ADR-0038 §6).
 */
export function normalizeNetWorthAt(
  balances: ReadonlyArray<PointBalance>,
  resolveRate: RateResolver,
  baseCurrency: string
): NetWorthBreakdown {
  let assets = 0n
  let liabilities = 0n
  const unconvertedByCurrency = new Map<string, bigint>()

  for (const balance of balances) {
    let base: bigint
    if (balance.currency === baseCurrency) {
      base = balance.native
    } else {
      const rate = resolveRate(balance.currency)
      if (rate === null) {
        unconvertedByCurrency.set(
          balance.currency,
          (unconvertedByCurrency.get(balance.currency) ?? 0n) + balance.native
        )
        continue
      }
      base = convertMinor(
        balance.native,
        balance.currency as CurrencyCode,
        baseCurrency as CurrencyCode,
        rate
      )
    }
    if (balance.accountClass === "LIABILITY") {
      liabilities += -base
    } else {
      assets += base
    }
  }

  const unconverted = [...unconvertedByCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, native]) => ({ currency, native }))

  return { netWorth: assets - liabilities, assets, liabilities, unconverted }
}

// ---- sample-date generation (pure calendar math) ----------------------------

function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function stepDate(date: string, interval: SeriesInterval): string {
  const [year, month, day] = date.split("-").map(Number)
  if (interval === "day") return formatUtc(Date.UTC(year, month - 1, day + 1))
  if (interval === "week") return formatUtc(Date.UTC(year, month - 1, day + 7))
  // month: advance one calendar month, clamping the day to the new month's last.
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const lastDayOfNextMonth = new Date(
    Date.UTC(nextYear, nextMonth, 0)
  ).getUTCDate()
  const clampedDay = Math.min(day, lastDayOfNextMonth)
  return formatUtc(Date.UTC(nextYear, nextMonth - 1, clampedDay))
}

/**
 * Ascending calendar dates (YYYY-MM-DD) stepped by `interval` across [from, to],
 * always including `to` as the final point. Throws `RangeError` when `from > to`
 * or the point count exceeds `MAX_SERIES_POINTS` (strict, bounded contract).
 */
export function generateSampleDates(
  from: string,
  to: string,
  interval: SeriesInterval
): string[] {
  if (from > to) {
    throw new RangeError(
      `net-worth series: from (${from}) must be <= to (${to})`
    )
  }
  const dates: string[] = []
  let cursor = from
  while (cursor <= to) {
    dates.push(cursor)
    if (dates.length > MAX_SERIES_POINTS + 1) break
    cursor = stepDate(cursor, interval)
  }
  if (dates[dates.length - 1] !== to) dates.push(to)
  if (dates.length > MAX_SERIES_POINTS) {
    throw new RangeError(
      `net-worth series exceeds ${MAX_SERIES_POINTS} points; narrow the range or widen the interval`
    )
  }
  return dates
}

// ---- the fold ---------------------------------------------------------------

export interface SeriesAccount {
  id: string
  accountClass: string
  balanceSource: string
  currency: string
}

export interface SeriesValuation {
  accountId: string
  value: bigint
  valuationDate: string // YYYY-MM-DD (date-only anchor)
  createdAt: Date // recorded-at instant; the `afterAnchor` createdAt disjunct
  type: string
  // PER-264: raw `Valuation.provenance`. NULL for `market` rows (never an
  // anchor) and for pre-migration rows; `toAnchorProvenance` narrows it.
  provenance: string | null
  // ADR-0043 amendment (2026-09-20): when, within `valuationDate`, a
  // ground_truth anchor was observed. NULL/absent = legacy date-only anchor.
  observedAt?: Date | null
}

export interface SeriesTransaction {
  accountId: string
  amount: bigint
  date: Date // instant; localized to the family timezone for the day boundary
  createdAt: Date // recorded-at instant; the `afterAnchor` createdAt disjunct
}

export interface SeriesSnapshot {
  fromCurrency: string
  rateScaled: bigint
  asOfDate: string // YYYY-MM-DD
}

export interface NetWorthSeriesInput {
  baseCurrency: string
  timezone: string
  from: string
  to: string
  interval: SeriesInterval
  accounts: ReadonlyArray<SeriesAccount>
  valuations: ReadonlyArray<SeriesValuation>
  transactions: ReadonlyArray<SeriesTransaction>
  snapshots: ReadonlyArray<SeriesSnapshot>
}

export interface NetWorthPoint extends NetWorthBreakdown {
  date: string
  isPartial: boolean
}

/** Localize an instant to its YYYY-MM-DD calendar date in the family timezone. */
function calendarDateInTimezone(instant: Date, timeZone: string): string {
  // en-CA renders ISO-shaped YYYY-MM-DD; timeZone applies the local day boundary.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant)
}

function byDateAsc<T extends { date: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

export function buildNetWorthSeries(
  input: NetWorthSeriesInput
): NetWorthPoint[] {
  const sampleDates = generateSampleDates(input.from, input.to, input.interval)

  // --- index canonical rows per account / currency, all sorted ascending -----
  // Cash accounts key off ANCHOR-type valuations (opening | reconciliation |
  // manual); tracked accounts carry the latest valuation of ANY type. Both come
  // from the same `input.valuations`, split by type here.
  const anchorsByAccount = new Map<string, CashAnchor[]>()
  const valuationsByAccount = new Map<
    string,
    { date: string; value: bigint }[]
  >()
  for (const valuation of input.valuations) {
    if (ANCHOR_VALUATION_TYPE_SET.has(valuation.type)) {
      const anchors = anchorsByAccount.get(valuation.accountId) ?? []
      anchors.push({
        date: valuation.valuationDate,
        createdAt: valuation.createdAt,
        provenance: toAnchorProvenance(valuation.provenance),
        observedAt: valuation.observedAt ?? null,
        value: valuation.value,
      })
      anchorsByAccount.set(valuation.accountId, anchors)
    }
    const list = valuationsByAccount.get(valuation.accountId) ?? []
    list.push({ date: valuation.valuationDate, value: valuation.value })
    valuationsByAccount.set(valuation.accountId, list)
  }
  // Sort anchors by (date, createdAt) ascending — the last one with date <= T is
  // the active anchor, mirroring `latestValuation`'s (valuationDate desc,
  // createdAt desc) tie-break (src/server/valuations.ts).
  for (const anchors of anchorsByAccount.values()) {
    anchors.sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : a.createdAt.getTime() - b.createdAt.getTime()
    )
  }
  for (const list of valuationsByAccount.values()) byDateAsc(list)

  const transactionsByAccount = new Map<string, CashFlowRow[]>()
  for (const transaction of input.transactions) {
    const list = transactionsByAccount.get(transaction.accountId) ?? []
    list.push({
      date: calendarDateInTimezone(transaction.date, input.timezone),
      instantMs: transaction.date.getTime(),
      createdAt: transaction.createdAt,
      amount: transaction.amount,
    })
    transactionsByAccount.set(transaction.accountId, list)
  }
  for (const list of transactionsByAccount.values()) byDateAsc(list)

  const snapshotsByCurrency = new Map<
    string,
    { date: string; rate: bigint }[]
  >()
  for (const snapshot of input.snapshots) {
    const list = snapshotsByCurrency.get(snapshot.fromCurrency) ?? []
    list.push({ date: snapshot.asOfDate, rate: snapshot.rateScaled })
    snapshotsByCurrency.set(snapshot.fromCurrency, list)
  }
  for (const list of snapshotsByCurrency.values()) byDateAsc(list)

  // --- per-account / per-currency advancing pointers (single pass) -----------
  const cashState = new Map<string, CashFoldState>()
  const trackedState = new Map<
    string,
    { idx: number; current: bigint | null }
  >()
  for (const account of input.accounts) {
    if (account.balanceSource === "valuation") {
      trackedState.set(account.id, { idx: 0, current: null })
    } else {
      cashState.set(account.id, {
        anchorIdx: 0,
        active: null,
        tIdx: 0,
        sumThroughT: 0n,
      })
    }
  }
  const rateState = new Map<string, { idx: number; rate: bigint | null }>()
  for (const currency of snapshotsByCurrency.keys()) {
    rateState.set(currency, { idx: 0, rate: null })
  }

  const points: NetWorthPoint[] = []
  for (const sampleDate of sampleDates) {
    // advance FX rate pointers: clamp to greatest asOfDate <= sampleDate.
    for (const [currency, state] of rateState) {
      const list = snapshotsByCurrency.get(currency)!
      while (state.idx < list.length && list[state.idx].date <= sampleDate) {
        state.rate = list[state.idx].rate
        state.idx += 1
      }
    }
    const resolveRate: RateResolver = (currency) =>
      rateState.get(currency)?.rate ?? null

    const balances: PointBalance[] = input.accounts.map((account) => ({
      accountClass: account.accountClass,
      currency: account.currency,
      native: nativeBalanceAt(account, sampleDate, {
        anchorsByAccount,
        cashState,
        trackedState,
        transactionsByAccount,
        valuationsByAccount,
      }),
    }))

    const breakdown = normalizeNetWorthAt(
      balances,
      resolveRate,
      input.baseCurrency
    )
    points.push({
      date: sampleDate,
      ...breakdown,
      isPartial: breakdown.unconverted.length > 0,
    })
  }

  return points
}

interface CashAnchor {
  date: string
  createdAt: Date
  provenance: AnchorProvenance
  observedAt: Date | null
  value: bigint
}

interface CashFlowRow {
  date: string // family-timezone calendar day (day-granular fold key)
  instantMs: number // the real `Transaction.date` instant (ground_truth compare)
  createdAt: Date
  amount: bigint
}

/** Memoized summary of the currently-active anchor (recomputed on activation). */
interface ActiveAnchor {
  value: bigint
  // Σ flow dated at/before the anchor date (subtracted from `sumThroughT` to
  // leave only strictly-after-date flow — the first `afterAnchor` disjunct).
  sumThroughAnchorDate: bigint
  // Σ flow dated at/before the anchor date BUT recorded after it — the second
  // (createdAt) disjunct, which the date subtraction above would otherwise drop.
  // PER-264: for a `ground_truth` anchor this is NOT createdAt-driven — its
  // predicate has no createdAt disjunct (an independently observed balance
  // already absorbed every at/before-boundary row, whenever it was entered).
  // Here it is the rows dated on/before the anchor's DAY that still fall AFTER
  // its instant boundary (legacy: any same-UTC-day row past midnight; with
  // `observedAt`: a row dated later that day).
  backdatedAfterAnchor: bigint
  // ADR-0043 amendment: ground_truth rows whose family-timezone DAY is after
  // the anchor's day yet whose instant is at/before `observedAt` (only possible
  // when the family timezone is ahead of UTC). Absorbed, so they must be taken
  // back out of `sumThroughT − sumThroughAnchorDate` once their day is reached.
  absorbedAfterAnchorDate: ReadonlyArray<{ date: string; amount: bigint }>
}

interface CashFoldState {
  anchorIdx: number
  active: ActiveAnchor | null
  tIdx: number
  sumThroughT: bigint
}

interface FoldState {
  anchorsByAccount: Map<string, CashAnchor[]>
  cashState: Map<string, CashFoldState>
  trackedState: Map<string, { idx: number; current: bigint | null }>
  transactionsByAccount: Map<string, CashFlowRow[]>
  valuationsByAccount: Map<string, { date: string; value: bigint }[]>
}

/** Native balance of one account as of `sampleDate`, advancing its pointer. */
function nativeBalanceAt(
  account: SeriesAccount,
  sampleDate: string,
  state: FoldState
): bigint {
  if (account.balanceSource === "valuation") {
    // tracked: carry forward the latest valuation with valuationDate <= T.
    const tracked = state.trackedState.get(account.id)!
    const list = state.valuationsByAccount.get(account.id) ?? []
    while (tracked.idx < list.length && list[tracked.idx].date <= sampleDate) {
      tracked.current = list[tracked.idx].value
      tracked.idx += 1
    }
    return tracked.current ?? 0n
  }

  // cash-like (ADR-0043 §2 / PER-201, twin of `computeCanonicalBalance`):
  //   balance(T) = anchor.value + Σ { afterAnchor(anchor)(t) ∧ t.date <= T }
  // The counted set splits into disjoint pieces (see `isAfterAnchor`):
  //   (a) strictly-after-day flow: Σ{ anchorDate < date <= T }
  //         = sumThroughT − sumThroughAnchorDate
  //         (minus the rare ground_truth rows absorbed by `observedAt` although
  //          their family-timezone day is later — `absorbedAfterAnchorDate`)
  //   (b) on/before-anchor-day flow that is still "after": derived rows
  //         recorded after the anchor (createdAt disjunct); ground_truth rows
  //         dated past the anchor's instant boundary — constant per anchor.
  const cash = state.cashState.get(account.id)!
  const txns = state.transactionsByAccount.get(account.id) ?? []
  const anchors = state.anchorsByAccount.get(account.id) ?? []

  // Advance the active anchor to the latest one with date <= T. Each activation
  // recomputes its constant pieces (both bounded by the anchor date) once.
  while (
    cash.anchorIdx < anchors.length &&
    anchors[cash.anchorIdx].date <= sampleDate
  ) {
    cash.active = summarizeAnchor(anchors[cash.anchorIdx], txns)
    cash.anchorIdx += 1
  }

  // Advance the running Σ flow dated <= T (single pass across sample dates).
  while (cash.tIdx < txns.length && txns[cash.tIdx].date <= sampleDate) {
    cash.sumThroughT += txns[cash.tIdx].amount
    cash.tIdx += 1
  }

  if (cash.active === null) {
    // No anchor yet at T. A cash account created the canonical way always has an
    // `opening` anchor (accounts.ts), so this is reached only BEFORE the first
    // anchor's date, or for an anchor-less account (e.g. a raw insert). Mirror
    // `computeCanonicalBalance`'s no-anchor intent as an implicit opening-0: 0 +
    // Σ all flow <= T. Before any flow this is 0 (pre-inception, ADR-0038 §4).
    return anchors.length === 0 ? cash.sumThroughT : 0n
  }
  let absorbedEdge = 0n
  for (const row of cash.active.absorbedAfterAnchorDate) {
    if (row.date <= sampleDate) absorbedEdge += row.amount
  }
  return (
    cash.active.value +
    (cash.sumThroughT - cash.active.sumThroughAnchorDate) +
    cash.active.backdatedAfterAnchor -
    absorbedEdge
  )
}

/**
 * Precompute an anchor's constant flow pieces. The strictly-after-DAY part of
 * `afterAnchor` is handled by the caller via `sumThroughT − sumThroughAnchorDate`;
 * here we classify (a) the at/before-anchor-day rows that are nevertheless
 * "after" (`backdatedAfterAnchor`) and (b) for ground_truth, the rare later-day
 * rows that are nevertheless absorbed (`absorbedAfterAnchorDate`).
 */
function summarizeAnchor(
  anchor: CashAnchor,
  txns: CashFlowRow[]
): ActiveAnchor {
  let sumThroughAnchorDate = 0n
  let backdatedAfterAnchor = 0n
  const absorbedAfterAnchorDate: Array<{ date: string; amount: bigint }> = []
  const edgeLimit = nextCalendarDay(anchor.date)
  for (const txn of txns) {
    // txns are date-sorted ascending.
    if (txn.date > anchor.date) {
      // Only a ground_truth boundary can absorb a LATER-day row, and only within
      // one day of the anchor (a timezone ahead of UTC). Everything further out
      // is strictly after the boundary by construction.
      if (anchor.provenance === "derived" || txn.date > edgeLimit) break
      if (!isAfterAnchor(anchor, txn)) {
        absorbedAfterAnchorDate.push({ date: txn.date, amount: txn.amount })
      }
      continue
    }
    sumThroughAnchorDate += txn.amount
    if (isAfterAnchor(anchor, txn)) {
      backdatedAfterAnchor += txn.amount
    }
  }
  return {
    value: anchor.value,
    sumThroughAnchorDate,
    backdatedAfterAnchor,
    absorbedAfterAnchorDate,
  }
}
