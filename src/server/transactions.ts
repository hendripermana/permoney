import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { absMoney, encodeMoney, negateMoney, type Money } from "@/lib/money"
import { assertSplitParity } from "@/lib/split-parity"
import {
  familyMiddleware,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { auditLog, createAuditContext } from "./middleware/audit"

/**
 * BACKEND FUNCTION: Fetch reference data for the Transaction Form Dropdowns
 * This function executes strictly on the Server (Node.js).
 */
export const getTransactionFormData = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return scopedTenantTransaction(context.familyId, async (tx) => {
      const [accounts, categories, merchants] = await Promise.all([
        tx.account.findMany({
          where: { familyId: context.familyId },
          orderBy: { name: "asc" },
        }),
        tx.category.findMany({
          where: {
            OR: [{ isSystem: true }, { familyId: context.familyId }],
          },
          orderBy: { name: "asc" },
        }),
        tx.merchant.findMany({
          where: { familyId: context.familyId },
          orderBy: { name: "asc" },
        }),
      ])
      return { accounts, categories, merchants }
    })
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

const uuidV7Schema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "idempotencyKey must be a UUIDv7"
  )
  .transform((value) => value.toLowerCase())

const createTransactionTransportInputSchema = transactionInputSchema.extend({
  idempotencyKey: uuidV7Schema.optional(),
})

const createTransactionInputSchema =
  createTransactionTransportInputSchema.required({
    idempotencyKey: true,
  })

type CreateTransactionInput = z.infer<typeof createTransactionInputSchema>
type RunInTenantTransaction = <T>(
  familyId: string,
  callback: (tx: TenantTransactionClient) => Promise<T>
) => Promise<T>

interface CreateTransactionForFamilyArgs {
  data: unknown
  familyId: string
  runInTenantTransaction?: RunInTenantTransaction
  user: { id: string }
}

export class IdempotencyConflictError extends Error {
  statusCode = 409

  constructor(message = "Idempotency key reused with a different payload") {
    super(message)
    this.name = "IdempotencyConflictError"
  }
}

interface PersistedSplitEntryForIdempotency {
  amount: bigint
  categoryId: string | null
  description: string
  merchantId: string | null
}

interface PersistedTransferOutForIdempotency {
  inflowTransaction: {
    accountId: string
    amount: bigint
    categoryId: string | null
    currency: string
    date: Date
    description: string
    destinationAmount: bigint | null
    destinationCurrency: string | null
    merchantId: string | null
    notes: string | null
    status: string
    toAccountId: string | null
    type: string
  } | null
}

interface PersistedTransactionForIdempotency {
  accountBalanceAfter: bigint | null
  accountId: string
  amount: bigint
  attachmentUrl: string | null
  categoryId: string | null
  createdAt: Date
  currency: string
  date: Date
  deletedAt: Date | null
  description: string
  destinationAmount: bigint | null
  destinationCurrency: string | null
  excluded: boolean
  familyId: string
  id: string
  idempotencyKey: string | null
  isSplit: boolean
  kind: string
  merchantId: string | null
  notes: string | null
  splitEntries: PersistedSplitEntryForIdempotency[]
  status: string
  toAccountId: string | null
  transferIn: unknown
  transferOut: PersistedTransferOutForIdempotency | null
  type: string
  updatedAt: Date
  userId: string
}

function canonicalMoney(value: bigint | null | undefined): string | null {
  return value == null ? null : encodeMoney(absMoney(value))
}

function canonicalSplitEntries(
  entries: Array<{
    amount: bigint
    categoryId?: string | null
    description: string
    merchantId?: string | null
  }>
) {
  return entries.map((entry) => ({
    amount: encodeMoney(absMoney(entry.amount)),
    categoryId: entry.categoryId ?? null,
    description: entry.description,
    merchantId: entry.merchantId ?? null,
  }))
}

function canonicalRequestPayload(data: CreateTransactionInput) {
  return {
    accountId: data.accountId,
    amount: encodeMoney(absMoney(data.amount)),
    attachmentUrl: data.attachmentUrl ?? null,
    categoryId: data.isSplit ? null : (data.categoryId ?? null),
    currency: data.currency,
    date: data.date.toISOString(),
    description: data.description,
    destinationAmount: canonicalMoney(data.destinationAmount),
    destinationCurrency: data.destinationCurrency ?? null,
    isSplit: data.isSplit,
    merchantId: data.isSplit ? null : (data.merchantId ?? null),
    notes: data.notes ?? null,
    splitEntries: data.isSplit
      ? canonicalSplitEntries(data.splitEntries ?? [])
      : [],
    status: data.status,
    toAccountId: data.toAccountId ?? null,
    transferPartner:
      data.type === "transfer"
        ? {
            accountId: data.toAccountId ?? null,
            amount: encodeMoney(
              absMoney(data.destinationAmount ?? data.amount)
            ),
            categoryId: data.categoryId ?? null,
            currency: data.destinationCurrency ?? data.currency,
            date: data.date.toISOString(),
            description: data.description,
            destinationAmount: canonicalMoney(data.destinationAmount),
            destinationCurrency: data.destinationCurrency ?? null,
            merchantId: data.merchantId ?? null,
            notes: data.notes ?? null,
            status: data.status,
            toAccountId: data.accountId,
            type: "transfer",
          }
        : null,
    type: data.type,
  }
}

