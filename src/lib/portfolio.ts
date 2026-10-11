import { ACCOUNT_SUBTYPE_LABEL } from "./accounts"
import type { AnalyticsTxn } from "./account-analytics"
import {
  computeAccountPerformance,
  type AccountPerformance,
} from "./account-performance"
import { convertMinor } from "./fx"
import type { CurrencyCode } from "./data/currencies"
import type { RateResolver } from "./net-worth"

// =============================================================================
// PER-230 — Portfolio / Investments aggregation (Slice 2), client-side.
//
// One report over every portfolio account (INVESTMENT + TRACKED_ASSET):
// totals (market value / cost basis / unrealized gain / overall return), an
// allocation breakdown (by account and by subtype), and a per-account
// performance list. Pure — no server calls, no collections; the caller (the
// `/investments` route) supplies the already-loaded accounts, the family
// ledger, and a rate resolver built from the FX overview (ADR-0035).
//
// Two honesty rules carry over from the rest of the app:
//
//   1. FX (ADR-0035 §5, ADR-0059 "no confident zeros"): an account whose
//      currency has no rate to base is EXCLUDED from every base-currency
//      figure — market value, cost, gain, allocation — and surfaced in
//      `unconverted`. Cost and gain are excluded TOGETHER with it, otherwise
//      the missing currency would materialize as a phantom loss of exactly
//      its market value.
//
//   2. Cost basis (PER-229): a return is only shown against a positive basis.
//      An account with no recorded cost still counts its market value (that
//      money is real), but contributes nothing to cost/gain/return and is
//      reported in `unbasisAccountCount` + `unbasisMarketValueMinor` so the
//      caller can say WHY the overall return does not cover every account.
//
// Per-account performance reuses `computeAccountPerformance` (PER-229) over
// the SAME ledger slice the account detail page passes (`accountId` or
// `toAccountId` membership — applyFilters' `{ accounts: [id] }` lens), so
// this report can never disagree with the per-account view.
//
// Pure; money stays in bigint minor units, `number` only for display ratios.
// =============================================================================

export interface PortfolioAccountInput {
  accountId: string
  name: string
  /** "INVESTMENT" | "TRACKED_ASSET" (kept as string: the taxonomy is open). */
  accountType: string
  /** Raw subtype token (brokerage / gold / crypto_wallet / …). */
  accountSubtype: string
  currency: string
  /** Current market value in native minor units — the account's balance. */
  balanceMinor: bigint
  /**
   * Opening valuation in native minor units (the one scalar the client cannot
   * derive). `null` = no opening valuation was recorded → 0, same as the
   * account detail page treats it.
   */
  openingValueMinor: bigint | null
  /**
   * Σ(units × avg cost) when the account tracks positions — the AUTHORITATIVE
   * basis (PER-232). `null` = no holdings → fall back to opening + net
   * contributions (the PER-229 ledger heuristic).
   */
  holdingsCostBasisMinor: bigint | null
}

export interface PortfolioRow {
  accountId: string
  name: string
  accountType: string
  accountSubtype: string
  currency: string
  /** Slice 1's per-account performance, in the account's OWN currency. */
  performance: AccountPerformance
  /** false when the currency has no rate to base → excluded from totals. */
  convertible: boolean
  /** Market value in base currency; null when `convertible` is false. */
  baseMarketValueMinor: bigint | null
  /** Share of the converted portfolio's market value, 0–100; null when not convertible. */
  sharePct: number | null
}

export interface PortfolioUnconverted {
  currency: string
  /** Σ native market value of the excluded accounts, in that currency. */
  marketValueMinor: bigint
  accountCount: number
}

export interface PortfolioAllocationBucket {
  /** The raw group key (subtype token, or the account id). */
  key: string
  /** Human label — `ACCOUNT_SUBTYPE_LABEL` for subtypes, the account name for accounts. */
  label: string
  /** Σ base-currency market value of the group. */
  valueMinor: bigint
  /** Group share of the converted total market value, 0–100. */
  sharePct: number
  accountCount: number
}

