import { describe, expect, it } from "vite-plus/test"

import {
  buildBalanceSeries,
  buildStatementCsv,
  matchesQuery,
  orderStatementRows,
  rangeCutoff,
  signedDeltaForAccount,
  summarizeCategories,
  type AnalyticsTxn,
  type StatementCsvRow,
} from "./account-analytics"

const ID = "acc-1"

function txn(partial: Partial<AnalyticsTxn>): AnalyticsTxn {
  return {
    date: "2026-01-01",
    amount: 0n,
    type: "expense",
    accountId: ID,
    ...partial,
  }
}

describe("signedDeltaForAccount", () => {
  it("income is positive, expense negative", () => {
    expect(signedDeltaForAccount({ type: "income", amount: 100n }, ID)).toBe(
      100n
    )
    expect(signedDeltaForAccount({ type: "expense", amount: 100n }, ID)).toBe(
      -100n
    )
  })
  it("transfer is + when this account is the destination, − when source", () => {
    expect(
      signedDeltaForAccount(
        { type: "transfer", amount: 100n, toAccountId: ID },
        ID
      )
    ).toBe(100n)
    expect(
      signedDeltaForAccount(
        { type: "transfer", amount: 100n, toAccountId: "other" },
        ID
      )
    ).toBe(-100n)
  })
})

describe("rangeCutoff", () => {
  it("returns null for ALL", () => {
    expect(rangeCutoff("ALL")).toBeNull()
  })
  it("subtracts the right window", () => {
    const now = new Date("2026-04-01T00:00:00")
    const oneMonth = rangeCutoff("1M", now)!
    // Local date math (tz-independent): April → March.
    expect(oneMonth.getFullYear()).toBe(2026)
    expect(oneMonth.getMonth()).toBe(2) // 0-indexed March
    expect(rangeCutoff("1Y", now)?.getFullYear()).toBe(2025)
  })
})

describe("buildBalanceSeries", () => {
  const txns: AnalyticsTxn[] = [
    txn({ date: "2026-01-10", type: "income", amount: 100_000n }),
    txn({ date: "2026-02-15", type: "expense", amount: 30_000n }),
    txn({
      date: "2026-03-20",
      type: "transfer",
      amount: 50_000n,
      toAccountId: ID,
    }),
  ]
  const now = new Date("2026-04-01T00:00:00")

  it("reconstructs balance-after per day, ending at the current balance", () => {
    // Σ deltas = +100k −30k +50k = +120k. currentBalance 120k ⇒ opening 0.
    const series = buildBalanceSeries(txns, 120_000n, ID, "IDR", "ALL", now)
    // Major units: 120_000 minor / 100 = 1200.
    const byDate = Object.fromEntries(series.map((p) => [p.date, p.balance]))
    expect(byDate["2026-01-10"]).toBe(1000)
    expect(byDate["2026-02-15"]).toBe(700)
    expect(byDate["2026-03-20"]).toBe(1200)
    // Final point is today = authoritative current balance.
    expect(series[series.length - 1].balance).toBe(1200)
  })

  it("backs out a non-zero opening balance", () => {
    // currentBalance 200k, Σ deltas 120k ⇒ opening 80k (800 major).
    const series = buildBalanceSeries(txns, 200_000n, ID, "IDR", "ALL", now)
    const byDate = Object.fromEntries(series.map((p) => [p.date, p.balance]))
    expect(byDate["2026-01-10"]).toBe(1800) // 80k + 100k = 180k
    expect(series[series.length - 1].balance).toBe(2000)
  })

  it("anchors the window at the cutoff carrying the pre-cutoff balance", () => {
    const series = buildBalanceSeries(txns, 120_000n, ID, "IDR", "1M", now)
    // cutoff = 2026-03-01; last balance before it is 700 (after the Feb expense).
    expect(series[0].date).toBe("2026-03-01")
    expect(series[0].balance).toBe(700)
    // Jan/Feb daily points are collapsed away.
    expect(series.some((p) => p.date === "2026-01-10")).toBe(false)
  })

  it("handles an empty ledger as a single current-balance point", () => {
    const series = buildBalanceSeries([], 50_000n, ID, "IDR", "ALL", now)
    expect(series).toHaveLength(1)
    expect(series[0].balance).toBe(500)
  })
})