function canonicalPersistedPayload(tx: PersistedTransactionForIdempotency) {
  const transferPartner = tx.transferOut?.inflowTransaction ?? null

  return {
    accountId: tx.accountId,
    amount: encodeMoney(absMoney(tx.amount)),
    attachmentUrl: tx.attachmentUrl,
    categoryId: tx.isSplit ? null : tx.categoryId,
    currency: tx.currency,
    date: tx.date.toISOString(),
    description: tx.description,
    destinationAmount: canonicalMoney(tx.destinationAmount),
    destinationCurrency: tx.destinationCurrency,
    isSplit: tx.isSplit,
    merchantId: tx.isSplit ? null : tx.merchantId,
    notes: tx.notes,
    splitEntries: tx.isSplit ? canonicalSplitEntries(tx.splitEntries) : [],
    status: tx.status,
    toAccountId: tx.toAccountId,
    transferPartner:
      tx.type === "transfer"
        ? transferPartner && {
            accountId: transferPartner.accountId,
            amount: encodeMoney(absMoney(transferPartner.amount)),
            categoryId: transferPartner.categoryId,
            currency: transferPartner.currency,
            date: transferPartner.date.toISOString(),
            description: transferPartner.description,
            destinationAmount: canonicalMoney(
              transferPartner.destinationAmount
            ),
            destinationCurrency: transferPartner.destinationCurrency,
            merchantId: transferPartner.merchantId,
            notes: transferPartner.notes,
            status: transferPartner.status,
            toAccountId: transferPartner.toAccountId,
            type: transferPartner.type,
          }
        : null,
    type: tx.type,
  }
}

function assertIdempotentPayloadMatches(
  data: CreateTransactionInput,
  existing: PersistedTransactionForIdempotency
): void {
  if (
    JSON.stringify(canonicalRequestPayload(data)) !==
    JSON.stringify(canonicalPersistedPayload(existing))
  ) {
    throw new IdempotencyConflictError()
  }
}

async function findIdempotentTransaction(
  tx: TenantTransactionClient,
  familyId: string,
  idempotencyKey: string
): Promise<PersistedTransactionForIdempotency | null> {
  return await tx.transaction.findUnique({
    where: {
      tx_family_idempotency: {
        familyId,
        idempotencyKey,
      },
    },
    include: {
      splitEntries: {
        orderBy: { createdAt: "asc" },
      },
      transferIn: true,
      transferOut: {
        include: {
          inflowTransaction: true,
        },
      },
    },
  })
}

function serializePersistedReplay(tx: PersistedTransactionForIdempotency) {
  const {
    splitEntries: _splitEntries,
    transferIn: _transferIn,
    transferOut: _transferOut,
    ...transaction
  } = tx

  return serializeTransaction({
    ...transaction,
    amount: absMoney(transaction.amount),
  })
}

async function replayIdempotentTransaction(
  tx: TenantTransactionClient,
  familyId: string,
  data: CreateTransactionInput
) {
  const existing = await findIdempotentTransaction(
    tx,
    familyId,
    data.idempotencyKey
  )
  if (!existing) return null

  assertIdempotentPayloadMatches(data, existing)
  return serializePersistedReplay(existing)
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false
  }

  const code = (error as { code?: unknown }).code
  return code === "P2002"
}

async function readIdempotencyHeader(): Promise<string | null> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server")
    return getRequest().headers.get("Idempotency-Key")
  } catch {
    return null
  }
}

async function normalizeCreateTransactionTransportInput(
  data: z.infer<typeof createTransactionTransportInputSchema>
): Promise<CreateTransactionInput> {
  const rawHeaderKey = await readIdempotencyHeader()
  const headerKey =
    rawHeaderKey == null ? null : uuidV7Schema.parse(rawHeaderKey)
  if (headerKey && data.idempotencyKey && headerKey !== data.idempotencyKey) {
    throw new Error("Idempotency-Key header does not match idempotencyKey")
  }

  // Normalisasi data dengan menyertakan idempotencyKey dari header jika ada
  return createTransactionInputSchema.parse({
    ...data,
    idempotencyKey: headerKey ?? data.idempotencyKey,
  })
}

