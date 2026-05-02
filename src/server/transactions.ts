import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { absMoney, encodeMoney, negateMoney, type Money } from "@/lib/money"
import { assertSplitParity } from "@/lib/split-parity"
// `import type` adalah TYPE-ONLY — di-erase compile time, tidak masuk runtime bundle.
// TanStack Start's import-protection plugin (analysis.js:44) MEN-SKIP semua
// `import type` dari analisis, jadi import ini TIDAK trigger warning meskipun
// nominally berasal dari runtime-server-only package.
import type { Prisma } from "@prisma/client"
// Runtime import dari `.server.ts` — splitter akan strip handler bodies yang
// memakai `prisma` di client bundle, lalu Rolldown tree-shakes import ini
// karena unused. Plus `db.server.ts` di-replace empty stub oleh plugin via
// pattern `**/*.server.*`. import-protection plugin tetap warn di sini karena
// dia analisis source level — itu EXPECTED dan SAFE. Lihat AGENTS.md §6.F.
import { prisma } from "./db.server"
import { familyMiddleware, createTenantDb } from "./middleware/with-family"

// Canonical Prisma type untuk callback `$transaction`. Lebih bersih dari
// `Parameters<Parameters<typeof prisma.$transaction>[0]>[0]` dan stable
// across Prisma upgrades.
type PrismaTxClient = Prisma.TransactionClient

/**
 * BACKEND FUNCTION: Fetch reference data for the Transaction Form Dropdowns
 * This function executes strictly on the Server (Node.js).
 */
export const getTransactionFormData = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    const db = createTenantDb(context.familyId)
    // ENTERPRISE TRICK: Use Promise.all() for parallel execution!
    // Fetching Accounts, Categories, and Merchants concurrently makes loading 3x faster.
    const [accounts, categories, merchants] = await Promise.all([
      db.account.findMany({ orderBy: { name: "asc" } }),
      // UNSAFE: system categories (isSystem=true, familyId=null) must remain readable;
      // after M1-5 RLS, the Category policy will expose them via OR clause.
      // For now, read all categories visible to this family.
      prisma.category.findMany({ orderBy: { name: "asc" } }),
      db.merchant.findMany({ orderBy: { name: "asc" } }),
    ])

    // Return the processed data to the Frontend
    return { accounts, categories, merchants }
  })

// =============================================================================
// MONEY INPUT SCHEMA (post-ADR-0001)
//
// Accepts three shapes for monetary fields:
//   1. `bigint` — native BigInt (used in server-internal calls + tests)
//   2. `string` of digits (with optional leading `-`) — the WIRE format that
//      clients send after Step 4d (BigInts can't be JSON-stringified, so
//      they cross the wire as strings).
//   3. `number` integer — transitional support for legacy form payloads;
//      MUST be already in minor units (sen, cents, satoshi). Non-integer
//      numbers are rejected so callers can't accidentally send display
//      values like `100.50`.
//
// All three coerce to `bigint` for downstream business logic.
// =============================================================================
const moneyInputSchema = z
  .union([
    z.bigint(),
    z
      .string()
      .regex(
        /^-?\d+$/,
        "money wire value must be a string of digits (e.g. '100050')"
      ),
    z
      .number()
      .int("legacy number money input must be an integer in minor units"),
  ])
  .transform((v) => (typeof v === "bigint" ? v : BigInt(v)))

const positiveMoneyInputSchema = moneyInputSchema.refine((b) => b > 0n, {
  message: "amount must be positive",
})

// =============================================================================
// WIRE SERIALIZATION HELPER
//
// Server-fn return values cross JSON. `JSON.stringify(10n)` throws, so every
// monetary bigint field is encoded as a digit-string at the boundary. The
// client revives them in the TanStack DB collection's `select` callback (see
// src/lib/collections.ts). This is the Stripe/Wise pattern — zero precision
// loss anywhere it matters.
//
// We keep `splitEntries` as a parallel array transformation so its `amount`
// field is also wire-encoded.
// =============================================================================
// CRITICAL: each conditional is wrapped in `[T]` to prevent TypeScript's
// distributive conditional behavior. Without the tuple wrapping, a field
// typed `Merchant | null` would distribute over the union and incorrectly
// match the `null` branch of `T extends bigint | null`, mapping the entire
// field to `string | Merchant` \u2014 a subtle bug that broke `merchant.name`
// access throughout the UI before this fix.
type SerializeMoney<T> = [T] extends [bigint]
  ? string
  : [T] extends [bigint | null]
    ? string | null
    : [T] extends [bigint | null | undefined]
      ? string | null | undefined
      : [T] extends [Array<infer U>]
        ? Array<{ [K in keyof U]: SerializeMoney<U[K]> }>
        : T