describe("summarizeCategories", () => {
  const txns: AnalyticsTxn[] = [
    txn({ type: "expense", amount: 30_000n, category: { name: "Food" } }),
    txn({ type: "expense", amount: 20_000n, category: { name: "Food" } }),
    txn({ type: "expense", amount: 10_000n, category: { name: "Transport" } }),
    txn({ type: "income", amount: 100_000n, category: { name: "Salary" } }),
  ]

  it("aggregates outflow by category, sorted by magnitude", () => {
    const out = summarizeCategories(txns, ID, { direction: "out" })
    expect(out.map((s) => [s.name, s.total])).toEqual([
      ["Food", 50_000n],
      ["Transport", 10_000n],
    ])
  })

  it("respects the limit", () => {
    const out = summarizeCategories(txns, ID, { direction: "out", limit: 1 })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("Food")
  })

  it("aggregates inflow separately", () => {
    const inn = summarizeCategories(txns, ID, { direction: "in" })
    expect(inn).toEqual([{ name: "Salary", color: null, total: 100_000n }])
  })

  // PER-247 — transfers are bucketed by their CONTEXTUAL money-movement label
  // (derived from kind + purpose), never lumped under one meaningless
  // "Transfer". Different purposes/kinds must NOT collapse into one bucket.
  it("buckets transfers by contextual money-movement label", () => {
    const transferTxns: AnalyticsTxn[] = [
      // Liability payment kinds read from `kind` (no purpose).
      txn({
        type: "transfer",
        amount: 40_000n,
        toAccountId: "cc",
        kind: "cc_payment",
      }),
      // Investment contribution reads from `purpose`.
      txn({
        type: "transfer",
        amount: 25_000n,
        toAccountId: "bibit",
        kind: "funds_movement",
        transferPurpose: "investment_contribution",
      }),
      // A plain movement (no purpose) falls back to "Transfer".
      txn({
        type: "transfer",
        amount: 15_000n,
        toAccountId: "other",
        kind: "funds_movement",
      }),
    ]
    const out = summarizeCategories(transferTxns, ID, { direction: "out" })
    expect(out.map((s) => [s.name, s.total])).toEqual([
      ["Pay credit card", 40_000n],
      ["Invest", 25_000n],
      ["Transfer", 15_000n],
    ])
  })

  it("does not merge two different-purpose transfers into one bucket", () => {
    const transferTxns: AnalyticsTxn[] = [
      txn({
        type: "transfer",
        amount: 30_000n,
        toAccountId: "bibit",
        kind: "funds_movement",
        transferPurpose: "investment_contribution",
      }),
      txn({
        type: "transfer",
        amount: 20_000n,
        toAccountId: "gopay",
        kind: "funds_movement",
        transferPurpose: "top_up",
      }),
    ]
    const out = summarizeCategories(transferTxns, ID, { direction: "out" })
    expect(out).toHaveLength(2)
    expect(out.map((s) => s.name).sort()).toEqual(["Invest", "Top-up"])
  })
})

describe("buildStatementCsv", () => {
  const rows: StatementCsvRow[] = [
    {
      date: "2026-03-10",
      description: "Kopi, Kenangan",
      type: "expense",
      amount: 35_000n,
      currency: "IDR",
      accountId: ID,
      category: { name: "Food" },
    },
    {
      date: "2026-03-11",
      description: "Salary",
      type: "income",
      amount: 100_000n,
      currency: "IDR",
      accountId: ID,
      category: { name: "Salary" },
    },
    {
      date: "2026-03-12",
      type: "transfer",
      amount: 50_000n,
      currency: "IDR",
      accountId: ID,
      toAccountId: "other",
      toAccount: { name: "GoPay" },
    },
  ]

  it("emits a header and one signed, major-unit row per transaction", () => {
    const lines = buildStatementCsv(rows, ID).split("\r\n")
    expect(lines[0]).toBe("Date,Description,Category,Type,Amount,Currency")
    // Expense → negative; description with a comma is quoted (RFC-4180).
    expect(lines[1]).toBe('2026-03-10,"Kopi, Kenangan",Food,expense,-350,IDR')
    // Income → positive.
    expect(lines[2]).toBe("2026-03-11,Salary,Salary,income,1000,IDR")
    // Transfer out → negative, labelled with the destination account.
    expect(lines[3]).toBe("2026-03-12,,Transfer to GoPay,transfer,-500,IDR")
  })

  it("returns just the header for an empty statement", () => {
    expect(buildStatementCsv([], ID)).toBe(
      "Date,Description,Category,Type,Amount,Currency"
    )
  })
})

describe("orderStatementRows", () => {
  // PER-247 — the per-account live query is unordered (TanStack DB is
  // non-deterministic without orderBy), so the statement must sort explicitly:
  // newest date first, most-recently-created first within the same date.
  it("orders newest date first", () => {
    const rows = [
      txn({ date: "2026-01-01" }),
      txn({ date: "2026-03-01" }),
      txn({ date: "2026-02-01" }),
    ]
    expect(orderStatementRows(rows).map((r) => r.date)).toEqual([
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ])
  })

  it("surfaces a just-added backdated entry above same-date older rows", () => {
    // Both dated the same day; the one CREATED later (recorded today for a
    // past posting day) must sort first so reconciliation sees it immediately.
    // `amount` is the per-row discriminator here.
    const olderlyRecorded = txn({
      date: "2026-02-10",
      createdAt: "2026-02-10T09:00:00Z",
      amount: 111n,
    })
    const justAdded = txn({
      date: "2026-02-10",
      createdAt: "2026-08-12T09:00:00Z",
      amount: 222n,
    })
    const ordered = orderStatementRows([olderlyRecorded, justAdded])
    expect(ordered.map((r) => r.amount)).toEqual([222n, 111n])
  })

  it("does not mutate the input array", () => {
    const rows = [txn({ date: "2026-01-01" }), txn({ date: "2026-02-01" })]
    const snapshot = rows.map((r) => r.date)
    orderStatementRows(rows)
    expect(rows.map((r) => r.date)).toEqual(snapshot)
  })
})

describe("matchesQuery", () => {
  it("matches description, merchant, or category case-insensitively", () => {
    const t = {
      description: "Kopi Kenangan",
      merchant: { name: "Kopi Kenangan" },
      category: { name: "Food & Drink" },
    }
    expect(matchesQuery(t, "kopi")).toBe(true)
    expect(matchesQuery(t, "FOOD")).toBe(true)
    expect(matchesQuery(t, "xyz")).toBe(false)
    expect(matchesQuery(t, "")).toBe(true)
  })
})
