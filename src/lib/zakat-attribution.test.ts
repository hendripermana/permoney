import { describe, expect, test } from "vite-plus/test"
import {
  attributeAmountToPayer,
  classifyZakatAccount,
  estimateNextLoanInstallment,
  isZakatUnattributed,
  type ZakatAccountRef,
} from "./zakat-attribution"
import { type AnalyticsTxn } from "./account-analytics"

function account(overrides: Partial<ZakatAccountRef> = {}): ZakatAccountRef {
  return {
    id: "acc-1",
    name: "Test account",
    accountClass: "ASSET",
    accountType: "DEPOSITORY",
    balance: 0n,
    zakatPayerId: null,
    zakatJointPayerId: null,
    zakatJointSharePercent: null,
    ...overrides,
  }
}

describe("classifyZakatAccount", () => {
  test.each([
    ["CASH", "ASSET", "cash_asset"],
    ["DEPOSITORY", "ASSET", "cash_asset"],
    ["E_WALLET", "ASSET", "cash_asset"],
    ["RECEIVABLE", "ASSET", "receivable_asset"],
    ["CREDIT", "LIABILITY", "credit_debt"],
    ["LOAN", "LIABILITY", "loan_debt"],
    ["INVESTMENT", "ASSET", "out_of_scope"],
    ["TRACKED_ASSET", "ASSET", "out_of_scope"],
  ] as const)(
    "%s (%s) classifies as %s",
    (accountType, accountClass, expected) => {
      expect(classifyZakatAccount({ accountClass, accountType })).toBe(expected)
    }
  )
})

describe("isZakatUnattributed", () => {
  test("true when zakatPayerId is null", () => {
    expect(isZakatUnattributed(account({ zakatPayerId: null }))).toBe(true)
  })
  test("false once tagged", () => {
    expect(isZakatUnattributed(account({ zakatPayerId: "p1" }))).toBe(false)
  })
})

describe("attributeAmountToPayer", () => {
  test("single-payer mode: 100% regardless of tags", () => {
    const acc = account({ zakatPayerId: null })
    expect(attributeAmountToPayer(acc, { id: "p1" }, 100_000n, true)).toBe(
      100_000n
    )
  })

  test("sole owner (no joint co-owner): 100% to the tagged payer", () => {
    const acc = account({ zakatPayerId: "p1" })
    expect(attributeAmountToPayer(acc, { id: "p1" }, 100_000n, false)).toBe(
      100_000n
    )
  })

  test("untagged account: 0% to every payer in multi-payer mode", () => {
    const acc = account({ zakatPayerId: null })
    expect(attributeAmountToPayer(acc, { id: "p1" }, 100_000n, false)).toBe(0n)
  })

  test("account tagged to a DIFFERENT payer: 0% to this payer", () => {
    const acc = account({ zakatPayerId: "p2" })
    expect(attributeAmountToPayer(acc, { id: "p1" }, 100_000n, false)).toBe(0n)
  })

  test("joint 50:50 split — primary keeps the remainder, joint gets the share", () => {
    const acc = account({
      zakatPayerId: "p1",
      zakatJointPayerId: "p2",
      zakatJointSharePercent: 50,
    })
    expect(attributeAmountToPayer(acc, { id: "p1" }, 100_000n, false)).toBe(
      50_000n
    )
    expect(attributeAmountToPayer(acc, { id: "p2" }, 100_000n, false)).toBe(
      50_000n
    )
  })

  test("joint 70:30 split — non-default ratio respected exactly", () => {
    const acc = account({
      zakatPayerId: "p1",
      zakatJointPayerId: "p2",
      zakatJointSharePercent: 30,
    })
    expect(attributeAmountToPayer(acc, { id: "p1" }, 100_000n, false)).toBe(
      70_000n
    )
    expect(attributeAmountToPayer(acc, { id: "p2" }, 100_000n, false)).toBe(
      30_000n
    )
  })

  test("joint split on an odd amount is exact bigint math, no float drift", () => {
    const acc = account({
      zakatPayerId: "p1",
      zakatJointPayerId: "p2",
      zakatJointSharePercent: 30,
    })
    // 101 * 30 / 100 = 30.3 -> rounds to 30 (round-half-even, well below half)
    expect(attributeAmountToPayer(acc, { id: "p2" }, 101n, false)).toBe(30n)
    // 101 * 70 / 100 = 70.7 -> rounds to 71
    expect(attributeAmountToPayer(acc, { id: "p1" }, 101n, false)).toBe(71n)
  })

  test("a third, uninvolved payer gets 0% of a jointly-held account", () => {
    const acc = account({
      zakatPayerId: "p1",
      zakatJointPayerId: "p2",
      zakatJointSharePercent: 50,
    })
    expect(attributeAmountToPayer(acc, { id: "p3" }, 100_000n, false)).toBe(0n)
  })
})

function loanTxn(overrides: Partial<AnalyticsTxn>): AnalyticsTxn {
  return {
    date: new Date("2026-01-01T00:00:00.000Z"),
    amount: 1_000_000n,
    type: "transfer",
    kind: "loan_payment",
    accountId: "cash-1",
    toAccountId: "loan-1",
    ...overrides,
  }
}

describe("estimateNextLoanInstallment", () => {
  test("returns determined:false with 0 for too few payments", () => {
    const txns = [
      loanTxn({ date: new Date("2026-01-15T00:00:00.000Z") }),
      loanTxn({ date: new Date("2026-02-15T00:00:00.000Z") }),
    ]
    const result = estimateNextLoanInstallment(
      txns,
      "loan-1",
      new Date("2026-03-01T00:00:00.000Z")
    )
    expect(result.determined).toBe(false)
    expect(result.amountMinor).toBe(0n)
  })

  test("detects a stable monthly cadence and returns the typical amount, not the full principal", () => {
    const txns = Array.from({ length: 24 }, (_, i) =>
      loanTxn({
        date: new Date(Date.UTC(2024, i, 15)),
        amount: 5_000_000n,
      })
    )
    const result = estimateNextLoanInstallment(
      txns,
      "loan-1",
      new Date("2026-01-20T00:00:00.000Z")
    )
    expect(result.determined).toBe(true)
    expect(result.amountMinor).toBe(5_000_000n)
    // Nowhere near a multi-year principal (24 * 5,000,000 = 120,000,000).
    expect(result.amountMinor).toBeLessThan(120_000_000n)
  })

  test("ignores loan_payment rows belonging to a DIFFERENT loan account", () => {
    const txns = Array.from({ length: 5 }, (_, i) =>
      loanTxn({
        date: new Date(Date.UTC(2024, i, 15)),
        toAccountId: "some-other-loan",
      })
    )
    const result = estimateNextLoanInstallment(txns, "loan-1")
    expect(result.determined).toBe(false)
  })

  test("varying real-world payment descriptions don't fragment the series", () => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May"]
    const txns = months.map((label, i) =>
      loanTxn({
        date: new Date(Date.UTC(2024, i, 10)),
        amount: 2_000_000n,
        description: `Cicilan KPR ${label}`,
      } as AnalyticsTxn & { description: string })
    )
    const result = estimateNextLoanInstallment(
      txns,
      "loan-1",
      new Date(Date.UTC(2024, 5, 20))
    )
    expect(result.determined).toBe(true)
    expect(result.amountMinor).toBe(2_000_000n)
  })
})