type Serialized<T> = { [K in keyof T]: SerializeMoney<T[K]> }

/**
 * Encode all bigint-money fields of a transaction-like object to digit-strings
 * so the result survives JSON serialization across the server-fn boundary.
 *
 * The generic mapped return type preserves every other field's type exactly,
 * which keeps `Awaited<ReturnType<typeof getTransactionsFn>>` useful for the
 * client without requiring duplicated DTO declarations.
 */
function serializeTransaction<
  T extends {
    amount: bigint
    destinationAmount?: bigint | null
    accountBalanceAfter?: bigint | null
    splitEntries?: Array<{ amount: bigint }>
  },
>(tx: T): Serialized<T> {
  const out: Record<string, unknown> = { ...tx }
  out.amount = encodeMoney(tx.amount)
  out.destinationAmount =
    tx.destinationAmount == null ? null : encodeMoney(tx.destinationAmount)
  out.accountBalanceAfter =
    tx.accountBalanceAfter == null ? null : encodeMoney(tx.accountBalanceAfter)
  if (tx.splitEntries) {
    out.splitEntries = tx.splitEntries.map((e) => ({
      ...e,
      amount: encodeMoney(e.amount),
    }))
  }
  return out as Serialized<T>
}

// Schema untuk setiap baris line item dalam split transaction
const splitEntrySchema = z.object({
  description: z.string().min(1),
  amount: positiveMoneyInputSchema,
  categoryId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
})

// 1. SERVER SECURITY CONTRACT (Zod Schema)
// Never trust data directly from the browser.
// We validate the payload shape at the Backend Gateway!
const transactionInputSchema = z.object({
  id: z.string().min(1).optional(), // ID pre-generated di client untuk sinkronisasi optimistic
  type: z.enum(["expense", "income", "transfer"]),
  amount: positiveMoneyInputSchema,
  description: z.string().min(1),
  accountId: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  toAccountId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
  date: z.coerce.date(),
  notes: z.string().nullable().optional(),
  currency: z.string().optional().default("IDR"),
  // Split Transaction Engine
  isSplit: z.boolean().optional().default(false),
  splitEntries: z.array(splitEntrySchema).optional(),
  // Enterprise: lifecycle status, multi-currency, dan attachment
  status: z
    .enum(["PENDING", "CLEARED", "RECONCILED"])
    .optional()
    .default("CLEARED"),
  destinationAmount: positiveMoneyInputSchema.nullable().optional(),
  destinationCurrency: z.string().nullable().optional(),
  attachmentUrl: z.string().nullable().optional(),
})

/**
 * BACKEND FUNCTION: Create Transaction & Update Balances (ACID Compliant)
 */
