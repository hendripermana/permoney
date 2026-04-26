// src/lib/currency.ts
// Utilitas mata uang menggunakan Intl API browser — future-proof untuk 150+ currency

import { decodeMoney, formatMoney, type Money } from "./money"
import { CURRENCIES, type CurrencyCode } from "./data/currencies"

/**
 * Mengekstrak simbol mata uang dari kode ISO.
 * Contoh: "IDR" → "Rp", "USD" → "$", "JPY" → "¥", "EUR" → "€"
 * Menggunakan `narrowSymbol` agar simbol selalu pendek ($ bukan US$).
 */
export function getCurrencySymbol(currencyCode: string): string {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? currencyCode
    )
  } catch {
    // Fallback jika kode currency tidak dikenali browser
    return currencyCode
  }
}

/**
 * Format angka menjadi string mata uang yang bersih.
 *
 * Accepts THREE input shapes:
 *
 *   - `bigint` (Money minor units, post-ADR-0001): the canonical case.
 *     Delegates to `formatMoney` for currency-aware grouping & decimals.
 *
 *   - `string` (wire-format Money digits): decoded via `decodeMoney`, then
 *     formatted as bigint. Lets server-fn return values flow straight
 *     into JSX without manual revival.
 *
 *   - `number` (LEGACY decimal): preserved for callers that haven't yet
 *     been migrated (CSV import preview, etc.). Treated as a major-unit
 *     decimal and formatted via Intl.NumberFormat directly.
 *
 * Examples:
 *   formatCurrency(1_500_000_000n, "IDR") → "Rp 15,000,000.00"
 *   formatCurrency("1500000000",    "IDR") → "Rp 15,000,000.00"
 *   formatCurrency(15000000,        "IDR") → "Rp 15,000,000.00"  // legacy
 */
export function formatCurrency(
  amount: number | bigint | string,
  currencyCode: string = "IDR"
): string {
  if (typeof amount === "bigint" || typeof amount === "string") {
    const money: Money =
      typeof amount === "bigint" ? (amount as Money) : decodeMoney(amount)
    const code = currencyCode as CurrencyCode
    if (CURRENCIES[code]) return formatMoney(money, code)
    // Unknown ISO code: fall back to a manual stringify so we never throw
    // on a brand-new currency added to the DB before the registry is rebuilt.
    return `${currencyCode} ${money.toString()}`
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(amount)
}
