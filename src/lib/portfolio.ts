import { ACCOUNT_SUBTYPE_LABEL } from "./accounts"
import type { AnalyticsTxn } from "./account-analytics"
import {
  computeAccountPerformance,
  type AccountPerformance,
} from "./account-performance"
import { formatCurrency } from "./currency"
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

/**
 * The portfolio universe: an ACTIVE INVESTMENT / TRACKED_ASSET account.
 *
 * Archived accounts are deliberately excluded — this is a "what do I hold
 * right now" question, and an archived account is a thing the household put
 * away; its history stays visible on the accounts page. Structural input (not
 * `AccountRecord`) so this stays pure and every surface — the /investments
 * report and the PER-231 dashboard card — resolves the SAME universe.
 */
export function isPortfolioAccount(account: {
  status: string
  accountType: string
}): boolean {
  return (
    account.status === "active" &&
    (account.accountType === "INVESTMENT" ||
      account.accountType === "TRACKED_ASSET")
  )
}

/** `+Rp 1,200.00` / `− Rp 300.00` — the sign the eye needs next to a gain. */
export function signedCurrency(amountMinor: bigint, currency: string): string {
  const formatted = formatCurrency(
    (amountMinor < 0n ? -amountMinor : amountMinor).toString(),
    currency
  )
  return amountMinor < 0n ? `− ${formatted}` : `+ ${formatted}`
}

/** `+12.50%` / `−3.20%` — portfolio return display. */
export function formatReturnPct(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(2)}%`
}

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

// ─── Allocation bar quantization (PER-230 rows, PER-231 mini bar) ────────────
//
// AGENTS.md §3 forbids inline `style=`; dynamic widths must therefore come
// from a fixed, literal Tailwind width class (JIT only generates classes it
// can see in source). 5% steps → the 21-entry table below; direct integer
// arithmetic (`value × 20 ÷ total`, rounded) rather than `Math.round(pct/5)`,
// because computed float percentages like 9.999999999999998 must never round
// down to `w-0` and make a funded bucket visually disappear.

const ALLOCATION_WIDTH_STEPS: ReadonlyArray<string> = [
  "w-0",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-[50%]",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
]

/** Tailwind width class for a 0–100 share, quantized to the 5% step table. */
export function allocationWidthClass(sharePct: number): string {
  if (!Number.isFinite(sharePct)) return "w-0"
  const clamped = Math.min(100, Math.max(0, sharePct))
  const step = Math.round((clamped * 20) / 100)
  return ALLOCATION_WIDTH_STEPS[step] ?? "w-full"
}

// ─── PER-231 — compact portfolio summary input for the dashboard card ────────
//
// Pure allocation math (top-N subtype buckets + "Other" fold) plus the
// honesty flags the card surfaces. Reuses computePortfolio's output, so the
// dashboard card and the full /investments report can never disagree.

export interface PortfolioAllocationSegment {
  key: string
  label: string
  valueMinor: bigint
  /** Share of the converted market value, 0–100 (display figure). */
  sharePct: number
  /** Width in 5% steps (0–20); Σ over all segments === 20 when total > 0. */
  stepCount: number
  /** Tailwind width class for `stepCount` (from the step table above). */
  widthClass: string
}

export interface PortfolioMiniAllocation {
  /** Top `limit` subtype buckets, then one aggregated bucket for the rest. */
  segments: ReadonlyArray<PortfolioAllocationSegment>
  totalMarketValueMinor: bigint
  /** Accounts excluded for a missing FX rate (ADR-0059) — flag, never fold. */
  missingRateAccountCount: number
  /** Convertible accounts with no recorded cost basis (PER-229 honesty). */
  unbasisAccountCount: number
  /** Market value whose basis is unknown — excluded from every gain figure. */
  unbasisMarketValueMinor: bigint
  /** True only when a real cost basis exists — never a fabricated 0%. */
  hasBasis: boolean
  /** True when NO account could be converted — the card must show "—". */
  isFullyUnconverted: boolean
}

const MINI_BAR_STEPS = 20 // 5% granularity → Σ stepCount === 100%

export function buildPortfolioMiniAllocation(
  summary: PortfolioSummary,
  limit = 3
): PortfolioMiniAllocation {
  const positive = summary.bySubtype.filter((bucket) => bucket.valueMinor > 0n)
  const top = positive.slice(0, Math.max(0, limit))
  const rest = positive.slice(Math.max(0, limit))

  type Part = { key: string; label: string; valueMinor: bigint }
  const parts: Array<Part> = top.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    valueMinor: bucket.valueMinor,
  }))
  // The tail folds into one bucket — unless it is a single known subtype,
  // which is more honest to show under its own name than as "Other".
  if (rest.length === 1) {
    parts.push({
      key: rest[0].key,
      label: rest[0].label,
      valueMinor: rest[0].valueMinor,
    })
  } else if (rest.length > 1) {
    parts.push({
      key: "other",
      label: `Other (${rest.length})`,
      valueMinor: rest.reduce((sum, bucket) => sum + bucket.valueMinor, 0n),
    })
  }

  const total = summary.totalMarketValueMinor
  const shares = parts.map((part) =>
    total > 0n ? Number(part.valueMinor) / Number(total) : 0
  )

  // Largest-remainder quantization: steps always sum to exactly
  // MINI_BAR_STEPS so a stacked bar neither overflows past the track nor
  // leaves a dead gap; segments below the 2.5% rounding threshold may get 0
  // width (the legend still carries their exact sharePct).
  const exact = shares.map((share) => share * MINI_BAR_STEPS)
  const steps = exact.map((value) => Math.floor(value))
  let leftover = MINI_BAR_STEPS - steps.reduce((sum, value) => sum + value, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .filter((entry) => entry.remainder > 0)
    .sort(
      (a, b) => b.remainder - a.remainder || a.index - b.index // stable, ordered
    )
  for (const entry of byRemainder) {
    if (leftover <= 0) break
    steps[entry.index] += 1
    leftover -= 1
  }

  const segments = parts.map((part, index) => {
    const stepCount = steps[index]
    return {
      key: part.key,
      label: part.label,
      valueMinor: part.valueMinor,
      sharePct: shares[index] * 100,
      stepCount,
      widthClass: ALLOCATION_WIDTH_STEPS[stepCount] ?? "w-full",
    }
  })

  return {
    segments,
    totalMarketValueMinor: summary.totalMarketValueMinor,
    missingRateAccountCount: summary.unconverted.reduce(
      (count, entry) => count + entry.accountCount,
      0
    ),
    unbasisAccountCount: summary.unbasisAccountCount,
    unbasisMarketValueMinor: summary.unbasisMarketValueMinor,
    hasBasis: summary.overallReturnPct !== null,
    isFullyUnconverted: summary.convertibleCount === 0,
  }
}