export async function createTransactionForFamily({
  data: rawData,
  familyId,
  runInTenantTransaction = scopedTenantTransaction,
  user,
}: CreateTransactionForFamilyArgs) {
  const data = createTransactionInputSchema.parse(rawData)

  const createOrReplay = async () =>
    await runInTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay = await replayIdempotentTransaction(tx, familyId, data)
        if (replay) return replay

        // === SPLIT PARITY GUARD (GAAP Compliance) ===
        // Backend MUST validate that SplitEntries sum === parent.amount.
        // UI validation is a convenience; THIS is the authoritative check.
        // Throws inside `$transaction` → automatic rollback if violated.
        assertSplitParity(data)

        // A. HANDLE TRANSFER (DOUBLE-ENTRY)
        if (data.type === "transfer") {
          if (!data.toAccountId)
            throw new Error("Transfer requires a destination account!")

          // Tenant-safe: verify account ownership via familyId
          const toAccount = await tx.account.findFirst({
            where: { id: data.toAccountId, familyId },
          })
          if (!toAccount)
            throw new Error("Destination account not found or access denied!")

          let kind = "funds_movement"
          if (toAccount.type === "CREDIT") kind = "cc_payment"
          else if (toAccount.type === "LOAN") kind = "loan_payment"

          const [oldSrcAcc, oldDstAcc] = await Promise.all([
            tx.account.findUniqueOrThrow({ where: { id: data.accountId } }),
            tx.account.findUniqueOrThrow({ where: { id: data.toAccountId } }),
          ])

          // Running Balance Snapshot: baca saldo akun setelah update atomik
          // Tenant-safe: update with familyId constraint
          const sourceUpdate = await tx.account.updateMany({
            where: { id: data.accountId, familyId },
            data: { balance: { decrement: data.amount } },
          })
          if (sourceUpdate.count !== 1)
            throw new Error("Source account not found or access denied!")
          const updatedSourceAccount = await tx.account.findFirst({
            where: { id: data.accountId, familyId },
            select: { balance: true },
          })
          const sourceBalanceAfter = updatedSourceAccount!.balance

          // Multi-currency: gunakan destinationAmount jika tersedia, fallback ke amount
          const inAmount = data.destinationAmount ?? data.amount
          const inCurrency = data.destinationCurrency ?? data.currency

          // Tenant-safe: update with familyId constraint
          const destUpdate = await tx.account.updateMany({
            where: { id: data.toAccountId, familyId },
            data: { balance: { increment: inAmount } },
          })
          if (destUpdate.count !== 1)
            throw new Error("Destination account not found or access denied!")
          const updatedDestAccount = await tx.account.findFirst({
            where: { id: data.toAccountId, familyId },
            select: { balance: true },
          })
          const destBalanceAfter = updatedDestAccount!.balance

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
              idempotencyKey: data.idempotencyKey,
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

          const createdTransfer = await tx.transfer.create({
            data: {
              outflowTransactionId: outflowTx.id,
              inflowTransactionId: inflowTx.id,
            },
          })

          const [newSrcAcc, newDstAcc] = await Promise.all([
            tx.account.findUniqueOrThrow({ where: { id: data.accountId } }),
            tx.account.findUniqueOrThrow({ where: { id: data.toAccountId } }),
          ])

          const auditCtx = await createAuditContext(
            { user: { id: user.id, familyId } },
            data.idempotencyKey
          )
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Account",
            entityId: data.accountId,
            before: oldSrcAcc,
            after: newSrcAcc,
          })
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Account",
            entityId: data.toAccountId,
            before: oldDstAcc,
            after: newDstAcc,
          })
          await auditLog(tx, auditCtx, {
            action: "create",
            entityType: "Transaction",
            entityId: outflowTx.id,
            before: null,
            after: outflowTx,
          })
          await auditLog(tx, auditCtx, {
            action: "create",
            entityType: "Transaction",
            entityId: inflowTx.id,
            before: null,
            after: inflowTx,
          })
          await auditLog(tx, auditCtx, {
            action: "create",
            entityType: "Transfer",
            entityId: createdTransfer.id,
            before: null,
            after: createdTransfer,
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

        const oldAccount = await tx.account.findUniqueOrThrow({
          where: { id: data.accountId },
        })

        // Running Balance Snapshot: baca saldo setelah update atomik
        let accountBalanceAfter: bigint | null = null
        if (data.type === "expense") {
          const upd = await tx.account.updateMany({
            where: { id: data.accountId, familyId },
            data: { balance: { decrement: data.amount } },
          })
          if (upd.count !== 1)
            throw new Error("Account not found or access denied!")
          const updated = await tx.account.findFirst({
            where: { id: data.accountId, familyId },
            select: { balance: true },
          })
          accountBalanceAfter = updated!.balance
        } else {
          const upd = await tx.account.updateMany({
            where: { id: data.accountId, familyId },
            data: { balance: { increment: data.amount } },
          })
          if (upd.count !== 1)
            throw new Error("Account not found or access denied!")
          const updated = await tx.account.findFirst({
            where: { id: data.accountId, familyId },
            select: { balance: true },
          })
          accountBalanceAfter = updated!.balance
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
            idempotencyKey: data.idempotencyKey,
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

        const newAccount = await tx.account.findUniqueOrThrow({
          where: { id: data.accountId },
        })

        const auditCtx = await createAuditContext(
          { user: { id: user.id, familyId } },
          data.idempotencyKey
        )
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Account",
          entityId: data.accountId,
          before: oldAccount,
          after: newAccount,
        })
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Transaction",
          entityId: newTransaction.id,
          before: null,
          after: newTransaction,
        })

        if (data.isSplit && data.splitEntries?.length) {
          const createdSplitEntries = await tx.splitEntry.findMany({
            where: { transactionId: newTransaction.id },
          })
          for (const entry of createdSplitEntries) {
            await auditLog(tx, auditCtx, {
              action: "create",
              entityType: "SplitEntry",
              entityId: entry.id,
              before: null,
              after: entry,
            })
          }
        }

        return serializeTransaction({
          ...newTransaction,
          amount: absMoney(newTransaction.amount),
        })
      }
    )

  try {
    return await createOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const replay = await runInTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) =>
        await replayIdempotentTransaction(tx, familyId, data)
    )
    if (replay) return replay

    throw error
  }
}