export const createTransactionFn = createServerFn({ method: "POST" })
  // 🚀 FIXED: Using inputValidator instead of validator for TanStack v1.132+
  .inputValidator((data: z.input<typeof transactionInputSchema>) =>
    transactionInputSchema.parse(data)
  )
  .middleware([familyMiddleware])
  .handler(async ({ data, context }) => {
    const { user, familyId } = context

    // 🚀 THE ENTERPRISE MAGIC: Prisma $transaction (ACID)
    // If any process inside this block fails, all changes are rolled back automatically.
    const result = await prisma.$transaction(async (tx: PrismaTxClient) => {
      // === SPLIT PARITY GUARD (GAAP Compliance) ===
      // Backend MUST validate that SplitEntries sum === parent.amount.
      // UI validation is a convenience; THIS is the authoritative check.
      // Throws inside `$transaction` → automatic rollback if violated.
      assertSplitParity(data)

      // A. HANDLE TRANSFER (DOUBLE-ENTRY)
      if (data.type === "transfer") {
        if (!data.toAccountId)
          throw new Error("Transfer requires a destination account!")

        const toAccount = await tx.account.findUnique({
          where: { id: data.toAccountId },
        })
        if (!toAccount) throw new Error("Destination account not found!")

        let kind = "funds_movement"
        if (toAccount.type === "CREDIT") kind = "cc_payment"
        else if (toAccount.type === "LOAN") kind = "loan_payment"

        // Running Balance Snapshot: baca saldo akun setelah update atomik
        const updatedSourceAccount = await tx.account.update({
          where: { id: data.accountId },
          data: { balance: { decrement: data.amount } },
          select: { balance: true },
        })
        const sourceBalanceAfter = updatedSourceAccount.balance

        // Multi-currency: gunakan destinationAmount jika tersedia, fallback ke amount
        const inAmount = data.destinationAmount ?? data.amount
        const inCurrency = data.destinationCurrency ?? data.currency

        const updatedDestAccount = await tx.account.update({
          where: { id: data.toAccountId },
          data: { balance: { increment: inAmount } },
          select: { balance: true },
        })
        const destBalanceAfter = updatedDestAccount.balance

        const outflowTx = await tx.transaction.create({
          data: {
            ...(data.id ? { id: data.id } : {}),
            type: "transfer",
            kind,
            currency: data.currency,
            amount: negateMoney(absMoney(data.amount)),
            description: data.description,
            date: data.date,
            notes: data.notes || null,
            accountId: data.accountId,
            toAccountId: data.toAccountId,
            categoryId: data.categoryId || null,
            merchantId: data.merchantId || null,
            userId: user.id,
            familyId,
            status: data.status,
            destinationAmount: data.destinationAmount,
            destinationCurrency: data.destinationCurrency,
            accountBalanceAfter: sourceBalanceAfter,
            attachmentUrl: data.attachmentUrl,
          },
        })

        const inflowTx = await tx.transaction.create({
          data: {
            type: "transfer",
            kind,
            currency: inCurrency,
            amount: absMoney(inAmount),
            description: data.description,
            date: data.date,
            notes: data.notes || null,
            accountId: data.toAccountId,
            toAccountId: data.accountId,
            categoryId: data.categoryId || null,
            merchantId: data.merchantId || null,
            userId: user.id,
            familyId,
            status: data.status,
            destinationAmount: data.destinationAmount,
            destinationCurrency: data.destinationCurrency,
            accountBalanceAfter: destBalanceAfter,
            attachmentUrl: data.attachmentUrl,
          },
        })

        await tx.transfer.create({
          data: {
            outflowTransactionId: outflowTx.id,
            inflowTransactionId: inflowTx.id,
          },
        })

        return serializeTransaction({
          ...outflowTx,
          amount: absMoney(outflowTx.amount),
        })
      }

      // B. HANDLE STANDARD EXPENSE / INCOME
      const amountSign: Money =
        data.type === "expense"
          ? negateMoney(absMoney(data.amount))
          : absMoney(data.amount)

      // Running Balance Snapshot: baca saldo setelah update atomik
      let accountBalanceAfter: bigint | null = null
      if (data.type === "expense") {
        const updated = await tx.account.update({
          where: { id: data.accountId },
          data: { balance: { decrement: data.amount } },
          select: { balance: true },
        })
        accountBalanceAfter = updated.balance
      } else {
        // type is "income" — only possibility after "expense" and "transfer" are handled
        const updated = await tx.account.update({
          where: { id: data.accountId },
          data: { balance: { increment: data.amount } },
          select: { balance: true },
        })
        accountBalanceAfter = updated.balance
      }

      const newTransaction = await tx.transaction.create({
        data: {
          ...(data.id ? { id: data.id } : {}),
          type: data.type,
          amount: amountSign,
          description: data.description,
          date: data.date,
          notes: data.notes || null,
          accountId: data.accountId,
          toAccountId: data.toAccountId || null,
          // Jika split aktif, categoryId di parent menjadi null (kategori hidup di entries)
          categoryId: data.isSplit ? null : data.categoryId || null,
          merchantId: data.isSplit ? null : data.merchantId || null,
          isSplit: data.isSplit,
          userId: user.id,
          familyId,
          status: data.status,
          accountBalanceAfter: accountBalanceAfter,
          attachmentUrl: data.attachmentUrl,
        },
      })

      // Jika isSplit, buat setiap line item satu-satu agar Prisma
      // auto-generate cuid() untuk id (createMany bypass @default di SQLite)
      if (data.isSplit && data.splitEntries?.length) {
        await Promise.all(
          data.splitEntries.map((entry) =>
            tx.splitEntry.create({
              data: {
                transactionId: newTransaction.id,
                description: entry.description,
                amount: absMoney(entry.amount),
                categoryId: entry.categoryId || null,
                merchantId: entry.merchantId || null,
              },
            })
          )
        )
      }

      return serializeTransaction({
        ...newTransaction,
        amount: absMoney(newTransaction.amount),
      })
    })

    return result
  })

