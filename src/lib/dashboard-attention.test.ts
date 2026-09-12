import { describe, expect, test } from "vite-plus/test"
import { type AnalyticsTxn } from "./account-analytics"
import {
  computeDashboardAttention,
  type DashboardAttentionAccountInput,
} from "./dashboard-attention"
import { type FilterableTransaction } from "./transaction-filters"

type Txn = AnalyticsTxn & FilterableTransaction

const NOW = new Date("2026-09-12T12:00:00.000Z")
const DAY_MS = 86_400_000
let nextId = 0

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS)
}
function baseFields() {
  return {
    id: `txn-${nextId++}`,
    categoryId: null,
    merchantId: null,
    notes: null,
    status: "CLEARED",
    merchant: null,
  }
}
function expense(accountId: string, amount: bigint, n: number): Txn {
  return {
    ...baseFields(),
    date: daysAgo(n),
    amount,
    type: "expense",
    accountId,
    description: "test expense",
  }
}
function income(accountId: string, amount: bigint, n: number): Txn {
  return {
    ...baseFields(),
    date: daysAgo(n),
    amount,
    type: "income",
    accountId,
    description: "test income",
  }
}

function account(
  overrides: Partial<DashboardAttentionAccountInput> & { id: string }
): DashboardAttentionAccountInput {
  return {
    name: overrides.id,
    currency: "IDR",
    accountClass: "ASSET",
    balanceSource: "transaction_flow",
    balance: "1000000",
    reserveBalance: null,
    accountSubtype: "checking",
    status: "active",
    ...overrides,
  }
}

describe("computeDashboardAttention", () => {
  test("surfaces an account burning toward its reserve as an attention item", () => {
    const acc = account({
      id: "acc-critical",
      balance: "700000",
      reserveBalance: "500000",
    })
    // Steady burn over 3+ in-window transactions (computeAccountRunway needs
    // >= minSamples=3 in-window txns to forecast rather than report
    // "insufficient_data") that projects under 7 days to the reserve floor.
    const txns = [
      income(acc.id, 5_000_000n, 90),
      expense(acc.id, 300_000n, 20),
      expense(acc.id, 300_000n, 10),
      expense(acc.id, 300_000n, 2),
    ]

    const result = computeDashboardAttention([acc], txns, { now: NOW })

    expect(result.attention).toHaveLength(1)
    expect(result.attention[0]?.accountId).toBe("acc-critical")
    expect(result.attention[0]?.runway.status).toBe("critical")
  })

  test("surfaces a large untouched surplus as an idle opportunity", () => {
    const acc = account({
      id: "acc-idle",
      balance: "10000000",
      reserveBalance: "500000",
    })
    const txns = [
      income(acc.id, 10_000_000n, 90),
      expense(acc.id, 50_000n, 20),
      income(acc.id, 50_000n, 10),
    ]

    const result = computeDashboardAttention([acc], txns, { now: NOW })

    expect(result.idleOpportunities).toHaveLength(1)
    expect(result.idleOpportunities[0]?.accountId).toBe("acc-idle")
    expect(result.attention).toHaveLength(0)
  })

  test("excludes a savings account from idle opportunities (idle is the point)", () => {
    const acc = account({
      id: "acc-savings",
      accountSubtype: "savings",
      balance: "10000000",
      reserveBalance: "500000",
    })
    const txns = [income(acc.id, 10_000_000n, 90)]

    const result = computeDashboardAttention([acc], txns, { now: NOW })

    expect(result.idleOpportunities).toHaveLength(0)
  })

  test("ignores non-cash-like and archived accounts entirely", () => {
    const trackedAsset = account({
      id: "acc-tracked",
      balanceSource: "valuation",
      balance: "10000000",
    })
    const archived = account({
      id: "acc-archived",
      status: "archived",
      balance: "600000",
      reserveBalance: "500000",
    })
    const txns = [
      income(trackedAsset.id, 10_000_000n, 90),
      income(archived.id, 5_000_000n, 90),
      expense(archived.id, 300_000n, 5),
      expense(archived.id, 300_000n, 3),
    ]

    const result = computeDashboardAttention([trackedAsset, archived], txns, {
      now: NOW,
    })

    expect(result.attention).toHaveLength(0)
    expect(result.idleOpportunities).toHaveLength(0)
  })

  test("returns empty lists (not an error) when every account is healthy", () => {
    const acc = account({ id: "acc-healthy", balance: "1000000" })
    const txns = [income(acc.id, 1_000_000n, 5)]

    const result = computeDashboardAttention([acc], txns, { now: NOW })

    expect(result.attention).toEqual([])
    expect(result.idleOpportunities).toEqual([])
  })

  test("caps each list at 3 and sorts attention worst-first (below before critical/watch)", () => {
    const belowAcc = account({
      id: "acc-below",
      balance: "400000",
      reserveBalance: "500000",
    })
    const criticalAccounts = ["acc-c1", "acc-c2", "acc-c3", "acc-c4"].map(
      (id) => account({ id, balance: "520000", reserveBalance: "500000" })
    )
    const allAccounts = [...criticalAccounts, belowAcc]
    // Each critical account: available=20,000, 3 in-window expenses of 50,000
    // (>= minSamples=3) => burnPerDay=5,000 => daysToReserve=4 => "critical".
    const txns = allAccounts.flatMap((acc) => [
      income(acc.id, 5_000_000n, 90),
      expense(acc.id, 50_000n, 20),
      expense(acc.id, 50_000n, 10),
      expense(acc.id, 50_000n, 2),
    ])

    const result = computeDashboardAttention(allAccounts, txns, { now: NOW })

    expect(result.attention.length).toBeLessThanOrEqual(3)
    // The already-below-reserve account must sort first regardless of the
    // four other alerting accounts competing for the capped slots.
    expect(result.attention[0]?.accountId).toBe("acc-below")
  })
})
