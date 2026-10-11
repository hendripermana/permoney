import { getAccountHoldingsFn } from "@/server/holdings"
import { getAccountOpeningValueFn } from "@/server/valuations"

// =============================================================================
// PER-230 / PER-231 — the two per-account scalars the client cannot derive
// from the ledger collections: the opening valuation and the holdings cost
// basis. Both surfaces that need a portfolio cost basis — the full
// /investments report (Slice 2) and the compact dashboard portfolio card
// (Slice 3) — load them through this ONE contract, so they can never show a
// different basis (and therefore a different gain) for the same account.
//
// Client-callable by design (same pattern as src/lib/collections.ts): these
// are `createServerFn` RPC wrappers, not direct @prisma/client access, so this
// module needs no `.server.ts` suffix and stays safe in the client bundle.
// =============================================================================

export interface AccountScalars {
  /** The opening valuation (native minor units), or null when none was recorded. */
  openingValueMinor: bigint | null
  /** Σ holdings cost when the account tracks positions, else null. */
  holdingsCostBasisMinor: bigint | null
}

export interface AccountScalarsRow extends AccountScalars {
  accountId: string
}

/**
 * The one scalar pair the client cannot derive from the collections, fetched
 * with the SAME server functions the account detail page uses. Both are
 * cheap single-row reads; they run in parallel for the whole portfolio.
 */
export async function loadAccountScalars(
  accountId: string
): Promise<AccountScalarsRow> {
  const [opening, holdings] = await Promise.all([
    getAccountOpeningValueFn({ data: { accountId } }),
    getAccountHoldingsFn({ data: { accountId } }),
  ])
  return {
    accountId,
    openingValueMinor:
      opening.openingValue !== null ? BigInt(opening.openingValue) : null,
    holdingsCostBasisMinor:
      holdings.holdings.length > 0 ? BigInt(holdings.totalCostMinor) : null,
  }
}