/**
 * BACKEND FUNCTION: Fetch complete transaction ledger
 * Menerapkan Data Projection: Hanya mengambil field relasi yang dibutuhkan UI
 */
export const getTransactionsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    const db = createTenantDb(context.familyId)
    // Enterprise trick: Kita urutkan dari yang terbaru (descending)
    const transactions = await db.transaction.findMany({
      orderBy: { date: "desc" },
      where: {
        deletedAt: null, // SOFT DELETE FILTER: hanya ambil transaksi aktif
        // Gunakan objek eksplisit untuk mengecek ketiadaan relasi (Best Practice)
        transferIn: {
          is: null,
        },
      },
      // Menggunakan 'include' untuk menarik data relasi secara instan
      include: {
        account: {
          select: { name: true, type: true, color: true },
        },
        toAccount: {
          select: { name: true, type: true, color: true },
        },
        category: {
          // Hanya ambil nama, warna, dan icon untuk keperluan UI
          select: { name: true, color: true, icon: true },
        },
        merchant: {
          select: { name: true, logoUrl: true },
        },
        // Sertakan split entries beserta relasi kategori & merchant-nya
        splitEntries: {
          orderBy: { createdAt: "asc" },
          include: {
            category: {
              select: { name: true, color: true, icon: true },
            },
            merchant: { select: { name: true, logoUrl: true } },
          },
        },
      },
    })

    // The MAP logic: Ubah array yang didapat dari DB.
    // Amounts are stored signed (negative for expense) but the UI consumes
    // them as positive magnitudes; sign is communicated via `type`.
    // Wire-encode bigint → string at this boundary; client revives via
    // TanStack DB collection `select` callback (see src/lib/collections.ts).
    return transactions.map((tx) =>
      serializeTransaction({
        ...tx,
        amount: absMoney(tx.amount),
      })
    )
  })

// =========================================================================
// THE INVISIBLE LEDGER: SMART DELETE & UPDATE (ENTERPRISE ARCHITECTURE)
// =========================================================================

/**
 * BACKEND FUNCTION: Delete Transaction (Soft Delete — GAAP Compliance)
 * Transaksi tidak pernah benar-benar dihapus; hanya ditandai dengan deletedAt.
 */
export const deleteTransactionFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    return await prisma.$transaction(async (tx: PrismaTxClient) => {
      // 1. Cari transaksi lama beserta relasi transfernya
      const oldTx = await tx.transaction.findUnique({
        where: { id: data.id },
        include: { transferOut: true, transferIn: true },
      })

      if (!oldTx) throw new Error("Transaction not found!")

      // 2. REVERSE BALANCES (Kembalikan Saldo)
      if (oldTx.type === "transfer" && oldTx.transferOut) {
        // Jika ini Transfer, kita harus cari Inflow-nya juga
        const inflowTx = await tx.transaction.findUnique({
          where: {
            id: oldTx.transferOut.inflowTransactionId,
          },
        })

        // Refund akun pengirim (Outflow kan negatif, kita ubah jadi absolute lalu tambahkan)
        await tx.account.update({
          where: { id: oldTx.accountId },
          data: {
            balance: { increment: absMoney(oldTx.amount) },
          },
        })

        // Tarik kembali uang dari akun penerima
        if (inflowTx) {
          await tx.account.update({
            where: { id: inflowTx.accountId },
            data: {
              balance: {
                decrement: absMoney(inflowTx.amount),
              },
            },
          })
          // Soft delete: inflow transaction (TIDAK PERNAH hard delete — audit trail)
          await tx.transaction.update({
            where: { id: inflowTx.id },
            data: { deletedAt: new Date() },
          })
        }
      } else {
        // Reversal untuk Expense/Income biasa
        if (oldTx.type === "expense") {
          await tx.account.update({
            where: { id: oldTx.accountId },
            data: {
              balance: {
                increment: absMoney(oldTx.amount),
              },
            }, // Uang kembali
          })
        } else if (oldTx.type === "income") {
          await tx.account.update({
            where: { id: oldTx.accountId },
            data: {
              balance: {
                decrement: absMoney(oldTx.amount),
              },
            }, // Uang ditarik
          })
        }
      }

      // 3. Soft Delete Data Utama (GAAP: audit trail tetap ada)
      await tx.transaction.update({
        where: { id: oldTx.id },
        data: { deletedAt: new Date() },
      })

      return { success: true }
    })
  })