/**
 * BACKEND FUNCTION: Create Transaction & Update Balances (ACID Compliant)
 */
export const createTransactionFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    (data: z.input<typeof createTransactionTransportInputSchema>) =>
      createTransactionTransportInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createTransactionForFamily({
      data: await normalizeCreateTransactionTransportInput(data),
      familyId: context.familyId,
      user: context.user,
    })
  })

/**
 * BACKEND FUNCTION: Fetch complete transaction ledger
 * Menerapkan Data Projection: Hanya mengambil field relasi yang dibutuhkan UI
 */
export const getTransactionsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return scopedTenantTransaction(context.familyId, async (tx) => {
      const transactions = await tx.transaction.findMany({
        orderBy: { date: "desc" },
        where: {
          familyId: context.familyId,
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
  })

export async function deleteTransactionForFamily({
  id,
  familyId,
  user,
}: {
  id: string
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return await scopedTenantTransaction(
    familyId,
    async (tx: TenantTransactionClient) => {
      // 1. Cari transaksi lama beserta relasi transfernya dan split entries
      const oldTx = await tx.transaction.findUnique({
        where: { id },
        include: { transferOut: true, transferIn: true, splitEntries: true },
      })

      if (!oldTx) throw new Error("Transaction not found!")

      const oldTransferGraph =
        oldTx.type === "transfer" && oldTx.transferOut
          ? await tx.transfer.findUnique({
              where: { id: oldTx.transferOut.id },
              include: {
                inflowTransaction: true,
                outflowTransaction: true,
              },
            })
          : null

      // Cari inflow transaction jika ini transfer
      const inflowTx =
        oldTx.type === "transfer" && oldTx.transferOut
          ? await tx.transaction.findUnique({
              where: {
                id: oldTx.transferOut.inflowTransactionId,
              },
              include: { splitEntries: true },
            })
          : null

      // Ambil akun-akun yang terpengaruh sebelum mutasi
      const affectedAccountIds = [oldTx.accountId]
      if (inflowTx) {
        affectedAccountIds.push(inflowTx.accountId)
      }
      const oldAccounts = await tx.account.findMany({
        where: { id: { in: affectedAccountIds } },
      })

      // 2. REVERSE BALANCES (Kembalikan Saldo)
      if (oldTx.type === "transfer" && oldTx.transferOut) {
        const srcUpd = await tx.account.updateMany({
          where: { id: oldTx.accountId, familyId },
          data: { balance: { increment: absMoney(oldTx.amount) } },
        })
        if (srcUpd.count !== 1)
          throw new Error("Source account not found or access denied!")

        if (inflowTx) {
          const dstUpd = await tx.account.updateMany({
            where: { id: inflowTx.accountId, familyId },
            data: { balance: { decrement: absMoney(inflowTx.amount) } },
          })
          if (dstUpd.count !== 1)
            throw new Error("Destination account not found or access denied!")
        }
      } else {
        const upd = await tx.account.updateMany({
          where: { id: oldTx.accountId, familyId },
          data: { balance: { decrement: oldTx.amount } },
        })
        if (upd.count !== 1)
          throw new Error("Account not found or access denied!")
      }

      // 3. SOFT DELETE (GAAP Compliance)
      if (oldTx.type === "transfer" && oldTx.transferOut && inflowTx) {
        // Soft delete outflow
        await tx.transaction.update({
          where: { id: oldTx.id },
          data: { deletedAt: new Date() },
        })

        // Soft delete inflow
        await tx.transaction.update({
          where: { id: inflowTx.id },
          data: { deletedAt: new Date() },
        })
      } else {
        await tx.transaction.update({
          where: { id: oldTx.id },
          data: { deletedAt: new Date() },
        })
      }

      // Ambil data terbaru setelah mutasi selesai diaplikasikan
      const [
        updatedOutflowTx,
        updatedInflowTx,
        newAccounts,
        updatedTransferGraph,
      ] = await Promise.all([
        tx.transaction.findUniqueOrThrow({
          where: { id: oldTx.id },
          include: { splitEntries: true },
        }),
        inflowTx
          ? tx.transaction.findUniqueOrThrow({
              where: { id: inflowTx.id },
              include: { splitEntries: true },
            })
          : Promise.resolve(null),
        tx.account.findMany({
          where: { id: { in: affectedAccountIds } },
        }),
        oldTransferGraph
          ? tx.transfer.findUnique({
              where: { id: oldTransferGraph.id },
              include: {
                inflowTransaction: true,
                outflowTransaction: true,
              },
            })
          : Promise.resolve(null),
      ])

      // Tulis audit log Account/update
      for (const oldAcc of oldAccounts) {
        const newAcc = newAccounts.find((a) => a.id === oldAcc.id)
        if (!newAcc || oldAcc.balance === newAcc.balance) continue
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Account",
          entityId: oldAcc.id,
          before: oldAcc,
          after: newAcc,
        })
      }

      // Tulis audit log Transaction/soft_delete
      await auditLog(tx, auditCtx, {
        action: "soft_delete",
        entityType: "Transaction",
        entityId: oldTx.id,
        before: oldTx,
        after: updatedOutflowTx,
      })

      if (updatedInflowTx && inflowTx) {
        await auditLog(tx, auditCtx, {
          action: "soft_delete",
          entityType: "Transaction",
          entityId: inflowTx.id,
          before: inflowTx,
          after: updatedInflowTx,
        })
      }

      if (oldTransferGraph && updatedTransferGraph) {
        await auditLog(tx, auditCtx, {
          action: "soft_delete",
          entityType: "Transfer",
          entityId: oldTransferGraph.id,
          before: oldTransferGraph,
          after: updatedTransferGraph,
        })
      }

      return { success: true }
    }
  )
}

/**
 * BACKEND FUNCTION: Delete Transaction (Soft Delete — GAAP Compliance)
 * Transaksi tidak pernah benar-benar dihapus; hanya ditandai dengan deletedAt.
 */
export const deleteTransactionFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    return await deleteTransactionForFamily({
      id: data.id,
      familyId: context.familyId,
      user: context.user,
    })
  })

