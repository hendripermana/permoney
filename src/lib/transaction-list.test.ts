import { describe, expect, it } from "vite-plus/test"

import {
  computeRunningBalances,
  dailyNet,
  formatRelativeDay,
} from "./transaction-list"
import { toMoney } from "./money"

type Txn = {
  type: string
  amount: bigint
  accountId: string
  toAccountId?: string | null
  transferIncoming?: boolean | null
}

// Income/expense never read `accountId` in signedDeltaForAccount (sign lives
// in `type` alone), but the real shape always carries one — this placeholder
// keeps the fixture type-honest without being semantically meaningful here.
const income = (amount: bigint): Txn => ({
  type: "income",
  amount,
  accountId: "any",
})
const expense = (amount: bigint): Txn => ({
  type: "expense",
  amount,
  accountId: "any",
})
// Models a plain funds_movement transfer's one visible row: always owned by
// the PAYING account (transferIncoming: false — see signedDeltaForAccount's
// doc comment for why this matters for a valuation-linked leg, which this
// helper does NOT model).
const transferTo = (
  amount: bigint,
  accountId: string,
  toAccountId: string
): Txn => ({
  type: "transfer",
  amount,
  accountId,
  toAccountId,
  transferIncoming: false,
})

describe("dailyNet — global perspective", () => {
  it("nets income minus expense", () => {
    const rows = [income(10_000n), expense(3_000n), expense(2_000n)]
    expect(dailyNet(rows, { kind: "global" })).toBe(5_000n)
  })

  it("excludes transfers (internal moves are a wash across the whole book)", () => {
    const rows = [income(10_000n), transferTo(4_000n, "acc-y", "acc-x")]
    expect(dailyNet(rows, { kind: "global" })).toBe(10_000n)
  })

  it("is zero for an empty day", () => {
    expect(dailyNet([], { kind: "global" })).toBe(0n)
  })
})

describe("dailyNet — account perspective", () => {
  const A = "acc-A"

  it("adds income and subtracts expense touching the account", () => {
    const rows = [income(10_000n), expense(2_500n)]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(7_500n)
  })

  it("counts a transfer INTO the account as positive", () => {
    const rows = [transferTo(6_000n, "other", A)]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(6_000n)
  })

  it("counts a transfer OUT of the account (destination is elsewhere) as negative", () => {
    const rows = [transferTo(6_000n, A, "acc-other")]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(-6_000n)
  })

  it("nets mixed movement from the account's side", () => {
    const rows = [
      income(10_000n),
      expense(1_000n),
      transferTo(3_000n, "other", A), // +3,000 into A
      transferTo(2_000n, A, "acc-other"), // −2,000 out of A
    ]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(10_000n)
  })
})

// ── PER-241 revision — running (register) balance ──────────────────────────
describe("computeRunningBalances", () => {
  const A = "acc-A"
  type IdTxn = Txn & { id: string }
  const row = (id: string, t: Txn): IdTxn => ({ id, ...t })

  it("walks down from the current balance, one balance-after per row", () => {
    // Newest-first: current balance is the balance AFTER the newest row.
    const rows: IdTxn[] = [
      row("r1", income(3_000n)), // newest: +3,000 into A
      row("r2", expense(2_000n)), // −2,000 from A
      row("r3", transferTo(1_000n, "other", A)), // oldest: +1,000 into A
    ]
    const balances = computeRunningBalances(rows, A, toMoney(10_000n))
    // after r1 = current
    expect(balances.get("r1")).toBe(10_000n)
    // after r2 = 10,000 − 3,000 (r1's delta)
    expect(balances.get("r2")).toBe(7_000n)
    // after r3 = 7,000 − (−2,000) (r2's delta)
    expect(balances.get("r3")).toBe(9_000n)
  })

  it("reconciles: opening + Σ chronological deltas === current balance", () => {
    const rows: IdTxn[] = [
      row("r1", income(3_000n)),
      row("r2", expense(2_000n)),
      row("r3", transferTo(1_000n, "other", A)),
    ]
    const current = 10_000n
    const balances = computeRunningBalances(rows, A, toMoney(current))
    // Oldest row's balance-after minus its own delta is the opening balance;
    // replaying every delta forward must return to `current`.
    const opening = 9_000n - 1_000n // after r3 − r3's delta
    const replay = opening + 1_000n - 2_000n + 3_000n
    expect(replay).toBe(current)
    // Sanity: newest row's balance-after is always the current balance.
    expect(balances.get("r1")).toBe(current)
  })

  it("treats a transfer OUT (destination elsewhere) as a debit", () => {
    const rows: IdTxn[] = [row("r1", transferTo(4_000n, A, "acc-other"))]
    const balances = computeRunningBalances(rows, A, toMoney(6_000n))
    // The only row moved 4,000 OUT of A, so before it the balance was 10,000.
    expect(balances.get("r1")).toBe(6_000n)
  })

  it("returns an empty map for no rows", () => {
    expect(computeRunningBalances([], A, toMoney(1_000n)).size).toBe(0)
  })
})

// ── PER-241 revision — relative date-group labels ──────────────────────────
describe("formatRelativeDay", () => {
  // Fixed "now" = Sat Aug 15 2026 (local), so the mapping is deterministic.
  const now = new Date(2026, 7, 15)

  it("labels today and yesterday", () => {
    expect(formatRelativeDay("2026-08-15", now)).toBe("Today")
    expect(formatRelativeDay("2026-08-14", now)).toBe("Yesterday")
  })

  it("labels the past week by weekday name", () => {
    // 3 days back → a weekday name, not a date.
    expect(formatRelativeDay("2026-08-12", now)).toMatch(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/
    )
    // Boundary: 6 days back is still a weekday.
    expect(formatRelativeDay("2026-08-09", now)).toMatch(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/
    )
  })

  it("labels older in-year days as a compact weekday + date (no year)", () => {
    // 10 days back → "EEE, MMM d".
    expect(formatRelativeDay("2026-08-05", now)).toMatch(/^\w{3}, Aug 5$/)
  })

  it("labels a different year with the year", () => {
    expect(formatRelativeDay("2025-08-05", now)).toBe("Aug 5, 2025")
  })

  it("parses the day key in LOCAL time (never UTC-midnight drift)", () => {
    // A local Date for the same calendar day resolves identically to its key.
    expect(formatRelativeDay(new Date(2026, 7, 15), now)).toBe("Today")
  })
})
