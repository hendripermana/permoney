/**
 * Transaction-list KPI totals — base-currency aggregation for the
 * `/transactions` route's headline cards (Total Income, Total Expenses, Net
 * Cash Flow).
 *
 * A transaction's `amount` is native-currency (per-transaction `currency`);
 * summing it raw across a multi-currency ledger adds incompatible units. The
 * correct total is each row's already-materialized base-currency projection
 * (`baseAmount`, ADR-0035) — the same field `budget-progress.ts` sums for
 * budget actuals. `computeBaseProjectionForAmount` (src/server/fx.ts)
 * guarantees `baseAmount` is set via an identity projection whenever
 * `currency === baseCurrency`; it is null ONLY when the row is genuinely
 * FX-pending (no rate snapshot resolved yet) for a real cross-currency
 * transaction. Pending rows are excluded from the total, never fabricated
 * into it — mirroring `budget-progress.ts`'s handling of the same field.
 */

import { absMoney, decodeMoney, ZERO_MONEY, type Money } from "./money"

export interface TransactionKpiRowInput {
  type: string
  /** Native-currency magnitude (already a positive `Money`, per getTransactionsFn's wire shape). */
  amount: Money
  /** Wire-encoded signed base-currency projection; null when FX-pending. */
  baseAmount: string | null
}

export interface TransactionKpiTotals {
  totalIncome: Money
  totalExpenses: Money
  netCashFlow: Money
}

/**
 * Base-currency KPI totals for a filtered transaction set. Only `"income"`
 * and `"expense"` rows contribute, matching the existing card semantics.
 */
export function computeTransactionKpiTotals(
  transactions: ReadonlyArray<TransactionKpiRowInput>
): TransactionKpiTotals {
  let totalIncome: Money = ZERO_MONEY
  let totalExpenses: Money = ZERO_MONEY

  for (const t of transactions) {
    if (t.type !== "income" && t.type !== "expense") continue
    // FX-pending: no resolved base-currency projection yet — exclude rather
    // than mixing units or fabricating a number.
    if (t.baseAmount === null) continue

    const baseMagnitude = absMoney(decodeMoney(t.baseAmount))
    if (t.type === "income") {
      totalIncome = (totalIncome + baseMagnitude) as Money
    } else {
      totalExpenses = (totalExpenses + baseMagnitude) as Money
    }
  }

  return {
    totalIncome,
    totalExpenses,
    netCashFlow: (totalIncome - totalExpenses) as Money,
  }
}