export async function updateTransactionForFamily({
  data,
  familyId,
  user,
}: {
  data: z.infer<typeof transactionInputSchema>
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return await scopedTenantTransaction(
    familyId,
    async (tx: TenantTransactionClient) => {
      assertSplitParity(data)

      // --- FASE 1: REVERSAL (HAPUS LAMA) ---
      // Ambil snapshot graph lengkap sebelum mutasi dilakukan
      const oldTx = await tx.transaction.findUnique({
        where: { id: data.id },
        include: {
          transferOut: {
            include: {
              inflowTransaction: {
                include: { splitEntries: true },
              },
            },
          },
          splitEntries: true,
        },
      })

      if (!oldTx) throw new Error("Original transaction not found")

      const oldInflowTx =
        oldTx.type === "transfer" && oldTx.transferOut
          ? oldTx.transferOut.inflowTransaction
          : null
      const oldTransfer =
        oldTx.type === "transfer" && oldTx.transferOut
          ? {
              id: oldTx.transferOut.id,
              outflowTransactionId: oldTx.transferOut.outflowTransactionId,
              inflowTransactionId: oldTx.transferOut.inflowTransactionId,
              createdAt: oldTx.transferOut.createdAt,
            }
          : null

      // Kumpulkan semua akun yang terpengaruh (sebelum dan sesudah)
      const touchedAccountIds = new Set([oldTx.accountId, data.accountId])
      if (oldInflowTx) touchedAccountIds.add(oldInflowTx.accountId)
      if (data.toAccountId) touchedAccountIds.add(data.toAccountId)

      const oldAccounts = await tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      })

      if (oldTx.type === "transfer" && oldTx.transferOut) {
        const inflowTx = await tx.transaction.findUnique({
          where: {
            id: oldTx.transferOut.inflowTransactionId,
          },
        })
        const srcUpd = await tx.account.updateMany({
          where: { id: oldTx.accountId, familyId },
          data: { balance: { increment: absMoney(oldTx.amount) } },
        })
        if (srcUpd.count !== 1)
          throw new Error("Source account not found or access denied!")
        if (inflowTx) {
          const dstUpd = await tx.account.updateMany({
            where: { id: inflowTx.accountId, familyId },
            data: { balance: { decrement: absMoney(inflowTx.amount) } },
          })
          if (dstUpd.count !== 1)
            throw new Error("Destination account not found or access denied!")
          await tx.transaction.delete({ where: { id: inflowTx.id } })
        }
      } else {
        const upd = await tx.account.updateMany({
          where: { id: oldTx.accountId, familyId },
          data: { balance: { decrement: oldTx.amount } },
        })
        if (upd.count !== 1)
          throw new Error("Account not found or access denied!")
      }
      await tx.transaction.delete({ where: { id: oldTx.id } })

      // --- FASE 2: REPLACE (BUAT BARU DENGAN DATA UPDATE) ---
      let resultTransaction

      if (data.type === "transfer") {
        let kind = "funds_movement"
        const toAccount = await tx.account.findFirst({
          where: { id: data.toAccountId!, familyId },
        })
        if (!toAccount)
          throw new Error("Destination account not found or access denied!")
        if (toAccount.type === "CREDIT") kind = "cc_payment"
        else if (toAccount.type === "LOAN") kind = "loan_payment"

        const srcUpd = await tx.account.updateMany({
          where: { id: data.accountId, familyId },
          data: { balance: { decrement: data.amount } },
        })
        if (srcUpd.count !== 1)
          throw new Error("Source account not found or access denied!")
        const updatedSourceAccount = await tx.account.findFirst({
          where: { id: data.accountId, familyId },
          select: { balance: true },
        })
        const sourceBalanceAfter = updatedSourceAccount!.balance

        const inAmount = data.destinationAmount ?? data.amount
        const inCurrency = data.destinationCurrency ?? data.currency

        const dstUpd = await tx.account.updateMany({
          where: { id: data.toAccountId!, familyId },
          data: { balance: { increment: inAmount } },
        })
        if (dstUpd.count !== 1)
          throw new Error("Destination account not found or access denied!")
        const updatedDestAccount = await tx.account.findFirst({
          where: { id: data.toAccountId!, familyId },
          select: { balance: true },
        })
        const destBalanceAfter = updatedDestAccount!.balance

        const outflowTx = await tx.transaction.create({
          data: {
            id: data.id,
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
            accountId: data.toAccountId!,
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

        const createdTransfer = await tx.transfer.create({
          data: {
            ...(oldTransfer ? { id: oldTransfer.id } : {}),
            outflowTransactionId: outflowTx.id,
            inflowTransactionId: inflowTx.id,
          },
        })

        resultTransaction = outflowTx

        // Re-read data terbaru setelah mutasi
        const [newOutflow, newInflow, newAccounts] = await Promise.all([
          tx.transaction.findUniqueOrThrow({
            where: { id: outflowTx.id },
            include: { splitEntries: true },
          }),
          tx.transaction.findUniqueOrThrow({
            where: { id: inflowTx.id },
            include: { splitEntries: true },
          }),
          tx.account.findMany({
            where: { id: { in: Array.from(touchedAccountIds) } },
          }),
        ])

        // Tulis audit log Account/update
        for (const oldAcc of oldAccounts) {
          const newAcc = newAccounts.find((a) => a.id === oldAcc.id)
          if (!newAcc || oldAcc.balance === newAcc.balance) continue
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Account",
            entityId: oldAcc.id,
            before: oldAcc,
            after: newAcc,
          })
        }

        // Tulis audit log Transaction/update
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Transaction",
          entityId: oldTx.id,
          before: oldTx,
          after: newOutflow,
        })

        if (oldInflowTx) {
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Transaction",
            entityId: oldInflowTx.id,
            before: oldInflowTx,
            after: newInflow,
          })
        } else {
          await auditLog(tx, auditCtx, {
            action: "create",
            entityType: "Transaction",
            entityId: newInflow.id,
            before: null,
            after: newInflow,
          })
        }

        // Tulis audit log Transfer
        if (oldTransfer) {
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Transfer",
            entityId: oldTransfer.id,
            before: oldTransfer,
            after: createdTransfer,
          })
        } else {
          await auditLog(tx, auditCtx, {
            action: "create",
            entityType: "Transfer",
            entityId: createdTransfer.id,
            before: null,
            after: createdTransfer,
          })
        }
      } else {
        const amountSign: Money =
          data.type === "expense"
            ? negateMoney(absMoney(data.amount))
            : absMoney(data.amount)

        let accountBalanceAfter: bigint | null = null
        if (data.type === "expense") {
          const upd = await tx.account.updateMany({
            where: { id: data.accountId, familyId },
            data: { balance: { decrement: data.amount } },
          })
          if (upd.count !== 1)
            throw new Error("Account not found or access denied!")
          const updated = await tx.account.findFirst({
            where: { id: data.accountId, familyId },
            select: { balance: true },
          })
          accountBalanceAfter = updated!.balance
        } else {
          const upd = await tx.account.updateMany({
            where: { id: data.accountId, familyId },
            data: { balance: { increment: data.amount } },
          })
          if (upd.count !== 1)
            throw new Error("Account not found or access denied!")
          const updated = await tx.account.findFirst({
            where: { id: data.accountId, familyId },
            select: { balance: true },
          })
          accountBalanceAfter = updated!.balance
        }

        const newTx = await tx.transaction.create({
          data: {
            id: data.id,
            type: data.type,
            amount: amountSign,
            description: data.description,
            date: data.date,
            notes: data.notes || null,
            accountId: data.accountId,
            toAccountId: data.toAccountId || null,
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

        resultTransaction = newTx

        // Re-read data terbaru setelah mutasi
        const [updatedTx, newAccounts] = await Promise.all([
          tx.transaction.findUniqueOrThrow({
            where: { id: newTx.id },
            include: { splitEntries: true },
          }),
          tx.account.findMany({
            where: { id: { in: Array.from(touchedAccountIds) } },
          }),
        ])

        // Tulis audit log Account/update
        for (const oldAcc of oldAccounts) {
          const newAcc = newAccounts.find((a) => a.id === oldAcc.id)
          if (!newAcc || oldAcc.balance === newAcc.balance) continue
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Account",
            entityId: oldAcc.id,
            before: oldAcc,
            after: newAcc,
          })
        }

        // Tulis audit log Transaction/update
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Transaction",
          entityId: oldTx.id,
          before: oldTx,
          after: updatedTx,
        })

        // Split entries logs
        if (oldTx.splitEntries?.length) {
          for (const entry of oldTx.splitEntries) {
            await auditLog(tx, auditCtx, {
              action: "delete",
              entityType: "SplitEntry",
              entityId: entry.id,
              before: entry,
              after: null,
            })
          }
        }
        if (updatedTx.splitEntries?.length) {
          for (const entry of updatedTx.splitEntries) {
            await auditLog(tx, auditCtx, {
              action: "create",
              entityType: "SplitEntry",
              entityId: entry.id,
              before: null,
              after: entry,
            })
          }
        }

        if (oldInflowTx) {
          await auditLog(tx, auditCtx, {
            action: "delete",
            entityType: "Transaction",
            entityId: oldInflowTx.id,
            before: oldInflowTx,
            after: null,
          })
        }
        if (oldTransfer) {
          await auditLog(tx, auditCtx, {
            action: "delete",
            entityType: "Transfer",
            entityId: oldTransfer.id,
            before: oldTransfer,
            after: null,
          })
        }
      }

      return serializeTransaction({
        ...resultTransaction,
        amount: absMoney(resultTransaction.amount),
      })
    }
  )
}

