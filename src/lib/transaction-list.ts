import { signedDeltaForAccount, type AnalyticsTxn } from "./account-analytics"
import { toMoney, ZERO_MONEY, type Money } from "./money"

/**
 * PER-241 — shared transaction-list presentation helpers.
 *
 * The full ledger (`/transactions`) and the per-account statement
 * (`/accounts/$id`) render the SAME row design; only the perspective and the
 * amount of surrounding chrome differ. These pure helpers back both pages so
 * the daily subtotal, density sizing, and direction math stay a single source
 * of truth. Keeping them here (a `.ts`, not the `.tsx` row) makes them unit
 * testable without pulling React into the test.
 */

/** Row density — comfortable is the sensible default; compact packs more rows. */
export type TransactionRowDensity = "compact" | "comfortable"

/**
 * Whose money movement a list represents. The global ledger nets income −
 * expense (an internal transfer is a wash across the whole book, so it is
 * excluded); a per-account statement nets the signed delta touching that one
 * account (a transfer leg counts as + or − from that account's side).
 */
export type LedgerPerspective =
  | { kind: "global" }
  | { kind: "account"; accountId: string }

/**
 * Net movement for a single day's transactions, from the given perspective.
 * Returned as `Money` (bigint minor units) so callers format with the account
 * currency. Pure — the date grouping happens at the call site.
 */
export function dailyNet(
  txns: ReadonlyArray<Pick<AnalyticsTxn, "type" | "amount" | "toAccountId">>,
  perspective: LedgerPerspective
): Money {
  let net: bigint = ZERO_MONEY
  for (const t of txns) {
    if (perspective.kind === "account") {
      net += signedDeltaForAccount(t, perspective.accountId)
    } else if (t.type === "income") {
      net += t.amount
    } else if (t.type === "expense") {
      net -= t.amount
    }
    // Global perspective: transfers are internal moves — excluded from the net.
  }
  return toMoney(net)
}

/**
 * Virtualizer size estimates per density. The measured height still wins
 * (measureElement re-measures expanded splits); these only seed the initial
 * layout so scrolling starts smooth.
 */
export const ROW_ESTIMATE: Record<
  TransactionRowDensity,
  { header: number; row: number }
> = {
  comfortable: { header: 40, row: 64 },
  compact: { header: 32, row: 44 },
}

/** localStorage key for the persisted density choice (guarded, client-only). */
export const DENSITY_STORAGE_KEY = "permoney:tx-density"

/**
 * Read the persisted density, defaulting to "comfortable". SSR-guarded: the
 * routes that use it are `ssr:false`, but this stays safe if ever called where
 * `window`/`localStorage` is unavailable.
 */
export function readStoredDensity(): TransactionRowDensity {
  if (typeof window === "undefined") return "comfortable"
  try {
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY)
    return stored === "compact" ? "compact" : "comfortable"
  } catch {
    return "comfortable"
  }
}

/** Persist the density choice. No-op (never throws) when storage is blocked. */
export function writeStoredDensity(density: TransactionRowDensity): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density)
  } catch {
    // Private-mode / quota errors are non-fatal; the choice just won't persist.
  }
}
