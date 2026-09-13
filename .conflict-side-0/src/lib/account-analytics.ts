import { toDisplayNumber } from "./money"
import { moneyMovementLabel } from "./money-movement"
import { type CurrencyCode } from "@/lib/data/currencies"

// =============================================================================
// PER-218 — pure, unit-tested analytics for the per-account detail page.
//
// Everything here is derived from the ONE canonical ledger (the already-loaded
// transaction collection) plus the account's current balance. No server calls,
// no mutations, no second source of truth — these are read-only lenses, exactly
// like applyFilters. Money math stays in bigint minor units until the very last
// step (chart data needs `number`), where we convert to major units for the
// axis/tooltip.
// =============================================================================

export type AccountRange = "1M" | "3M" | "6M" | "1Y" | "ALL"

export const ACCOUNT_RANGES: ReadonlyArray<{
  value: AccountRange
  label: string
}> = [
  { value: "1M", label: "1M" },
  { value: "3M", label: "3M" },
  { value: "6M", label: "6M" },
  { value: "1Y", label: "1Y" },
  { value: "ALL", label: "All" },
]

export interface AnalyticsTxn {
  id?: string
  date: Date | string
  createdAt?: Date | string
  amount: bigint // absolute magnitude (sign lives in `type`, or `transferIncoming` for a transfer)
  type: string // "income" | "expense" | "transfer"
  // PER-247: the transaction kind (funds_movement / cc_payment / loan_payment /
  // liability_draw / …) and the funds_movement purpose. Together they give a
  // transfer its contextual bucket label instead of a lump "Transfer".
  kind?: string | null
  transferPurpose?: string | null
  accountId: string
  toAccountId?: string | null
  // PER-247: does this row's OWN `accountId` RECEIVE money (toAccount →
  // account), rather than send it out? Server-computed from the authoritative
  // `Transfer.inflowTransactionId` pairing (see server/transactions.ts) — a
  // plain funds_movement transfer's one visible row is always the outflow
  // (false), but a valuation-linked trade/redemption cash leg
  // (postValuationLinkedTransferLegs) sits in the inflow slot for a
  // Sell/redemption despite `accountId` being the CASH account either way.
  // false/undefined for income/expense (their sign lives in `type` alone).
  transferIncoming?: boolean | null
  category?: { name: string; color?: string | null } | null
  merchant?: { name: string } | null
  isSplit?: boolean
}

/**
 * Signed movement of a transaction FROM this account's perspective.
 * income → +, expense → −.
 *
 * A transfer's sign is NOT reliably inferable from `toAccountId === accountId`
 * alone: that holds for a plain funds_movement transfer (its one visible row
 * is always owned by the PAYING account — `accountId` = source, `toAccountId`
 * = destination), but NOT for a valuation-linked trade/redemption cash leg
 * (`postValuationLinkedTransferLegs`), whose row is always owned by the CASH
 * account regardless of direction — a Buy/contribution debits it, a
 * Sell/redemption CREDITS it. Using `toAccountId === accountId` there would
 * wrongly read a Sell's cash-in leg as an outflow (confirmed in production:
 * a Sell's proceeds showed as a negative "Withdraw to <fund>" on the
 * receiving cash account's own statement, when the underlying ledger amount
 * was correctly positive).
 *
 * The correct, general rule: `transferIncoming` (the SAME authoritative,
 * DB-backed signal PER-247 already computes to orient the account-column
 * arrow — see transaction-list-row.tsx) tells us whether the row's OWNER
 * (`trx.accountId`) gained or lost funds — that's true regardless of which
 * account structurally happens to be `accountId` vs `toAccountId`. Viewing
 * from the owner's own account uses that delta directly; viewing from the
 * counterparty (surfaced via `toAccountId`) flips it. Exactly one leg touches
 * a given account's statement, so summing this over the ledger never
 * double-counts (mirrors PER-202).
 */
