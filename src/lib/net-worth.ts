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
// PER-201). A cash account with no anchor at T contributes 0 (pre-inception).
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
 * The `afterAnchor` predicate (ADR-0043 §2 / PER-201), the in-memory twin of the
 * Prisma `OR: [{ date: { gt } }, { createdAt: { gt } }]` in
 * `sumTransactionFlowAfterAnchor` (src/server/valuations.ts). A flow counts
 * toward the post-anchor sum iff it is dated after the anchor OR was recorded
 * after it — the disjunction is load-bearing in BOTH directions (a future-dated
 * txn recorded before a live reconciliation; a back-dated txn recorded after
 * one). Keep the two shapes identical; the ADR-0038 §6 invariant test enforces
 * parity. Dates are compared as YYYY-MM-DD strings (lexicographic == calendar).
 */
function isAfterAnchor(
  anchorDate: string,
  anchorCreatedAt: Date,
  txnDate: string,
  txnCreatedAt: Date
): boolean {
  return txnDate > anchorDate || txnCreatedAt > anchorCreatedAt
}

// ---- shared point normalizer ------------------------------------------------

export interface PointBalance {
  accountClass: string
  currency: string
  native: bigint
}

/** Resolve a foreign->base rate (scaled) for a currency, or null if none. */
export type RateResolver = (fromCurrency: string) => bigint | null

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
  value: bigint
}

interface CashFlowRow {
  date: string
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
  backdatedAfterAnchor: bigint
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
  // The counted set splits into two disjoint pieces (see `isAfterAnchor`):
  //   (a) strictly-after-date flow: Σ{ anchorDate < date <= T }
  //         = sumThroughT − sumThroughAnchorDate
  //   (b) back-dated-but-later-recorded flow: Σ{ date <= anchorDate ∧
  //         createdAt > anchorCreatedAt }  — constant per anchor.
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
  return (
    cash.active.value +
    (cash.sumThroughT - cash.active.sumThroughAnchorDate) +
    cash.active.backdatedAfterAnchor
  )
}

/**
 * Precompute an anchor's two constant flow pieces (both Σ bounded by the anchor
 * date). The strictly-after-DATE disjunct of `afterAnchor` is handled by the
 * caller via `sumThroughT − sumThroughAnchorDate`; here we only classify the
 * at/before-date rows, for which `isAfterAnchor` collapses to its createdAt
 * disjunct — the exact rows the date subtraction would otherwise drop.
 */
function summarizeAnchor(
  anchor: CashAnchor,
  txns: CashFlowRow[]
): ActiveAnchor {
  let sumThroughAnchorDate = 0n
  let backdatedAfterAnchor = 0n
  for (const txn of txns) {
    if (txn.date > anchor.date) break // txns are date-sorted ascending
    sumThroughAnchorDate += txn.amount
    if (isAfterAnchor(anchor.date, anchor.createdAt, txn.date, txn.createdAt)) {
      backdatedAfterAnchor += txn.amount
    }
  }
  return { value: anchor.value, sumThroughAnchorDate, backdatedAfterAnchor }
}
