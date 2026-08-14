import { describe, expect, it } from "vite-plus/test"

import { dailyNet } from "./transaction-list"

type Txn = {
  type: string
  amount: bigint
  toAccountId?: string | null
}

const income = (amount: bigint): Txn => ({ type: "income", amount })
const expense = (amount: bigint): Txn => ({ type: "expense", amount })
const transferTo = (amount: bigint, toAccountId: string): Txn => ({
  type: "transfer",
  amount,
  toAccountId,
})

describe("dailyNet — global perspective", () => {
  it("nets income minus expense", () => {
    const rows = [income(10_000n), expense(3_000n), expense(2_000n)]
    expect(dailyNet(rows, { kind: "global" })).toBe(5_000n)
  })

  it("excludes transfers (internal moves are a wash across the whole book)", () => {
    const rows = [income(10_000n), transferTo(4_000n, "acc-x")]
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
    const rows = [transferTo(6_000n, A)]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(6_000n)
  })

  it("counts a transfer OUT of the account (destination is elsewhere) as negative", () => {
    const rows = [transferTo(6_000n, "acc-other")]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(-6_000n)
  })

  it("nets mixed movement from the account's side", () => {
    const rows = [
      income(10_000n),
      expense(1_000n),
      transferTo(3_000n, A), // +3,000 into A
      transferTo(2_000n, "acc-other"), // −2,000 out of A
    ]
    expect(dailyNet(rows, { kind: "account", accountId: A })).toBe(10_000n)
  })
})
