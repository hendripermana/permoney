import { describe, expect, test } from "vite-plus/test"
import { encodeMoney, toMoney } from "./money"
import {
  computeTransactionKpiTotals,
  type TransactionKpiRowInput,
} from "./transaction-kpi"

function row(
  type: string,
  amount: bigint,
  baseAmount: bigint | null
): TransactionKpiRowInput {
  return {
    type,
    amount: toMoney(amount),
    baseAmount: baseAmount === null ? null : encodeMoney(baseAmount),
  }
}

describe("computeTransactionKpiTotals", () => {
  test("all transactions in the base currency — matches summing raw amount directly (regression guard)", () => {
    const totals = computeTransactionKpiTotals([
      row("income", 500_000n, 500_000n),
      row("expense", 120_000n, -120_000n),
      row("expense", 30_000n, -30_000n),
    ])

    expect(totals.totalIncome).toBe(toMoney(500_000n))
    expect(totals.totalExpenses).toBe(toMoney(150_000n))
    expect(totals.netCashFlow).toBe(toMoney(350_000n))
  })

  test("mixes base-currency and non-base-currency rows using baseAmount, not raw amount", () => {
    // A USD 100 expense whose base (IDR) projection is Rp 1,600,000 — using
    // raw `amount` here would wrongly sum "100" IDR-labeled instead of the
    // converted 1,600,000.
    const totals = computeTransactionKpiTotals([
      row("income", 1_000_000n, 1_000_000n),
      row("expense", 100n, -1_600_000n),
    ])

    expect(totals.totalIncome).toBe(toMoney(1_000_000n))
    expect(totals.totalExpenses).toBe(toMoney(1_600_000n))
    expect(totals.netCashFlow).toBe(toMoney(-600_000n))
  })

  test("an FX-pending row (baseAmount null) is excluded from the total, not fabricated (matches budget-progress.ts)", () => {
    const totals = computeTransactionKpiTotals([
      row("income", 1_000_000n, 1_000_000n),
      // Cross-currency expense with no resolved FX rate snapshot yet.
      row("expense", 50n, null),
    ])

    expect(totals.totalIncome).toBe(toMoney(1_000_000n))
    expect(totals.totalExpenses).toBe(toMoney(0n))
    expect(totals.netCashFlow).toBe(toMoney(1_000_000n))
  })

  test("ignores non-income/expense rows (e.g. transfer legs) entirely", () => {
    const totals = computeTransactionKpiTotals([
      row("income", 1_000_000n, 1_000_000n),
      row("transfer", 200_000n, -200_000n),
    ])

    expect(totals.totalIncome).toBe(toMoney(1_000_000n))
    expect(totals.totalExpenses).toBe(toMoney(0n))
  })
})