export function signedDeltaForAccount(
  trx: Pick<
    AnalyticsTxn,
    "type" | "amount" | "accountId" | "toAccountId" | "transferIncoming"
  >,
  accountId: string
): bigint {
  if (trx.type === "income") return trx.amount
  if (trx.type === "expense") return -trx.amount
  const ownerDelta = trx.transferIncoming ? trx.amount : -trx.amount
  return trx.accountId === accountId ? ownerDelta : -ownerDelta
}

/** Start-of-window cutoff for a range, or null for "ALL". */
export function rangeCutoff(
  range: AccountRange,
  now: Date = new Date()
): Date | null {
  if (range === "ALL") return null
  const d = new Date(now)
  switch (range) {
    case "1M":
      d.setMonth(d.getMonth() - 1)
      break
    case "3M":
      d.setMonth(d.getMonth() - 3)
      break
    case "6M":
      d.setMonth(d.getMonth() - 6)
      break
    case "1Y":
      d.setFullYear(d.getFullYear() - 1)
      break
  }
  return d
}

function localIsoDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function chronological(
  a: Pick<AnalyticsTxn, "date" | "createdAt" | "id">,
  b: Pick<AnalyticsTxn, "date" | "createdAt" | "id">
): number {
  const ta = new Date(a.date).getTime()
  const tb = new Date(b.date).getTime()
  if (ta !== tb) return ta - tb
  const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0
  const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0
  if (ca !== cb) return ca - cb
  // PER-261 hardening: `date` AND `createdAt` can be IDENTICAL — two legs
  // written inside the same DB transaction (they share Postgres `now()`), or
  // several rows batch-imported/seeded with one explicit timestamp. Without a
  // final deterministic tiebreak, ties fall through to `Array.prototype.sort`
  // stability over whatever order the array arrived in — and per this file's
  // own `orderStatementRows` doc comment, a per-account `useLiveQuery` has NO
  // intrinsic order, so that incidental order can silently change between
  // re-renders (e.g. an unrelated background resync touching the same
  // collection). A statement row reordering itself out from under a click is
  // a "wrong row got edited" risk this ledger cannot allow — tiebreak on `id`
  // so two ties always land in the same relative position, render after
  // render, regardless of the live query's underlying array order.
  if (a.id != null && b.id != null && a.id !== b.id) {
    return a.id < b.id ? -1 : 1
  }
  return 0
}

/**
 * Order statement rows for display: newest DATE first, and within the same date
 * the most-recently-CREATED first. A per-account `useLiveQuery(from(...))` has
 * NO intrinsic order — TanStack DB's differential dataflow is explicitly
 * non-deterministic without an `orderBy` (see db-core/live-queries skill) — so
 * the account statement must sort explicitly, exactly like the /transactions
 * ledger does. The createdAt tiebreak surfaces a just-added BACKDATED entry at
 * the top of its day, which is what reconciling against a bank statement needs
 * (record today, date it to the posting day, still see it immediately). A
 * final `id` tiebreak (PER-261) makes the order fully deterministic even when
 * date AND createdAt both tie, independent of the live query's own array
 * order. Pure + unit-tested; the route only calls it.
 */
export function orderStatementRows<
  T extends Pick<AnalyticsTxn, "date" | "createdAt" | "id">,
>(rows: ReadonlyArray<T>): T[] {
  // chronological() is ascending (date asc, createdAt asc, id asc); negate
  // for desc. The `id` tiebreak is direction-agnostic (any stable order is
  // fine) so negating it is harmless — it just flips which of two exact ties
  // sorts first, consistently every time.
  return [...rows].sort((a, b) => -chronological(a, b))
}

export interface BalancePoint {
  /** Local ISO day, e.g. "2026-07-31". */
  date: string
  /** Balance in MAJOR units (for the chart axis/tooltip). */
  balance: number
}

