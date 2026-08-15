import { differenceInCalendarDays, format } from "date-fns"

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

// ── PER-241 revision — relative date-group headers ─────────────────────────
// A `yyyy-MM-dd` day key is produced LOCALLY (via date-fns `format`) at the
// call site, so parse it back into a LOCAL date — never `new Date("yyyy-MM-dd")`,
// which is UTC-midnight and lands on the previous day in negative-offset zones.
function toLocalDay(day: Date | string): Date {
  if (typeof day !== "string") return day
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/**
 * Human, register-style label for a date-group header: "Today" / "Yesterday"
 * for the two most recent days, the weekday name ("Wednesday") within the past
 * week, then a compact date ("Wed, Aug 12" in-year, "Aug 12, 2024" otherwise).
 * `now` is injected so the mapping is deterministic and unit-testable. Pure;
 * both the ledger and the per-account statement render through it so their day
 * separators read identically. Future dates fall through to the compact date.
 */
export function formatRelativeDay(
  day: Date | string,
  now: Date = new Date()
): string {
  const d = toLocalDay(day)
  const diff = differenceInCalendarDays(now, d)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  if (diff > 1 && diff < 7) return format(d, "EEEE")
  return format(
    d,
    d.getFullYear() === now.getFullYear() ? "EEE, MMM d" : "MMM d, yyyy"
  )
}

// ── PER-241 revision — per-account running (register) balance ───────────────

/** A row carrying the identity + signed-delta inputs the register walk needs. */
type RunningBalanceRow = { id: string } & Pick<
  AnalyticsTxn,
  "type" | "amount" | "toAccountId"
>

/**
 * Reconstruct the account balance AFTER each statement row — Sure's "register
 * balance" column, translated to our ledger.
 *
 * Robust by construction: it starts from the account's authoritative CURRENT
 * balance at the TOP of a newest-first ordered list and walks DOWNWARD,
 * subtracting each row's signed delta to recover the balance as of the next
 * older row. It deliberately does NOT read `accountBalanceAfter` — that column
 * is the balance of the row's OWN `accountId`, which is wrong for a transfer
 * leg surfaced into this account via `toAccountId`. `signedDeltaForAccount`
 * gives the correct per-account delta for every leg, so summing back up the
 * list always reconciles to `currentBalance`.
 *
 * Pass the FULL account ledger (unfiltered by search/type/range) so the top of
 * the walk is the true newest row; the returned map is keyed by row id, so a
 * filtered view can still look up each visible row's real historical balance.
 *
 * @returns Map of transaction id → balance immediately AFTER that row.
 */
export function computeRunningBalances(
  orderedNewestFirst: ReadonlyArray<RunningBalanceRow>,
  accountId: string,
  currentBalance: Money
): Map<string, Money> {
  const result = new Map<string, Money>()
  let running: bigint = currentBalance
  for (const row of orderedNewestFirst) {
    // Balance AFTER this row is the running total at this point in the walk.
    result.set(row.id, toMoney(running))
    // Step to the balance after the next (older) row by removing this row's
    // contribution.
    running = running - signedDeltaForAccount(row, accountId)
  }
  return result
}

/**
 * Indexes of the header rows in a flat virtual-row list, for sticky-header
 * range extraction. Pure so both routes derive it identically.
 */
export function headerRowIndexes(
  rows: ReadonlyArray<{ kind: "header" | "transaction" }>
): number[] {
  const out: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "header") out.push(i)
  }
  return out
}
