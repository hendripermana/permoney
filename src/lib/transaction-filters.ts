// src/lib/transaction-filters.ts
// Pure filter functions dan Zod schema untuk URL-driven state

import { startOfDay, startOfMonth, startOfYear, subDays } from "date-fns"
import { z } from "zod"
import { fallback } from "@tanstack/zod-adapter"

// === ZOD SCHEMA UNTUK URL SEARCH PARAMS ===
// TanStack Router akan validasi URL secara otomatis menggunakan schema ini.
// Setiap field punya fallback agar URL yang rusak/kosong tidak crash.

export const transactionSearchSchema = z.object({
  // Preset periode waktu
  period: fallback(
    z.enum(["1D", "7D", "MTD", "30D", "90D", "YTD", "ALL"]),
    "ALL"
  ).default("ALL"),

  // Filter tipe transaksi (multi-select)
  type: z.array(z.enum(["expense", "income", "transfer"])).optional(),

  // Filter berdasarkan ID akun (multi-select)
  accounts: z.array(z.string()).optional(),

  // Filter berdasarkan ID kategori (multi-select)
  categories: z.array(z.string()).optional(),

  // Filter berdasarkan ID merchant (multi-select)
  merchants: z.array(z.string()).optional(),

  // Filter berdasarkan status transaksi (PENDING, CLEARED, RECONCILED)
  status: z.array(z.enum(["PENDING", "CLEARED", "RECONCILED"])).optional(),

  // Range jumlah (min/max)
  amountMin: z.number().optional(),
  amountMax: z.number().optional(),

  // Search query (debounced dari search bar)
  q: fallback(z.string(), "").default(""),

  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
})

// PENTING: Di fungsi applyFilters() di file yang sama, pastikan logika
// penyaringan datanya juga diperbarui untuk membaca dateFrom dan dateTo
// jika mereka memiliki nilai (tidak undefined).

// Tipe TypeScript diturunkan otomatis dari Zod schema
export type TransactionFilters = z.infer<typeof transactionSearchSchema>

// === TIPE UNTUK RECORD TRANSAKSI ===
// Interface minimal agar filter function bisa dipakai tanpa import Prisma

export interface FilterableTransaction {
  id: string
  type: string
  // ADR-0001: amount is now a Money (bigint minor units) rather than Float.
  // Filter functions never need the value, only the field's existence/sign,
  // so widening to `number | bigint` here keeps both bigint records (live
  // collection) and any legacy number-typed mocks compatible.
  amount: number | bigint
  date: Date | string
  description: string
  accountId: string
  categoryId: string | null
  merchantId: string | null
  notes: string | null
  status: string
  merchant: { name: string } | null
}

// === DATE CUTOFF HELPER ===
// Menghitung tanggal mulai berdasarkan preset periode

export function getDateCutoff(period: string): Date {
  const now = new Date()
  switch (period) {
    case "1D":
      return startOfDay(now)
    case "7D":
      return subDays(now, 7)
    case "MTD":
      // Tanggal 1 bulan berjalan
      return startOfMonth(now)
    case "30D":
      return subDays(now, 30)
    case "90D":
      return subDays(now, 90)
    case "YTD":
      // 1 Januari tahun berjalan
      return startOfYear(now)
    default:
      // "ALL" — dari epoch (semua data)
      return new Date(0)
  }
}

// === FILTER PIPELINE ===
// Fungsi murni: input masuk, output keluar, tanpa side effect

export function applyFilters<T extends FilterableTransaction>(
  transactions: Array<T>,
  filters: TransactionFilters
): Array<T> {
  let result = transactions

  // 1. Filter berdasarkan Waktu (Custom Date Range vs Preset Period)
  if (filters.dateFrom || filters.dateTo) {
    // --- MODE CUSTOM DATE (Kalender Aktif) ---
    if (filters.dateFrom) {
      // Set jam ke 00:00:00 agar mencakup transaksi sejak dini hari
      const fromDate = new Date(filters.dateFrom).setHours(0, 0, 0, 0)
      result = result.filter((t) => new Date(t.date).getTime() >= fromDate)
    }

    if (filters.dateTo) {
      // Set jam ke 23:59:59 agar mencakup transaksi hingga ujung malam
      const toDate = new Date(filters.dateTo).setHours(23, 59, 59, 999)
      result = result.filter((t) => new Date(t.date).getTime() <= toDate)
    }
  } else if (filters.period && filters.period !== "ALL") {
    // --- MODE PRESET (Misal: 7D, 30D, YTD) ---
    // Hanya berjalan jika kalender custom tidak digunakan
    const cutoff = getDateCutoff(filters.period)
    result = result.filter((t) => new Date(t.date) >= cutoff)
  }

  // 2. Filter berdasarkan tipe (expense/income/transfer)
  if (filters.type?.length) {
    result = result.filter((t) =>
      filters.type!.includes(t.type as "expense" | "income" | "transfer")
    )
  }

  // 3. Filter berdasarkan akun
  if (filters.accounts?.length) {
    result = result.filter((t) => filters.accounts!.includes(t.accountId))
  }

  // 4. Filter berdasarkan kategori
  if (filters.categories?.length) {
    result = result.filter(
      (t) => t.categoryId && filters.categories!.includes(t.categoryId)
    )
  }

  // 5. Filter berdasarkan merchant
  if (filters.merchants?.length) {
    result = result.filter(
      (t) => t.merchantId && filters.merchants!.includes(t.merchantId)
    )
  }

  // 6. Filter berdasarkan range jumlah
  if (filters.amountMin != null) {
    result = result.filter((t) => t.amount >= filters.amountMin!)
  }
  if (filters.amountMax != null) {
    result = result.filter((t) => t.amount <= filters.amountMax!)
  }

  // 7. Filter berdasarkan status (PENDING/CLEARED/RECONCILED)
  if (filters.status?.length) {
    result = result.filter((t) =>
      filters.status!.includes(t.status as "PENDING" | "CLEARED" | "RECONCILED")
    )
  }

  return result
}
// === SEARCH FUNCTION ===
// Mencari di description, merchant name, dan notes (case-insensitive)

export function applySearch<T extends FilterableTransaction>(
  transactions: Array<T>,
  query: string
): Array<T> {
  const q = query.toLowerCase().trim()
  if (!q) return transactions

  return transactions.filter(
    (t) =>
      t.description.toLowerCase().includes(q) ||
      t.merchant?.name.toLowerCase().includes(q) ||
      t.notes?.toLowerCase().includes(q)
  )
}