/**
 * BACKEND FUNCTION: Update Transaction (Reversal-and-Replace Pattern)
 * FASE 1 menggunakan hard delete (internal reversal, bukan user-facing delete).
 * FASE 2 membuat record baru dengan ID yang sama — continuity terjaga.
 */
export const updateTransactionFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(transactionInputSchema)
  .handler(async ({ data, context }) => {
    if (!data.id) throw new Error("ID is required for updating")
    return await updateTransactionForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

export async function bulkDeleteTransactionsForFamily({
  ids,
  familyId,
  user,
}: {
  ids: string[]
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return await scopedTenantTransaction(
    familyId,
    async (tx: TenantTransactionClient) => {
      // 1. Ambil data asli untuk merestore saldo
      const oldTxs = await tx.transaction.findMany({
        where: { id: { in: ids } },
        include: { transferOut: true, splitEntries: true },
      })

      const inflowTxIds = oldTxs
        .filter((t) => t.type === "transfer" && t.transferOut)
        .map((t) => t.transferOut!.inflowTransactionId)

      const oldInflowTxs =
        inflowTxIds.length > 0
          ? await tx.transaction.findMany({
              where: { id: { in: inflowTxIds } },
              include: { splitEntries: true },
            })
          : []

      const oldTransfers =
        oldTxs.length > 0
          ? await tx.transfer.findMany({
              where: { outflowTransactionId: { in: oldTxs.map((t) => t.id) } },
              include: {
                inflowTransaction: true,
                outflowTransaction: true,
              },
            })
          : []

      const touchedAccountIds = new Set(oldTxs.map((t) => t.accountId))
      oldInflowTxs.forEach((t) => touchedAccountIds.add(t.accountId))

      const oldAccounts = await tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      })

      const accountDeltas: Record<string, bigint> = {}
      const addDelta = (id: string, amount: bigint) => {
        if (!accountDeltas[id]) accountDeltas[id] = 0n
        accountDeltas[id] += amount
      }

      for (const oldTx of oldTxs) {
        if (oldTx.type === "transfer" && oldTx.transferOut) {
          const inflowTx = oldInflowTxs.find(
            (t) => t.id === oldTx.transferOut!.inflowTransactionId
          )
          addDelta(oldTx.accountId, absMoney(oldTx.amount))
          if (inflowTx) {
            addDelta(inflowTx.accountId, negateMoney(absMoney(inflowTx.amount)))
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

      // 3. Soft delete
      await tx.transaction.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      })

      // Re-read data terbaru setelah mutasi
      const [newOutflowTxs, newInflowTxs, newAccounts, newTransfers] =
        await Promise.all([
          tx.transaction.findMany({
            where: { id: { in: ids } },
            include: { splitEntries: true },
          }),
          inflowTxIds.length > 0
            ? tx.transaction.findMany({
                where: { id: { in: inflowTxIds } },
                include: { splitEntries: true },
              })
            : Promise.resolve([]),
          tx.account.findMany({
            where: { id: { in: Array.from(touchedAccountIds) } },
          }),
          oldTransfers.length > 0
            ? tx.transfer.findMany({
                where: { id: { in: oldTransfers.map((t) => t.id) } },
                include: {
                  inflowTransaction: true,
                  outflowTransaction: true,
                },
              })
            : Promise.resolve([]),
        ])

      // Tulis audit log Account/update (1 per touched Account)
      for (const oldAcc of oldAccounts) {
        const newAcc = newAccounts.find((a) => a.id === oldAcc.id)
        if (!newAcc || oldAcc.balance === newAcc.balance) continue
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Account",
          entityId: oldAcc.id,
          before: oldAcc,
          after: newAcc,
        })
      }

      // Tulis audit log Transaction/soft_delete
      for (const oldTx of oldTxs) {
        const newTx = newOutflowTxs.find((t) => t.id === oldTx.id)
        await auditLog(tx, auditCtx, {
          action: "soft_delete",
          entityType: "Transaction",
          entityId: oldTx.id,
          before: oldTx,
          after: newTx,
        })
      }
      for (const oldInflow of oldInflowTxs) {
        const newInflow = newInflowTxs.find((t) => t.id === oldInflow.id)
        await auditLog(tx, auditCtx, {
          action: "soft_delete",
          entityType: "Transaction",
          entityId: oldInflow.id,
          before: oldInflow,
          after: newInflow,
        })
      }
      for (const oldTransfer of oldTransfers) {
        const newTransfer = newTransfers.find((t) => t.id === oldTransfer.id)
        await auditLog(tx, auditCtx, {
          action: "soft_delete",
          entityType: "Transfer",
          entityId: oldTransfer.id,
          before: oldTransfer,
          after: newTransfer,
        })
      }

      return { success: true }
    }
  )
}