/**
 * Reconstruct the account balance after each day, chronologically, ending at
 * `currentBalance` today. Correct for `balanceSource="transaction_flow"`
 * (cash-like) accounts, where balance = opening + Σ(deltas): we back out the
 * opening balance as `currentBalance − Σ(all deltas)` and walk forward.
 *
 * When a range is given, points before the cutoff collapse into a single anchor
 * point AT the cutoff (carrying the balance as of then), so the line starts at
 * the right level instead of zero. One point per day (last balance wins).
 */
export function buildBalanceSeries(
  txns: ReadonlyArray<AnalyticsTxn>,
  currentBalance: bigint,
  accountId: string,
  currency: string,
  range: AccountRange = "ALL",
  now: Date = new Date()
): BalancePoint[] {
  const sorted = [...txns].sort(chronological)
  const total = sorted.reduce(
    (sum, t) => sum + signedDeltaForAccount(t, accountId),
    0n
  )
  const opening = currentBalance - total

  let running = opening
  const walked: Array<{ ms: number; iso: string; bal: bigint }> = []
  for (const t of sorted) {
    running += signedDeltaForAccount(t, accountId)
    const dt = new Date(t.date)
    walked.push({ ms: dt.getTime(), iso: localIsoDay(dt), bal: running })
  }

  const cutoff = rangeCutoff(range, now)
  let windowed = walked
  if (cutoff) {
    const cutMs = cutoff.getTime()
    const before = walked.filter((p) => p.ms < cutMs)
    const inRange = walked.filter((p) => p.ms >= cutMs)
    const anchorBal = before.length ? before[before.length - 1].bal : opening
    windowed = [
      { ms: cutMs, iso: localIsoDay(cutoff), bal: anchorBal },
      ...inRange,
    ]
  }

  // Collapse to one point per day (last balance of the day), then force a
  // final "today" point equal to the authoritative current balance.
  const byDay = new Map<string, bigint>()
  for (const p of windowed) byDay.set(p.iso, p.bal)
  byDay.set(localIsoDay(now), currentBalance)

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bal]) => ({
      date,
      balance: toDisplayNumber(bal, currency as CurrencyCode),
    }))
}

export interface CategorySlice {
  name: string
  color: string | null
  /** Absolute total in minor units. */
  total: bigint
}

/**
 * Aggregate the account's movements by category (or merchant/label fallback),
 * for one direction: "out" (money leaving the account) or "in" (arriving).
 * Returns slices sorted by magnitude, optionally capped to `limit`.
 */
export function summarizeCategories(
  txns: ReadonlyArray<AnalyticsTxn>,
  accountId: string,
  opts?: { direction?: "out" | "in"; limit?: number }
): CategorySlice[] {
  const direction = opts?.direction ?? "out"
  const map = new Map<string, { color: string | null; total: bigint }>()
  for (const t of txns) {
    const delta = signedDeltaForAccount(t, accountId)
    if (delta === 0n) continue
    const isOut = delta < 0n
    if (direction === "out" && !isOut) continue
    if (direction === "in" && isOut) continue
    // PER-247: a transfer is bucketed by its CONTEXTUAL money-movement label
    // (Invest / Withdraw / Top-up / Pay credit card / Pay loan / Borrow / …),
    // not lumped under one meaningless "Transfer". One source of truth shared
    // with the ledger list and the per-account statement rows.
    const name =
      t.type === "transfer"
        ? moneyMovementLabel({ kind: t.kind, purpose: t.transferPurpose })
        : (t.category?.name ??
          t.merchant?.name ??
          (t.isSplit ? "Split" : "Uncategorized"))
    const color = t.category?.color ?? null
    const abs = isOut ? -delta : delta
    const existing = map.get(name)
    if (existing) existing.total += abs
    else map.set(name, { color, total: abs })
  }
  const slices = [...map.entries()].map(([name, v]) => ({
    name,
    color: v.color,
    total: v.total,
  }))
  slices.sort((a, b) => (a.total < b.total ? 1 : a.total > b.total ? -1 : 0))
  return typeof opts?.limit === "number" ? slices.slice(0, opts.limit) : slices
}