export interface PortfolioSummary {
  baseCurrency: string
  /** Every input account (converted + not). */
  accountCount: number
  convertibleCount: number
  /** Σ market value over convertible accounts, in base. */
  totalMarketValueMinor: bigint
  /** Σ cost basis over convertible accounts that HAVE a positive basis, in base. */
  totalCostBasisMinor: bigint
  /** `covered market value − total cost basis` (only basis-bearing accounts). */
  totalGainMinor: bigint
  /** gain / cost basis, or null when there is no positive basis to measure against. */
  overallReturnPct: number | null
  /** Convertible accounts excluded from cost/gain/return for want of a basis. */
  unbasisAccountCount: number
  /** Their Σ market value in base — the part the return does NOT cover. */
  unbasisMarketValueMinor: bigint
  /** true when ≥1 account is excluded for a missing FX rate (ADR-0059). */
  isPartial: boolean
  /** Excluded accounts grouped by currency (native units), sorted by currency. */
  unconverted: ReadonlyArray<PortfolioUnconverted>
  /** Per-account list, sorted by base market value desc (unconvertible last). */
  rows: ReadonlyArray<PortfolioRow>
  /** Allocation by account subtype, sorted by value desc. */
  bySubtype: ReadonlyArray<PortfolioAllocationBucket>
  /** Allocation by account, sorted by value desc. */
  byAccount: ReadonlyArray<PortfolioAllocationBucket>
}

const EMPTY_LEDGER: ReadonlyArray<AnalyticsTxn> = []

/**
 * Index the ONE family ledger by every account a row touches — exactly the
 * membership `applyFilters(txns, { accounts: [id] })` produces for that id
 * (owner OR counterparty), so the slice handed to `computeAccountPerformance`
 * is the same one the account detail page uses. One pass, O(txns).
 */
function groupLedgerByAccount(
  transactions: ReadonlyArray<AnalyticsTxn>
): Map<string, Array<AnalyticsTxn>> {
  const byAccount = new Map<string, Array<AnalyticsTxn>>()
  const add = (accountId: string, txn: AnalyticsTxn): void => {
    const list = byAccount.get(accountId)
    if (list) list.push(txn)
    else byAccount.set(accountId, [txn])
  }
  for (const txn of transactions) {
    add(txn.accountId, txn)
    // A self-referential transfer must not double-count in its own slice.
    if (txn.toAccountId != null && txn.toAccountId !== txn.accountId) {
      add(txn.toAccountId, txn)
    }
  }
  return byAccount
}

/**
 * Native minor units → base minor units, or null when the currency has no
 * rate to base (identity pass-through for the base currency itself, so a
 * family with no FX rows at all still reports correctly in its own currency).
 */
function toBaseMinor(
  native: bigint,
  currency: string,
  baseCurrency: string,
  resolveRate: RateResolver
): bigint | null {
  if (currency === baseCurrency) return native
  const rate = resolveRate(currency)
  if (rate === null) return null
  return convertMinor(
    native,
    currency as CurrencyCode,
    baseCurrency as CurrencyCode,
    rate
  )
}

function buildBuckets(
  rows: ReadonlyArray<PortfolioRow>,
  group: (row: PortfolioRow) => { key: string; label: string },
  totalMarketValueMinor: bigint
): Array<PortfolioAllocationBucket> {
  const buckets = new Map<string, PortfolioAllocationBucket>()
  for (const row of rows) {
    if (row.baseMarketValueMinor === null) continue
    const { key, label } = group(row)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.valueMinor += row.baseMarketValueMinor
      bucket.accountCount += 1
    } else {
      buckets.set(key, {
        key,
        label,
        valueMinor: row.baseMarketValueMinor,
        sharePct: 0,
        accountCount: 1,
      })
    }
  }
  const denominator = Number(totalMarketValueMinor)
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      sharePct:
        denominator > 0 ? (Number(bucket.valueMinor) / denominator) * 100 : 0,
    }))
    .sort((a, b) => {
      if (a.valueMinor !== b.valueMinor)
        return a.valueMinor > b.valueMinor ? -1 : 1
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
    })
}

/**
 * Aggregate the portfolio. See the module header for the two honesty rules
 * (FX exclusion, basis coverage) — every "null" below is a deliberate
 * "cannot say", never a zero.
 */