/**
 * BACKEND FUNCTION: Bulk Delete Transactions (Soft Delete — GAAP Compliance)
 */
export const bulkDeleteTransactionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(z.object({ ids: z.array(z.string()) }))
  .handler(async ({ data, context }) => {
    if (data.ids.length === 0) return { success: true }
    return await bulkDeleteTransactionsForFamily({
      ids: data.ids,
      familyId: context.familyId,
      user: context.user,
    })
  })

export async function bulkUpdateTransactionsForFamily({
  data,
  familyId,
  user,
}: {
  data: {
    ids: string[]
    categoryId?: string | null
    merchantId?: string | null
    accountId?: string
  }
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return await scopedTenantTransaction(
    familyId,
    async (tx: TenantTransactionClient) => {
      // Ambil data before
      const oldTxs = await tx.transaction.findMany({
        where: { id: { in: data.ids } },
        include: { splitEntries: true },
      })

      const touchedAccountIds = new Set(oldTxs.map((t) => t.accountId))
      if (data.accountId !== undefined) {
        touchedAccountIds.add(data.accountId)
      }

      const oldAccounts = await tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      })

      // 1. Handle Account Change (Requires Balance Shifting)
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

      // 2. Prepare scalar updates payload
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

      // 3. Execute DB Modifications
      if (Object.keys(parentUpdates).length > 0) {
        await tx.transaction.updateMany({
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

      // Re-read data terbaru setelah mutasi
      const [newTxs, newAccounts] = await Promise.all([
        tx.transaction.findMany({
          where: { id: { in: data.ids } },
          include: { splitEntries: true },
        }),
        tx.account.findMany({
          where: { id: { in: Array.from(touchedAccountIds) } },
        }),
      ])

      // Tulis audit log Account/update (1 per touched Account)
      for (const oldAcc of oldAccounts) {
        const newAcc = newAccounts.find((a) => a.id === oldAcc.id)
        if (!newAcc || oldAcc.balance === newAcc.balance) continue
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Account",
          entityId: oldAcc.id,
          before: oldAcc,
          after: newAcc,
        })
      }

      // Tulis audit log Transaction/update
      for (const oldTx of oldTxs) {
        const newTx = newTxs.find((t) => t.id === oldTx.id)
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Transaction",
          entityId: oldTx.id,
          before: oldTx,
          after: newTx,
        })
      }

      return { success: true }
    }
  )
}

