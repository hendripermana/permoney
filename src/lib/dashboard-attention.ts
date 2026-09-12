import type { AnalyticsTxn } from "./account-analytics"
import { computeIdleCash, type IdleCashInsight } from "./account-idle-cash"
import { accountSupportsReserve, hasReserve } from "./account-reserve"
import {
  computeAccountRunway,
  isRunwayAlerting,
  type AccountRunway,
} from "./account-runway"
import { applyFilters, type FilterableTransaction } from "./transaction-filters"

// =============================================================================
// PER-226 — Account intelligence, slice 5: "ambient intelligence on the
// dashboard". Pure aggregation layer ONLY — every number here comes from the
// same pure helpers already shipped and unit-tested per-account (PER-222
// runway, PER-223 idle cash): this module adds no new math, it just runs them
// across every cash-like account and keeps the two or three that actually need
// a human's attention, so the dashboard can show "what needs a look" without
// the user opening each account one by one.
//
// Deliberately capped (MAX_ITEMS_PER_LIST): the goal is a compact, calm strip,
// not a second accounts list. If nothing qualifies, both arrays are empty and
// the caller renders nothing — an empty "all clear" section a user has to
// scroll past every day is worse than no section at all (see
// feedback-validate-ux-before-full-build memory: a cluttered first impression
// got a prior feature shelved).
// =============================================================================

const MAX_ITEMS_PER_LIST = 3

export interface AttentionAccount {
  accountId: string
  accountName: string
  currency: string
  runway: AccountRunway
}

export interface IdleOpportunityAccount {
  accountId: string
  accountName: string
  currency: string
  idle: IdleCashInsight
}

export interface DashboardAttentionSummary {
  /** Below-reserve / critical / watch runway accounts, worst first, capped. */
  attention: AttentionAccount[]
  /** Idle-cash opportunities, largest surplus first, capped. */
  idleOpportunities: IdleOpportunityAccount[]
}

/** The subset of AccountRecord this module actually reads. */
export interface DashboardAttentionAccountInput {
  id: string
  name: string
  currency: string
  accountClass: string
  accountType: string
  balanceSource: string
  balance: string
  reserveBalance: string | null
  // "savings" is excluded from idle-cash opportunities — sitting idle is the
  // whole point of a savings account, not a nudge-worthy surprise there.
  accountSubtype: string
  status: string
}

function runwaySeverityRank(status: AccountRunway["status"]): number {
  // Lower = worse = sorts first. "watch" (< 30d) is the least severe of the
  // three alerting statuses; see isRunwayAlerting.
  switch (status) {
    case "below":
      return 0
    case "critical":
      return 1
    default:
      return 2
  }
}

function compareBigintDesc(a: bigint, b: bigint): number {
  if (a === b) return 0
  return a > b ? -1 : 1
}

/**
 * Aggregate the same runway/idle-cash signals the account list and detail
 * pages already compute, across every cash-like ASSET account, into a compact
 * "needs attention" summary for the dashboard. `allTransactions` should be the
 * full, unfiltered transaction collection (the same one the accounts pages
 * preload) — this function does its own per-account `applyFilters` slicing.
 */
export function computeDashboardAttention<
  T extends FilterableTransaction & AnalyticsTxn,
>(
  accounts: ReadonlyArray<DashboardAttentionAccountInput>,
  allTransactions: Array<T>,
  opts?: { now?: Date }
): DashboardAttentionSummary {
  const attention: AttentionAccount[] = []
  const idleOpportunities: IdleOpportunityAccount[] = []

  for (const account of accounts) {
    if (account.status !== "active") continue
    // PER-226 fast-follow: `accountSupportsReserve` requires a genuinely
    // liquid cash type (checking/e-wallet/cash), NOT merely
    // balanceSource==="transaction_flow" — an INVESTMENT account (mutual
    // fund, cooperative deposit) can be transaction_flow too, and flagging
    // it here would nudge the user to move money OUT of a savings/investment
    // vehicle whose whole purpose is to hold that money. See the doc comment
    // on accountSupportsReserve for the real production report that found
    // this.
    if (!accountSupportsReserve(account)) continue

    const currentBalance = BigInt(account.balance)
    const reserveMinorRaw = account.reserveBalance
      ? BigInt(account.reserveBalance)
      : null
    const reserveMinor = reserveMinorRaw ?? 0n
    const ledger = applyFilters(allTransactions, { accounts: [account.id] })

    const runway = computeAccountRunway(
      ledger,
      currentBalance,
      reserveMinor,
      account.id,
      { now: opts?.now }
    )
    // An account with NO configured reserve trivially reads as "below" its
    // implicit zero floor the instant its balance touches zero — noise for
    // an e-wallet the user tops up on demand, not a real alert. Only surface
    // once the user has actually set a reserve.
    if (isRunwayAlerting(runway.status) && hasReserve(reserveMinorRaw)) {
      attention.push({
        accountId: account.id,
        accountName: account.name,
        currency: account.currency,
        runway,
      })
    }

    if (account.accountSubtype !== "savings") {
      const idle = computeIdleCash(
        ledger,
        currentBalance,
        reserveMinor,
        account.id,
        { now: opts?.now }
      )
      if (idle.hasSurplus) {
        idleOpportunities.push({
          accountId: account.id,
          accountName: account.name,
          currency: account.currency,
          idle,
        })
      }
    }
  }

  attention.sort((a, b) => {
    const rankDiff =
      runwaySeverityRank(a.runway.status) - runwaySeverityRank(b.runway.status)
    if (rankDiff !== 0) return rankDiff
    return (
      (a.runway.daysToReserve ?? Number.POSITIVE_INFINITY) -
      (b.runway.daysToReserve ?? Number.POSITIVE_INFINITY)
    )
  })

  idleOpportunities.sort((a, b) =>
    compareBigintDesc(a.idle.idleSurplusMinor, b.idle.idleSurplusMinor)
  )

  return {
    attention: attention.slice(0, MAX_ITEMS_PER_LIST),
    idleOpportunities: idleOpportunities.slice(0, MAX_ITEMS_PER_LIST),
  }
}