/**
 * BACKEND FUNCTION: Update Transaction (Reversal-and-Replace Pattern)
 * FASE 1 menggunakan hard delete (internal reversal, bukan user-facing delete).
 * FASE 2 membuat record baru dengan ID yang sama — continuity terjaga.
 */
export const updateTransactionFn = createServerFn({ method: "POST" })
  .inputValidator(transactionInputSchema)
  .middleware([familyMiddleware])
  .handler(async ({ data, context }) => {
    if (!data.id) throw new Error("ID is required for updating")
    const { user } = context

    // The Magic: Kita jalankan penghapusan murni dan pembuatan murni secara berurutan
    // dalam satu ACID Transaction. Zero Balance Mismatch Guaranteed!
    return await prisma.$transaction(async (tx: PrismaTxClient) => {
      // === SPLIT PARITY GUARD (GAAP Compliance) ===
      // Same authoritative invariant as createTransactionFn — UPDATE flow can
      // independently violate parity if a client tampers with split entries
      // without updating the parent amount (or vice versa). Re-validate here.
      assertSplitParity(data)

      // --- FASE 1: REVERSAL (HAPUS LAMA) ---
      // Kita "pinjam" logika delete untuk mengembalikan saldo ke 0
      const oldTx = await tx.transaction.findUnique({
        where: { id: data.id },
        include: { transferOut: true },
      })

      if (!oldTx) throw new Error("Original transaction not found")

      if (oldTx.type === "transfer" && oldTx.transferOut) {
        const inflowTx = await tx.transaction.findUnique({
          where: {
            id: oldTx.transferOut.inflowTransactionId,
          },
        })
        await tx.account.update({
          where: { id: oldTx.accountId },
          data: {
            balance: { increment: absMoney(oldTx.amount) },
          },
        })
        if (inflowTx) {
          await tx.account.update({
            where: { id: inflowTx.accountId },
            data: {
              balance: {
                decrement: absMoney(inflowTx.amount),
              },
            },
          })
          // INTERNAL REVERSAL: Hard delete OK — bukan user-facing delete
          await tx.transaction.delete({
            where: { id: inflowTx.id },
          })
        }
      } else {
        if (oldTx.type === "expense") {
          await tx.account.update({
            where: { id: oldTx.accountId },
            data: {
              balance: {
                increment: absMoney(oldTx.amount),
              },
            },
          })
        } else if (oldTx.type === "income") {
          await tx.account.update({
            where: { id: oldTx.accountId },
            data: {
              balance: {
                decrement: absMoney(oldTx.amount),
              },
            },
          })
        }
      }
      // Hapus data lama (Hard delete OK — ID akan dipertahankan via re-create)
      await tx.transaction.delete({ where: { id: oldTx.id } })

      // --- FASE 2: REPLACE (BUAT BARU DENGAN DATA UPDATE) ---
      if (data.type === "transfer") {
        let kind = "funds_movement"
        const toAccount = await tx.account.findUnique({
          where: { id: data.toAccountId! },
        })
        if (toAccount?.type === "CREDIT") kind = "cc_payment"
        else if (toAccount?.type === "LOAN") kind = "loan_payment"

        // Running Balance Snapshot: baca saldo akun setelah update atomik
        const updatedSourceAccount = await tx.account.update({
          where: { id: data.accountId },
          data: { balance: { decrement: data.amount } },
          select: { balance: true },
        })
        const sourceBalanceAfter = updatedSourceAccount.balance

        // Multi-currency: gunakan destinationAmount jika tersedia, fallback ke amount
        const inAmount = data.destinationAmount ?? data.amount
        const inCurrency = data.destinationCurrency ?? data.currency

        const updatedDestAccount = await tx.account.update({
          where: { id: data.toAccountId! },
          data: { balance: { increment: inAmount } },
          select: { balance: true },
        })
        const destBalanceAfter = updatedDestAccount.balance

        const outflowTx = await tx.transaction.create({
          data: {
            id: data.id, // KITA PERTAHANKAN ID LAMA AGAR UI TIDAK KACAU
            type: "transfer",
            kind,
            currency: data.currency,
            amount: negateMoney(absMoney(data.amount)),
            description: data.description,
            date: data.date,
            notes: data.notes || null,
            accountId: data.accountId,
            toAccountId: data.toAccountId,
            categoryId: data.categoryId || null,
            merchantId: data.merchantId || null,
            userId: user.id,
            familyId: context.familyId,
            status: data.status,
            destinationAmount: data.destinationAmount,
            destinationCurrency: data.destinationCurrency,
            accountBalanceAfter: sourceBalanceAfter,
            attachmentUrl: data.attachmentUrl,
          },
        })

        const inflowTx = await tx.transaction.create({
          data: {
            type: "transfer",
            kind,
            currency: inCurrency,
            amount: absMoney(inAmount),
            description: data.description,
            date: data.date,
            notes: data.notes || null,
            accountId: data.toAccountId!,
            toAccountId: data.accountId,
            categoryId: data.categoryId || null,
            merchantId: data.merchantId || null,
            userId: user.id,
            familyId: context.familyId,
            status: data.status,
            destinationAmount: data.destinationAmount,
            destinationCurrency: data.destinationCurrency,
            accountBalanceAfter: destBalanceAfter,
            attachmentUrl: data.attachmentUrl,
          },
        })

        await tx.transfer.create({
          data: {
            outflowTransactionId: outflowTx.id,
            inflowTransactionId: inflowTx.id,
          },
        })
        return serializeTransaction({
          ...outflowTx,
          amount: absMoney(outflowTx.amount),
        })
      } else {
        // Re-create Standard Expense/Income (dengan atau tanpa split)
        const amountSign: Money =
          data.type === "expense"
            ? negateMoney(absMoney(data.amount))
            : absMoney(data.amount)

        // Running Balance Snapshot: baca saldo setelah update atomik
        let accountBalanceAfter: bigint | null = null
        if (data.type === "expense") {
          const updated = await tx.account.update({
            where: { id: data.accountId },
            data: { balance: { decrement: data.amount } },
            select: { balance: true },
          })
          accountBalanceAfter = updated.balance
        } else {
          // type is "income" — only possibility after "expense" and "transfer" are handled
          const updated = await tx.account.update({
            where: { id: data.accountId },
            data: { balance: { increment: data.amount } },
            select: { balance: true },
          })
          accountBalanceAfter = updated.balance
        }

        const newTx = await tx.transaction.create({
          data: {
            id: data.id, // PERTAHANKAN ID LAMA
            type: data.type,
            amount: amountSign,
            description: data.description,
            date: data.date,
            notes: data.notes || null,
            accountId: data.accountId,
            toAccountId: data.toAccountId || null,
            // Jika split, kategori hidup di entries, bukan parent
            categoryId: data.isSplit ? null : data.categoryId || null,
            merchantId: data.isSplit ? null : data.merchantId || null,
            isSplit: data.isSplit,
            userId: user.id,
            familyId: context.familyId,
            status: data.status,
            accountBalanceAfter: accountBalanceAfter,
            attachmentUrl: data.attachmentUrl,
          },
        })

        // Recreate split entries satu-satu (parent lama sudah dihapus via CASCADE)
        // Menggunakan create() agar Prisma generate cuid() untuk id
        if (data.isSplit && data.splitEntries?.length) {
          await Promise.all(
            data.splitEntries.map((entry) =>
              tx.splitEntry.create({
                data: {
                  transactionId: newTx.id,
                  description: entry.description,
                  amount: absMoney(entry.amount),
                  categoryId: entry.categoryId || null,
                  merchantId: entry.merchantId || null,
                },
              })
            )
          )
        }

        return serializeTransaction({
          ...newTx,
          amount: absMoney(newTx.amount),
        })
      }
    })
  })