/**
 * BACKEND FUNCTION: Bulk Update Transactions
 */
export const bulkUpdateTransactionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    z.object({
      ids: z.array(z.string()),
      categoryId: z.string().nullable().optional(),
      merchantId: z.string().nullable().optional(),
      accountId: z.string().optional(),
    })
  )
  .handler(async ({ data, context }) => {
    if (data.ids.length === 0) return { success: true }
    return await bulkUpdateTransactionsForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

export async function bulkCreateTransactionsForFamily({
  data,
  familyId,
  user,
}: {
  data: z.infer<typeof bulkTransactionInputSchema>
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return await scopedTenantTransaction(
    familyId,
    async (tx: TenantTransactionClient) => {
      // Ambil data akun-akun terpengaruh sebelum mutasi
      const touchedAccountIds = new Set(
        data.transactions.map((t) => t.accountId)
      )
      const oldAccounts = await tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      })

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

      // Re-read data terbaru setelah mutasi
      const [newTxs, newAccounts] = await Promise.all([
        tx.transaction.findMany({
          where: { id: { in: data.transactions.map((t) => t.id) } },
          include: { splitEntries: true },
        }),
        tx.account.findMany({
          where: { id: { in: Array.from(touchedAccountIds) } },
        }),
      ])

      // Tulis audit log Account/update (1 per touched Account)
      for (const oldAcc of oldAccounts) {
        const newAcc = newAccounts.find((a) => a.id === oldAcc.id)
        if (!newAcc || oldAcc.balance === newAcc.balance) continue
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Account",
          entityId: oldAcc.id,
          before: oldAcc,
          after: newAcc,
        })
      }

      // Tulis audit log Transaction/create
      for (const newTx of newTxs) {
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Transaction",
          entityId: newTx.id,
          before: null,
          after: newTx,
        })
      }

      return { success: true, count: data.transactions.length }
    }
  )
}

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

/**
 * BACKEND FUNCTION: Bulk Create Transactions
 */
export const bulkCreateTransactionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.input<typeof bulkTransactionInputSchema>) =>
    bulkTransactionInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await bulkCreateTransactionsForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })
