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
// All money is signed minor units (ASSET balance >= 0, LIABILITY balance <= 0),
// the same sign convention as `Account.balance` / `Valuation.value`.
// =============================================================================

export const MAX_SERIES_POINTS = 366

export type SeriesInterval = "day" | "week" | "month"

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
  type: string
}

export interface SeriesTransaction {
  accountId: string
  amount: bigint
  date: Date // instant; localized to the family timezone for the day boundary
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
  const openingByAccount = new Map<string, { date: string; value: bigint }>()
  const valuationsByAccount = new Map<
    string,
    { date: string; value: bigint }[]
  >()
  for (const valuation of input.valuations) {
    if (valuation.type === "opening") {
      openingByAccount.set(valuation.accountId, {
        date: valuation.valuationDate,
        value: valuation.value,
      })
    }
    const list = valuationsByAccount.get(valuation.accountId) ?? []
    list.push({ date: valuation.valuationDate, value: valuation.value })
    valuationsByAccount.set(valuation.accountId, list)
  }
  for (const list of valuationsByAccount.values()) byDateAsc(list)

  const transactionsByAccount = new Map<
    string,
    { date: string; amount: bigint }[]
  >()
  for (const transaction of input.transactions) {
    const list = transactionsByAccount.get(transaction.accountId) ?? []
    list.push({
      date: calendarDateInTimezone(transaction.date, input.timezone),
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
  const cashState = new Map<string, { idx: number; running: bigint }>()
  const trackedState = new Map<
    string,
    { idx: number; current: bigint | null }
  >()
  for (const account of input.accounts) {
    if (account.balanceSource === "valuation") {
      trackedState.set(account.id, { idx: 0, current: null })
    } else {
      cashState.set(account.id, { idx: 0, running: 0n })
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
        openingByAccount,
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

interface FoldState {
  openingByAccount: Map<string, { date: string; value: bigint }>
  cashState: Map<string, { idx: number; running: bigint }>
  trackedState: Map<string, { idx: number; current: bigint | null }>
  transactionsByAccount: Map<string, { date: string; amount: bigint }[]>
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

  // cash-like: opening anchor + Σ flow (date <= T). Pointer accumulates the
  // running flow (including any activity before `from`); the opening date gates
  // existence so the account contributes 0 before inception (ADR-0038 §4).
  const cash = state.cashState.get(account.id)!
  const list = state.transactionsByAccount.get(account.id) ?? []
  while (cash.idx < list.length && list[cash.idx].date <= sampleDate) {
    cash.running += list[cash.idx].amount
    cash.idx += 1
  }
  const opening = state.openingByAccount.get(account.id)
  if (!opening || opening.date > sampleDate) return 0n
  return opening.value + cash.running
}