/**
 * BACKEND FUNCTION: Bulk Delete Transactions (Soft Delete — GAAP Compliance)
 */
export const bulkDeleteTransactionsFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ ids: z.array(z.string()) }))
  .handler(async ({ data }) => {
    if (data.ids.length === 0) return { success: true }

    return await prisma.$transaction(async (tx: PrismaTxClient) => {
      // 1. Ambil data asli untuk merestore saldo
      // (termasuk transfer out/inflow)
      const oldTxs = await tx.transaction.findMany({
        where: { id: { in: data.ids } },
        include: { transferOut: true },
      })

      const accountDeltas: Record<string, bigint> = {}

      const addDelta = (id: string, amount: bigint) => {
        if (!accountDeltas[id]) accountDeltas[id] = 0n
        accountDeltas[id] += amount
      }

      for (const oldTx of oldTxs) {
        if (oldTx.type === "transfer" && oldTx.transferOut) {
          const inflowTx = await tx.transaction.findUnique({
            where: {
              id: oldTx.transferOut.inflowTransactionId,
            },
          })
          addDelta(oldTx.accountId, absMoney(oldTx.amount))
          if (inflowTx) {
            addDelta(inflowTx.accountId, negateMoney(absMoney(inflowTx.amount)))
            // Soft delete: inflow transaction (TIDAK PERNAH hard delete — audit trail)
            await tx.transaction.update({
              where: { id: inflowTx.id },
              data: { deletedAt: new Date() },
            })
          }
        } else if (oldTx.type !== "transfer") {
          if (oldTx.type === "expense") {
            addDelta(oldTx.accountId, absMoney(oldTx.amount))
          } else if (oldTx.type === "income") {
            addDelta(oldTx.accountId, negateMoney(absMoney(oldTx.amount)))
          }
        }
      }

      // 2. Terapkan agregasi delta secara masal
      await Promise.all(
        Object.entries(accountDeltas).map(([accountId, delta]) =>
          tx.account.update({
            where: { id: accountId },
            data: { balance: { increment: delta } },
          })
        )
      )

      // 3. Soft delete: set deletedAt timestamp — TIDAK PERNAH hard delete
      await tx.transaction.updateMany({
        where: { id: { in: data.ids } },
        data: { deletedAt: new Date() },
      })

      return { success: true }
    })
  })

