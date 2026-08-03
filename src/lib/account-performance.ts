import { signedDeltaForAccount, type AnalyticsTxn } from "./account-analytics"

// =============================================================================
// PER-229 — Investment & Gold performance (Slice 1), ledger-derived.
//
// For a valuation-tracked account (INVESTMENT / TRACKED_ASSET), performance is:
//
//   cost basis   = opening valuation value + Σ(net cash contributions)
//   market value = current value (the account's latest valuation = its balance)
//   gain/loss    = market value − cost basis          (unrealized)
//   return %     = gain / cost basis                  (only when basis > 0)
//
// Net contributions come from the ledger with the SAME proven lens the rest of
// the app uses (`signedDeltaForAccount`, PER-202/222/223): money transferred IN
// is +, OUT is −. The opening valuation (the initial cost recorded at creation)
// is the one piece the client can't derive, so it's fetched as a scalar
// (`getAccountOpeningValueFn`) and passed in here.
//
// v1 is UNREALIZED only. A withdrawal reduces cost basis dollar-for-dollar (an
// honest approximation, documented); precise lot accounting (FIFO/average) and
// realized gains are PER-232. If cost basis isn't positive (no opening + no net
// contributions, or more withdrawn than invested after gains), `hasBasis` is
// false and callers show the market value WITHOUT a fabricated return.
//
// Pure; all money stays in bigint minor units, Number only for the display ratio.
// =============================================================================

export interface AccountPerformance {
  costBasisMinor: bigint
  marketValueMinor: bigint
  gainMinor: bigint
  /** Net cash moved in/out via the ledger (excludes the opening). Informational. */
  contributionsMinor: bigint
  /** gain / cost basis, or null when there is no positive basis to measure against. */
  returnPct: number | null
  isGain: boolean
  isFlat: boolean
  hasBasis: boolean
}

export function computeAccountPerformance(
  txns: ReadonlyArray<AnalyticsTxn>,
  openingValueMinor: bigint,
  currentValueMinor: bigint,
  accountId: string
): AccountPerformance {
  const contributions = txns.reduce(
    (sum, t) => sum + signedDeltaForAccount(t, accountId),
    0n
  )
  const costBasis = openingValueMinor + contributions
  const gain = currentValueMinor - costBasis
  const hasBasis = costBasis > 0n
  const returnPct = hasBasis ? Number(gain) / Number(costBasis) : null

  return {
    costBasisMinor: costBasis,
    marketValueMinor: currentValueMinor,
    gainMinor: gain,
    contributionsMinor: contributions,
    returnPct,
    isGain: gain > 0n,
    isFlat: gain === 0n,
    hasBasis,
  }
}
