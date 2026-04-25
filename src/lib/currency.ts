// src/lib/currency.ts
// Utilitas mata uang menggunakan Intl API browser — future-proof untuk 150+ currency

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
 * Contoh: formatCurrency(15000000, "IDR") → "Rp 15,000,000"
 */
export function formatCurrency(
  amount: number,
  currencyCode: string = "IDR"
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(amount)
}