/**
 * BACKEND FUNCTION: Bulk Update Transactions
 * Securely handles Category, Merchant, and Account shifts while preserving double-entry ledger logic for account balance transfers.
 */
export const bulkUpdateTransactionsFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      ids: z.array(z.string()),
      categoryId: z.string().nullable().optional(),
      merchantId: z.string().nullable().optional(),
      accountId: z.string().optional(),
    })
  )
  .handler(async ({ data }) => {
    if (data.ids.length === 0) return { success: true }

    return await prisma.$transaction(async (tx: PrismaTxClient) => {
      // 1. Handle Account Change (Requires Balance Shifting)
      // We explicitly skip transfers for bulk account edits to prevent complex dual-leg logic breakage.
      if (data.accountId !== undefined) {
        const txsToMove = await tx.transaction.findMany({
          where: {
            id: { in: data.ids },
            type: { not: "transfer" },
            accountId: { not: data.accountId },
          },
        })

        const accountDeltas: Record<string, bigint> = {}
        const addDelta = (id: string, amount: bigint) => {
          if (!accountDeltas[id]) accountDeltas[id] = 0n
          accountDeltas[id] += amount
        }

        for (const t of txsToMove) {
          // Expense: Reverse old (+), Charge new (-)
          // Income: Reverse old (-), Charge new (+)
          const magnitude = absMoney(t.amount)
          const refundSigned: bigint =
            t.type === "expense" ? magnitude : negateMoney(magnitude)
          const chargeSigned: bigint =
            t.type === "expense" ? negateMoney(magnitude) : magnitude

          addDelta(t.accountId, refundSigned)
          addDelta(data.accountId, chargeSigned)
        }

        await Promise.all(
          Object.entries(accountDeltas).map(([accId, delta]) =>
            tx.account.update({
              where: { id: accId },
              data: { balance: { increment: delta } },
            })
          )
        )
      }

      // 2. Prepare scalar updates payload (typed — no `any`)
      type CategoryMerchantUpdate = {
        categoryId?: string | null
        merchantId?: string | null
      }
      type ParentUpdate = CategoryMerchantUpdate & {
        accountId?: string
      }

      const updates: CategoryMerchantUpdate = {}
      if (data.categoryId !== undefined) updates.categoryId = data.categoryId
      if (data.merchantId !== undefined) updates.merchantId = data.merchantId

      const parentUpdates: ParentUpdate = { ...updates }
      if (data.accountId !== undefined) parentUpdates.accountId = data.accountId

      // 3. Execute DB Modifications (Super-Fast Bulk Updates)
      if (Object.keys(parentUpdates).length > 0) {
        await tx.transaction.updateMany({
          // Categories only apply to non-split transactions!
          where: {
            id: { in: data.ids },
            ...(data.categoryId !== undefined || data.merchantId !== undefined
              ? { isSplit: false }
              : {}),
          },
          data: parentUpdates,
        })
      }

      const splitUpdates: CategoryMerchantUpdate = {}
      if (data.categoryId !== undefined)
        splitUpdates.categoryId = data.categoryId
      if (data.merchantId !== undefined)
        splitUpdates.merchantId = data.merchantId

      if (Object.keys(splitUpdates).length > 0) {
        await tx.splitEntry.updateMany({
          where: { transactionId: { in: data.ids } },
          data: splitUpdates,
        })
      }

      return { success: true }
    })
  })