/** Free-text match over description / merchant / category (case-insensitive). */
export function matchesQuery(
  trx: {
    description?: string | null
    merchant?: { name: string } | null
    category?: { name: string } | null
  },
  query: string
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    (trx.description ?? "").toLowerCase().includes(q) ||
    (trx.merchant?.name ?? "").toLowerCase().includes(q) ||
    (trx.category?.name ?? "").toLowerCase().includes(q)
  )
}

export interface StatementCsvRow {
  date: Date | string
  description?: string | null
  type: string
  amount: bigint
  currency: string
  accountId: string
  toAccountId?: string | null
  // REQUIRED, not optional: `signedDeltaForAccount` accepts it optionally (an
  // income/expense row has no direction to carry), and an OPTIONAL field here
  // let a transfer row omit the one authoritative direction signal and silently
  // fall back to the structural `toAccountId` inference — the EXACT shape of the
  // production sign bug that made a Sell's proceeds render negative on the
  // receiving cash account. Every caller passes real statement rows, which
  // always carry it; requiring it keeps a future caller from reintroducing the
  // bug in the CSV export instead of the list.
  transferIncoming: boolean | null
  account?: { name: string } | null
  toAccount?: { name: string } | null
  category?: { name: string } | null
  merchant?: { name: string } | null
  isSplit?: boolean
}

/** RFC-4180 field quoting: wrap in quotes and double internal quotes when the
 * value contains a comma, quote, or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function labelFor(
  row: StatementCsvRow,
  accountId: string,
  direction: 1 | -1
): string {
  if (row.type === "transfer") {
    // The counterparty is "the OTHER side of this row", which depends on which
    // account we are looking FROM — never on the direction of money. Naming it
    // by direction alone was wrong for a valuation-linked leg (a Sell's
    // proceeds): that row's `accountId` IS this cash account AND it is
    // incoming, so the old "incoming ⇒ the source is `account`" rule labelled a
    // reksadana redemption "Transfer from Bank Jago" on Bank Jago's own
    // statement instead of "Transfer from Bibit". Same rule the statement row
    // renderer uses (transaction-list-row.tsx, PER-247).
    const counterparty =
      row.accountId === accountId ? row.toAccount?.name : row.account?.name
    return direction === 1
      ? `Transfer from ${counterparty ?? "account"}`
      : `Transfer to ${counterparty ?? "account"}`
  }
  return (
    row.category?.name ??
    row.merchant?.name ??
    (row.isSplit ? "Split" : "Uncategorized")
  )
}

/**
 * Serialize an account's statement (as the user currently sees it — pass the
 * already-filtered rows) to CSV. Amount is signed FROM this account's
 * perspective, in MAJOR units. Pure + unit-tested; the browser download wrapper
 * lives in the route.
 */
export function buildStatementCsv(
  rows: ReadonlyArray<StatementCsvRow>,
  accountId: string
): string {
  const header = [
    "Date",
    "Description",
    "Category",
    "Type",
    "Amount",
    "Currency",
  ]
  const lines = [header.join(",")]
  for (const row of rows) {
    const delta = signedDeltaForAccount(row, accountId)
    const direction: 1 | -1 = delta >= 0n ? 1 : -1
    const magnitude = delta < 0n ? -delta : delta
    const major = toDisplayNumber(magnitude, row.currency as CurrencyCode)
    const signed = direction === 1 ? major : -major
    const isoDate = new Date(row.date).toISOString().slice(0, 10)
    lines.push(
      [
        csvField(isoDate),
        csvField(row.description ?? ""),
        csvField(labelFor(row, accountId, direction)),
        csvField(row.type),
        csvField(String(signed)),
        csvField(row.currency),
      ].join(",")
    )
  }
  return lines.join("\r\n")
}