export function computePortfolio(
  accounts: ReadonlyArray<PortfolioAccountInput>,
  transactions: ReadonlyArray<AnalyticsTxn>,
  resolveRate: RateResolver,
  baseCurrency: string
): PortfolioSummary {
  const ledgers = groupLedgerByAccount(transactions)

  const rows: PortfolioRow[] = accounts.map((account) => {
    const performance = computeAccountPerformance(
      ledgers.get(account.accountId) ?? EMPTY_LEDGER,
      account.openingValueMinor ?? 0n,
      account.balanceMinor,
      account.accountId,
      account.holdingsCostBasisMinor
    )
    const baseMarketValueMinor = toBaseMinor(
      performance.marketValueMinor,
      account.currency,
      baseCurrency,
      resolveRate
    )
    return {
      accountId: account.accountId,
      name: account.name,
      accountType: account.accountType,
      accountSubtype: account.accountSubtype,
      currency: account.currency,
      performance,
      convertible: baseMarketValueMinor !== null,
      baseMarketValueMinor,
      sharePct: null,
    }
  })

  let totalMarketValueMinor = 0n
  let totalCostBasisMinor = 0n
  let totalGainMinor = 0n
  let unbasisAccountCount = 0
  let unbasisMarketValueMinor = 0n
  const unconvertedByCurrency = new Map<
    string,
    { marketValueMinor: bigint; accountCount: number }
  >()

  for (const row of rows) {
    const baseMarket = row.baseMarketValueMinor
    if (baseMarket === null) {
      // No rate → out of EVERY total, grouped by currency for the flag.
      const bucket = unconvertedByCurrency.get(row.currency) ?? {
        marketValueMinor: 0n,
        accountCount: 0,
      }
      bucket.marketValueMinor += row.performance.marketValueMinor
      bucket.accountCount += 1
      unconvertedByCurrency.set(row.currency, bucket)
      continue
    }

    totalMarketValueMinor += baseMarket
    if (row.performance.hasBasis) {
      const baseCost = toBaseMinor(
        row.performance.costBasisMinor,
        row.currency,
        baseCurrency,
        resolveRate
      )
      // `convertible` already proved the rate exists for this currency, so
      // baseCost can only be null if the row itself was (impossible here).
      if (baseCost !== null) {
        totalCostBasisMinor += baseCost
        // Derived from the SAME two base figures so the report's arithmetic
        // holds visually: market − cost = gain, row by row and in total.
        totalGainMinor += baseMarket - baseCost
      }
    } else {
      unbasisAccountCount += 1
      unbasisMarketValueMinor += baseMarket
    }
  }

  const overallReturnPct =
    totalCostBasisMinor > 0n
      ? Number(totalGainMinor) / Number(totalCostBasisMinor)
      : null

  const unconverted: Array<PortfolioUnconverted> = [
    ...unconvertedByCurrency.entries(),
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, bucket]) => ({ currency, ...bucket }))

  // Shares against the converted market value (unconvertible accounts are
  // already out of it — their share is honestly "unknown", not 0%).
  for (const row of rows) {
    if (row.baseMarketValueMinor === null) continue
    row.sharePct =
      totalMarketValueMinor > 0n
        ? (Number(row.baseMarketValueMinor) / Number(totalMarketValueMinor)) *
          100
        : 0
  }

  const convertibleRows = rows.filter((row) => row.convertible)
  const sortedRows = [...rows].sort((a, b) => {
    const aBase = a.baseMarketValueMinor
    const bBase = b.baseMarketValueMinor
    if (aBase === null && bBase === null)
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    if (aBase === null) return 1
    if (bBase === null) return -1
    if (aBase !== bBase) return aBase > bBase ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return {
    baseCurrency,
    accountCount: rows.length,
    convertibleCount: convertibleRows.length,
    totalMarketValueMinor,
    totalCostBasisMinor,
    totalGainMinor,
    overallReturnPct,
    unbasisAccountCount,
    unbasisMarketValueMinor,
    isPartial: unconverted.length > 0,
    unconverted,
    rows: sortedRows,
    bySubtype: buildBuckets(
      convertibleRows,
      (row) => ({
        key: row.accountSubtype,
        label:
          ACCOUNT_SUBTYPE_LABEL[
            row.accountSubtype as keyof typeof ACCOUNT_SUBTYPE_LABEL
          ] ?? row.accountSubtype,
      }),
      totalMarketValueMinor
    ),
    byAccount: buildBuckets(
      convertibleRows,
      (row) => ({ key: row.accountId, label: row.name }),
      totalMarketValueMinor
    ),
  }
}