// ===================================
// BULK CREATE ENGINES (CSV IMPORT)
// ===================================
const bulkTransactionInputSchema = z.object({
  transactions: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(["expense", "income"]), // CSV defaults to pure income/expense
      amount: positiveMoneyInputSchema,
      description: z.string().min(1),
      accountId: z.string().min(1),
      categoryId: z.string().nullable().optional(),
      merchantId: z.string().nullable().optional(),
      date: z.coerce.date(),
      notes: z.string().nullable().optional(),
      status: z
        .enum(["PENDING", "CLEARED", "RECONCILED"])
        .optional()
        .default("CLEARED"),
      attachmentUrl: z.string().nullable().optional(),
    })
  ),
})

export const bulkCreateTransactionsFn = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof bulkTransactionInputSchema>) =>
    bulkTransactionInputSchema.parse(data)
  )
  .middleware([familyMiddleware])
  .handler(async ({ data, context }) => {
    const { user, familyId } = context

    return await prisma.$transaction(async (tx: PrismaTxClient) => {
      // 1. Create all transactions
      await tx.transaction.createMany({
        data: data.transactions.map((t) => ({
          id: t.id,
          userId: user.id,
          familyId,
          type: t.type,
          amount:
            t.type === "expense"
              ? negateMoney(absMoney(t.amount))
              : absMoney(t.amount),
          description: t.description,
          accountId: t.accountId,
          categoryId: t.categoryId,
          merchantId: t.merchantId,
          date: t.date,
          notes: t.notes,
          status: t.status,
          attachmentUrl: t.attachmentUrl,
        })),
      })

      // 2. Adjust account balances
      const accountDeltas: Record<string, bigint> = {}
      for (const t of data.transactions) {
        if (!accountDeltas[t.accountId]) accountDeltas[t.accountId] = 0n
        accountDeltas[t.accountId] +=
          t.type === "expense"
            ? negateMoney(absMoney(t.amount))
            : absMoney(t.amount)
      }

      await Promise.all(
        Object.entries(accountDeltas).map(([accId, delta]) =>
          tx.account.update({
            where: { id: accId },
            data: { balance: { increment: delta } },
          })
        )
      )

      return { success: true, count: data.transactions.length }
    })
  })
