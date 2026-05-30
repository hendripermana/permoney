import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { absMoney, encodeMoney, negateMoney, type Money } from "@/lib/money"
import { assertSplitParity } from "@/lib/split-parity"
import {
  familyMiddleware,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import {
  auditLogs,
  createAuditContext,
  type AuditLogEntry,
} from "./middleware/audit"
import {
  TenantReferenceError,
  validateTenantReferences,
} from "./validation/tenant-references"
import { VersionDriftError } from "./middleware/with-retry"

/**
 * BACKEND FUNCTION: Fetch reference data for the Transaction Form Dropdowns
 * This function executes strictly on the Server (Node.js).
 */
export const getTransactionFormData = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return scopedTenantTransaction(context.familyId, async (tx) => {
      const [accounts, categories, merchants] =
        await runTenantTransactionQueriesInOrder([
          () =>
            tx.account.findMany({
              where: { familyId: context.familyId },
              orderBy: { name: "asc" },
            }),
          () =>
            tx.category.findMany({
              where: {
                OR: [{ isSystem: true }, { familyId: context.familyId }],
              },
              orderBy: { name: "asc" },
            }),
          () =>
            tx.merchant.findMany({
              where: { familyId: context.familyId },
              orderBy: { name: "asc" },
            }),
        ] as const)
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

function indexById<T extends { id: string }>(
  items: readonly T[]
): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]))
}

function accountBalanceAuditEntries<T extends { id: string; balance: bigint }>(
  oldAccounts: readonly T[],
  newAccounts: readonly T[]
): AuditLogEntry[] {
  const newAccountsById = indexById(newAccounts)
  return oldAccounts.flatMap((oldAccount) => {
    const newAccount = newAccountsById.get(oldAccount.id)
    if (!newAccount || oldAccount.balance === newAccount.balance) return []
    return [
      {
        action: "update",
        entityType: "Account",
        entityId: oldAccount.id,
        before: oldAccount,
        after: newAccount,
      },
    ]
  })
}

function pairedAuditEntries<TBefore extends { id: string }, TAfter>({
  action,
  afterItems,
  beforeItems,
  entityType,
}: {
  action: AuditLogEntry["action"]
  afterItems: readonly (TAfter & { id: string })[]
  beforeItems: readonly TBefore[]
  entityType: string
}): AuditLogEntry[] {
  const afterById = indexById(afterItems)
  return beforeItems.map((beforeItem) => ({
    action,
    entityType,
    entityId: beforeItem.id,
    before: beforeItem,
    after: afterById.get(beforeItem.id),
  }))
}

function createdAuditEntries<T extends { id: string }>(
  entityType: string,
  items: readonly T[]
): AuditLogEntry[] {
  return items.map((item) => ({
    action: "create",
    entityType,
    entityId: item.id,
    before: null,
    after: item,
  }))
}

type AccountDeltaMap = Record<string, bigint>

interface AccountBalanceVersion {
  balance: bigint
  id: string
  version: number
}

interface AccountBalanceMutation {
  after: AccountBalanceVersion
  before: AccountBalanceVersion
}

type QueryResultTuple<TQueries extends readonly (() => Promise<unknown>)[]> = {
  [TIndex in keyof TQueries]: TQueries[TIndex] extends () => Promise<
    infer TResult
  >
    ? TResult
    : never
}

/**
 * Prisma interactive transaction memakai satu pg Client. Jangan jalankan query
 * dari `tx` yang sama dengan `Promise.all`; pg@8 memberi warning dan pg@9 akan
 * menolak overlap tersebut.
 */
async function runTenantTransactionQueriesInOrder<
  const TQueries extends readonly (() => Promise<unknown>)[],
>(queries: TQueries): Promise<QueryResultTuple<TQueries>> {
  const results: unknown[] = []
  await queries.reduce<Promise<void>>(
    (previous, query) =>
      previous.then(() =>
        query().then((result) => {
          results.push(result)
        })
      ),
    Promise.resolve()
  )
  return results as QueryResultTuple<TQueries>
}

async function findTransactionWithSplitEntries(
  tx: TenantTransactionClient,
  id: string
) {
  const [transaction, splitEntries] = await runTenantTransactionQueriesInOrder([
    () => tx.transaction.findUniqueOrThrow({ where: { id } }),
    () =>
      tx.splitEntry.findMany({
        where: { transactionId: id },
        orderBy: { createdAt: "asc" },
      }),
  ] as const)
  return { ...transaction, splitEntries }
}

async function findOptionalTransactionWithSplitEntries(
  tx: TenantTransactionClient,
  id: string
) {
  const transaction = await tx.transaction.findUnique({ where: { id } })
  if (!transaction) return null
  const splitEntries = await tx.splitEntry.findMany({
    where: { transactionId: id },
    orderBy: { createdAt: "asc" },
  })
  return { ...transaction, splitEntries }
}

async function findTransactionAuditGraph(
  tx: TenantTransactionClient,
  id: string
) {
  const transaction = await tx.transaction.findUnique({ where: { id } })
  if (!transaction) return null

  const [splitEntries, transferOut, transferIn] =
    await runTenantTransactionQueriesInOrder([
      () =>
        tx.splitEntry.findMany({
          where: { transactionId: id },
          orderBy: { createdAt: "asc" },
        }),
      () => tx.transfer.findFirst({ where: { outflowTransactionId: id } }),
      () => tx.transfer.findFirst({ where: { inflowTransactionId: id } }),
    ] as const)

  return { ...transaction, splitEntries, transferOut, transferIn }
}

async function findTransferGraph(tx: TenantTransactionClient, id: string) {
  const transfer = await tx.transfer.findUnique({ where: { id } })
  if (!transfer) return null

  const [outflowTransaction, inflowTransaction] =
    await runTenantTransactionQueriesInOrder([
      () =>
        tx.transaction.findUniqueOrThrow({
          where: { id: transfer.outflowTransactionId },
        }),
      () =>
        tx.transaction.findUniqueOrThrow({
          where: { id: transfer.inflowTransactionId },
        }),
    ] as const)

  return { ...transfer, outflowTransaction, inflowTransaction }
}

async function findTransactionsWithSplitEntries(
  tx: TenantTransactionClient,
  ids: readonly string[]
) {
  if (ids.length === 0) return []

  const transactions = await tx.transaction.findMany({
    where: { id: { in: [...ids] } },
  })
  const splitEntries = await tx.splitEntry.findMany({
    where: { transactionId: { in: transactions.map((item) => item.id) } },
    orderBy: { createdAt: "asc" },
  })
  const splitEntriesByTransactionId = new Map<string, typeof splitEntries>()
  for (const splitEntry of splitEntries) {
    const current = splitEntriesByTransactionId.get(splitEntry.transactionId)
    if (current) current.push(splitEntry)
    else splitEntriesByTransactionId.set(splitEntry.transactionId, [splitEntry])
  }

  return transactions.map((transaction) => ({
    ...transaction,
    splitEntries: splitEntriesByTransactionId.get(transaction.id) ?? [],
  }))
}

async function findTransactionsWithTransferOutAndSplitEntries(
  tx: TenantTransactionClient,
  ids: readonly string[]
) {
  const transactions = await findTransactionsWithSplitEntries(tx, ids)
  const transfers = await tx.transfer.findMany({
    where: {
      outflowTransactionId: { in: transactions.map((item) => item.id) },
    },
  })
  const transfersByOutflowId = new Map(
    transfers.map((transfer) => [transfer.outflowTransactionId, transfer])
  )

  return transactions.map((transaction) => ({
    ...transaction,
    transferOut: transfersByOutflowId.get(transaction.id) ?? null,
  }))
}

async function findTransferGraphs(
  tx: TenantTransactionClient,
  ids: readonly string[]
) {
  if (ids.length === 0) return []

  const transfers = await tx.transfer.findMany({
    where: { id: { in: [...ids] } },
  })
  const transactionIds = transfers.flatMap((transfer) => [
    transfer.outflowTransactionId,
    transfer.inflowTransactionId,
  ])
  const transactions = await tx.transaction.findMany({
    where: { id: { in: transactionIds } },
  })
  const transactionsById = indexById(transactions)

  return transfers.map((transfer) => {
    const outflowTransaction = transactionsById.get(
      transfer.outflowTransactionId
    )
    const inflowTransaction = transactionsById.get(transfer.inflowTransactionId)
    if (!outflowTransaction || !inflowTransaction) {
      throw new Error("Transfer graph is incomplete")
    }
    return { ...transfer, outflowTransaction, inflowTransaction }
  })
}

function accountListRelation(account: {
  color: string | null
  name: string
  type: string
}) {
  return { name: account.name, type: account.type, color: account.color }
}

function categoryListRelation(category: {
  color: string
  icon: string
  name: string
}) {
  return { name: category.name, color: category.color, icon: category.icon }
}

function merchantListRelation(merchant: {
  logoUrl: string | null
  name: string
}) {
  return { name: merchant.name, logoUrl: merchant.logoUrl }
}

export async function findLedgerTransactionsForFamily(
  tx: TenantTransactionClient,
  familyId: string
) {
  const transactions = await tx.transaction.findMany({
    orderBy: { date: "desc" },
    where: {
      familyId,
      deletedAt: null,
      transferIn: {
        is: null,
      },
      // PER-20 / ADR-0012: defense-in-depth against any future drift between
      // Transaction.deletedAt and Transfer.deletedAt. A non-transfer row
      // (`transferOut: null`) passes; an outflow leg only passes when its
      // Transfer row is also alive.
      OR: [{ transferOut: { is: null } }, { transferOut: { deletedAt: null } }],
    },
  })
  const transactionIds = transactions.map((transaction) => transaction.id)

  const accountIds = new Set<string>()
  const categoryIds = new Set<string>()
  const merchantIds = new Set<string>()
  for (const transaction of transactions) {
    accountIds.add(transaction.accountId)
    if (transaction.toAccountId) accountIds.add(transaction.toAccountId)
    if (transaction.categoryId) categoryIds.add(transaction.categoryId)
    if (transaction.merchantId) merchantIds.add(transaction.merchantId)
  }

  const splitEntries =
    transactionIds.length > 0
      ? await tx.splitEntry.findMany({
          where: { transactionId: { in: transactionIds } },
          orderBy: { createdAt: "asc" },
        })
      : []
  for (const splitEntry of splitEntries) {
    if (splitEntry.categoryId) categoryIds.add(splitEntry.categoryId)
    if (splitEntry.merchantId) merchantIds.add(splitEntry.merchantId)
  }

  const [accounts, categories, merchants] =
    await runTenantTransactionQueriesInOrder([
      () =>
        accountIds.size > 0
          ? tx.account.findMany({
              where: { id: { in: Array.from(accountIds) } },
              select: { id: true, name: true, type: true, color: true },
            })
          : Promise.resolve([]),
      () =>
        categoryIds.size > 0
          ? tx.category.findMany({
              where: { id: { in: Array.from(categoryIds) } },
              select: { id: true, name: true, color: true, icon: true },
            })
          : Promise.resolve([]),
      () =>
        merchantIds.size > 0
          ? tx.merchant.findMany({
              where: { id: { in: Array.from(merchantIds) } },
              select: { id: true, name: true, logoUrl: true },
            })
          : Promise.resolve([]),
    ] as const)

  const accountsById = indexById(accounts)
  const categoriesById = indexById(categories)
  const merchantsById = indexById(merchants)
  const splitEntriesByTransactionId = new Map<string, typeof splitEntries>()
  for (const splitEntry of splitEntries) {
    const current = splitEntriesByTransactionId.get(splitEntry.transactionId)
    if (current) current.push(splitEntry)
    else splitEntriesByTransactionId.set(splitEntry.transactionId, [splitEntry])
  }

  return transactions.map((transaction) => {
    const account = accountsById.get(transaction.accountId)
    if (!account) throw new Error("Transaction account relation is incomplete")

    const toAccount = transaction.toAccountId
      ? accountsById.get(transaction.toAccountId)
      : null
    const category = transaction.categoryId
      ? categoriesById.get(transaction.categoryId)
      : null
    const merchant = transaction.merchantId
      ? merchantsById.get(transaction.merchantId)
      : null

    return {
      ...transaction,
      account: accountListRelation(account),
      toAccount: toAccount ? accountListRelation(toAccount) : null,
      category: category ? categoryListRelation(category) : null,
      merchant: merchant ? merchantListRelation(merchant) : null,
      splitEntries: (splitEntriesByTransactionId.get(transaction.id) ?? []).map(
        (splitEntry) => {
          const splitCategory = splitEntry.categoryId
            ? categoriesById.get(splitEntry.categoryId)
            : null
          const splitMerchant = splitEntry.merchantId
            ? merchantsById.get(splitEntry.merchantId)
            : null
          return {
            ...splitEntry,
            category: splitCategory
              ? categoryListRelation(splitCategory)
              : null,
            merchant: splitMerchant
              ? merchantListRelation(splitMerchant)
              : null,
          }
        }
      ),
    }
  })
}

function addAccountDelta(
  accountDeltas: AccountDeltaMap,
  accountId: string,
  amount: bigint
): void {
  if (!accountDeltas[accountId]) accountDeltas[accountId] = 0n
  accountDeltas[accountId] += amount
}

async function applyAccountDeltas(
  tx: TenantTransactionClient,
  familyId: string,
  accountDeltas: AccountDeltaMap
): Promise<AccountBalanceMutation[]> {
  const mutations: AccountBalanceMutation[] = []
  await runTenantTransactionQueriesInOrder(
    Object.entries(accountDeltas).map(([accountId, delta]) => async () => {
      if (delta === 0n) return
      mutations.push(
        await applyAccountBalanceDelta(tx, {
          accountId,
          delta,
          familyId,
          notFoundMessage: "Account not found or access denied!",
        })
      )
    })
  )
  return mutations
}

async function applyAccountBalanceDelta(
  tx: TenantTransactionClient,
  {
    accountId,
    delta,
    familyId,
    notFoundMessage,
  }: {
    accountId: string
    delta: bigint
    familyId: string
    notFoundMessage: string
  }
): Promise<AccountBalanceMutation> {
  const before = await findAccountBalanceVersion(
    tx,
    accountId,
    familyId,
    notFoundMessage
  )

  const update = await tx.account.updateMany({
    where: { id: accountId, familyId, version: before.version },
    data: {
      balance: { increment: delta },
      version: { increment: 1 },
    },
  })

  if (update.count !== 1) {
    const current = await tx.account.findFirst({
      where: { id: accountId, familyId },
      select: { id: true },
    })
    if (!current) {
      throw new Error(notFoundMessage)
    }
    throw new VersionDriftError(
      `Account ${accountId} balance version drift detected`
    )
  }

  const after = await findAccountBalanceVersion(
    tx,
    accountId,
    familyId,
    notFoundMessage
  )

  return { after, before }
}

async function findAccountBalanceVersion(
  tx: TenantTransactionClient,
  accountId: string,
  familyId: string,
  notFoundMessage: string
): Promise<AccountBalanceVersion> {
  const account = await tx.account.findFirst({
    where: { id: accountId, familyId },
    select: { balance: true, id: true, version: true },
  })
  if (!account) {
    throw new Error(notFoundMessage)
  }
  return account
}

function signedIncomeExpenseAmount(
  type: "expense" | "income",
  amount: bigint
): bigint {
  return type === "expense" ? negateMoney(absMoney(amount)) : absMoney(amount)
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
  const transaction = await tx.transaction.findUnique({
    where: {
      tx_family_idempotency: {
        familyId,
        idempotencyKey,
      },
    },
  })
  if (!transaction) return null

  const [splitEntries, transferIn, transferOut] =
    await runTenantTransactionQueriesInOrder([
      () =>
        tx.splitEntry.findMany({
          where: { transactionId: transaction.id },
          orderBy: { createdAt: "asc" },
        }),
      () =>
        tx.transfer.findFirst({
          where: { inflowTransactionId: transaction.id },
        }),
      () =>
        tx.transfer.findFirst({
          where: { outflowTransactionId: transaction.id },
        }),
    ] as const)

  const transferOutWithInflowTransaction = transferOut
    ? {
        ...transferOut,
        inflowTransaction: await tx.transaction.findUniqueOrThrow({
          where: { id: transferOut.inflowTransactionId },
        }),
      }
    : null

  return {
    ...transaction,
    splitEntries,
    transferIn,
    transferOut: transferOutWithInflowTransaction,
  }
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
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const createOrReplay = async () =>
    await runInTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay = await replayIdempotentTransaction(tx, familyId, data)
        if (replay) return replay

        // PER-94: tenant-owned foreign reference validation. Runs first so a
        // cross-tenant payload short-circuits with a typed
        // `TenantReferenceError` before any balance update or audit row is
        // written. PER-104 DB triggers remain the backstop for raw-SQL paths.
        await validateTenantReferences(tx, familyId, {
          accountId: data.accountId,
          toAccountId: data.toAccountId,
          merchantId: data.merchantId,
          categoryId: data.categoryId,
          splitEntries: data.splitEntries,
        })

        // === SPLIT PARITY GUARD (GAAP Compliance) ===
        // Backend MUST validate that SplitEntries sum === parent.amount.
        // UI validation is a convenience; THIS is the authoritative check.
        // Throws inside `$transaction` → automatic rollback if violated.
        assertSplitParity(data)

        // A. HANDLE TRANSFER (DOUBLE-ENTRY)
        if (data.type === "transfer") {
          if (!data.toAccountId)
            throw new Error("Transfer requires a destination account!")
          const toAccountId = data.toAccountId

          // Tenant-safe: verify account ownership via familyId
          const toAccount = await tx.account.findFirst({
            where: { id: toAccountId, familyId },
          })
          if (!toAccount)
            throw new Error("Destination account not found or access denied!")

          let kind = "funds_movement"
          if (toAccount.type === "CREDIT") kind = "cc_payment"
          else if (toAccount.type === "LOAN") kind = "loan_payment"

          const [oldSrcAcc, oldDstAcc] =
            await runTenantTransactionQueriesInOrder([
              () =>
                tx.account.findUniqueOrThrow({
                  where: { id: data.accountId },
                }),
              () =>
                tx.account.findUniqueOrThrow({
                  where: { id: toAccountId },
                }),
            ] as const)

          const sourceMutation = await applyAccountBalanceDelta(tx, {
            accountId: data.accountId,
            delta: negateMoney(absMoney(data.amount)),
            familyId,
            notFoundMessage: "Source account not found or access denied!",
          })
          const sourceBalanceAfter = sourceMutation.after.balance

          // Multi-currency: gunakan destinationAmount jika tersedia, fallback ke amount
          const inAmount = data.destinationAmount ?? data.amount
          const inCurrency = data.destinationCurrency ?? data.currency

          const destMutation = await applyAccountBalanceDelta(tx, {
            accountId: toAccountId,
            delta: absMoney(inAmount),
            familyId,
            notFoundMessage: "Destination account not found or access denied!",
          })
          const destBalanceAfter = destMutation.after.balance

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
              toAccountId,
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
              accountId: toAccountId,
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

          const [newSrcAcc, newDstAcc] =
            await runTenantTransactionQueriesInOrder([
              () =>
                tx.account.findUniqueOrThrow({
                  where: { id: data.accountId },
                }),
              () =>
                tx.account.findUniqueOrThrow({
                  where: { id: toAccountId },
                }),
            ] as const)

          await auditLogs(tx, auditCtx, [
            ...accountBalanceAuditEntries(
              [oldSrcAcc, oldDstAcc],
              [newSrcAcc, newDstAcc]
            ),
            ...createdAuditEntries("Transaction", [outflowTx, inflowTx]),
            ...createdAuditEntries("Transfer", [createdTransfer]),
          ])

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

        const [oldAccount, accountMutation] =
          await runTenantTransactionQueriesInOrder([
            () =>
              tx.account.findUniqueOrThrow({
                where: { id: data.accountId },
              }),
            () =>
              applyAccountBalanceDelta(tx, {
                accountId: data.accountId,
                delta: amountSign,
                familyId,
                notFoundMessage: "Account not found or access denied!",
              }),
          ] as const)
        const accountBalanceAfter = accountMutation.after.balance

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
        let createdSplitEntries: Awaited<
          ReturnType<TenantTransactionClient["splitEntry"]["create"]>
        >[] = []
        if (data.isSplit && data.splitEntries?.length) {
          createdSplitEntries = await runTenantTransactionQueriesInOrder(
            data.splitEntries.map(
              (entry) => () =>
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

        await auditLogs(tx, auditCtx, [
          ...accountBalanceAuditEntries([oldAccount], [newAccount]),
          ...createdAuditEntries("Transaction", [newTransaction]),
          ...createdAuditEntries("SplitEntry", createdSplitEntries),
        ])

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
      const transactions = await findLedgerTransactionsForFamily(
        tx,
        context.familyId
      )

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
      let oldTx = await findTransactionAuditGraph(tx, id)

      if (!oldTx) throw new Error("Transaction not found!")

      // PER-20 / ADR-0012: replaying a soft-delete on an already-soft-deleted
      // transaction (or a leg of a transfer whose Transfer is already
      // soft-deleted) is a no-op. We return success without re-reversing
      // balances or writing duplicate audit rows. AGENTS.md § 5.A "Delete
      // Must Be Idempotent". PER-93 will introduce explicit idempotency-key
      // replay semantics; this guard preserves correctness in the meantime.
      if (oldTx.deletedAt !== null) {
        return { success: true }
      }

      // PER-20 / ADR-0012: a transfer is one money movement. If the user
      // clicked the inflow leg, redirect to the outflow leg so the symmetric
      // handler logic below treats outflow as the source of truth. Soft-
      // deleting either leg deletes the entire transfer; there is no
      // "delete one leg only" operation.
      if (oldTx.type === "transfer" && oldTx.transferIn && !oldTx.transferOut) {
        const outflowAuditGraph = await findTransactionAuditGraph(
          tx,
          oldTx.transferIn.outflowTransactionId
        )
        if (!outflowAuditGraph) {
          throw new Error("Transfer outflow leg missing for inflow soft-delete")
        }
        if (outflowAuditGraph.deletedAt !== null) {
          return { success: true }
        }
        oldTx = outflowAuditGraph
      }

      const oldTransferGraph =
        oldTx.type === "transfer" && oldTx.transferOut
          ? await findTransferGraph(tx, oldTx.transferOut.id)
          : null

      // Cari inflow transaction jika ini transfer
      const inflowTx =
        oldTx.type === "transfer" && oldTx.transferOut
          ? await findOptionalTransactionWithSplitEntries(
              tx,
              oldTx.transferOut.inflowTransactionId
            )
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
        await applyAccountBalanceDelta(tx, {
          accountId: oldTx.accountId,
          delta: absMoney(oldTx.amount),
          familyId,
          notFoundMessage: "Source account not found or access denied!",
        })

        if (inflowTx) {
          await applyAccountBalanceDelta(tx, {
            accountId: inflowTx.accountId,
            delta: negateMoney(absMoney(inflowTx.amount)),
            familyId,
            notFoundMessage: "Destination account not found or access denied!",
          })
        }
      } else {
        await applyAccountBalanceDelta(tx, {
          accountId: oldTx.accountId,
          delta: negateMoney(oldTx.amount),
          familyId,
          notFoundMessage: "Account not found or access denied!",
        })
      }

      // 3. SOFT DELETE (GAAP Compliance)
      // PER-20 / ADR-0012: a transfer is one money movement. Soft-deleting
      // either leg also soft-deletes the opposite leg and the Transfer row
      // itself, all in this same `$transaction`. The audit trail of "was
      // money moved? when? who?" survives.
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

        // Soft delete the Transfer shadow row
        await tx.transfer.update({
          where: { id: oldTx.transferOut.id },
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
      ] = await runTenantTransactionQueriesInOrder([
        () => findTransactionWithSplitEntries(tx, oldTx.id),
        () =>
          inflowTx
            ? findTransactionWithSplitEntries(tx, inflowTx.id)
            : Promise.resolve(null),
        () =>
          tx.account.findMany({
            where: { id: { in: affectedAccountIds } },
          }),
        () =>
          oldTransferGraph
            ? findTransferGraph(tx, oldTransferGraph.id)
            : Promise.resolve(null),
      ] as const)

      await auditLogs(tx, auditCtx, [
        ...accountBalanceAuditEntries(oldAccounts, newAccounts),
        {
          action: "soft_delete",
          entityType: "Transaction",
          entityId: oldTx.id,
          before: oldTx,
          after: updatedOutflowTx,
        },
        ...(updatedInflowTx && inflowTx
          ? [
              {
                action: "soft_delete" as const,
                entityType: "Transaction",
                entityId: inflowTx.id,
                before: inflowTx,
                after: updatedInflowTx,
              },
            ]
          : []),
        ...(oldTransferGraph && updatedTransferGraph
          ? [
              {
                action: "soft_delete" as const,
                entityType: "Transfer",
                entityId: oldTransferGraph.id,
                before: oldTransferGraph,
                after: updatedTransferGraph,
              },
            ]
          : []),
      ])

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
      // PER-94: validate updated foreign references before reversal/replace.
      await validateTenantReferences(tx, familyId, {
        accountId: data.accountId,
        toAccountId: data.toAccountId,
        merchantId: data.merchantId,
        categoryId: data.categoryId,
        splitEntries: data.splitEntries,
      })

      assertSplitParity(data)

      // --- FASE 1: REVERSAL (HAPUS LAMA) ---
      // Ambil snapshot graph lengkap sebelum mutasi dilakukan
      const oldTx = await findTransactionAuditGraph(tx, data.id!)

      if (!oldTx) throw new Error("Original transaction not found")

      const oldInflowTx =
        oldTx.type === "transfer" && oldTx.transferOut
          ? await findTransactionWithSplitEntries(
              tx,
              oldTx.transferOut.inflowTransactionId
            )
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
        await applyAccountBalanceDelta(tx, {
          accountId: oldTx.accountId,
          delta: absMoney(oldTx.amount),
          familyId,
          notFoundMessage: "Source account not found or access denied!",
        })
        if (inflowTx) {
          await applyAccountBalanceDelta(tx, {
            accountId: inflowTx.accountId,
            delta: negateMoney(absMoney(inflowTx.amount)),
            familyId,
            notFoundMessage: "Destination account not found or access denied!",
          })
          // PER-20 / ADR-0012: Transfer FK is now ON DELETE RESTRICT. The
          // hard-delete below would fail with a restrict_violation unless we
          // first hard-delete the Transfer row that references both legs.
          // PER-93 will replace this whole reversal-and-replace pattern with
          // soft-delete + new-row; in the meantime, the dependency on the
          // Transfer row is explicit instead of inherited from `Cascade`.
          await tx.transfer.delete({
            where: { id: oldTx.transferOut.id },
          })
          await tx.transaction.delete({ where: { id: inflowTx.id } })
        }
      } else {
        await applyAccountBalanceDelta(tx, {
          accountId: oldTx.accountId,
          delta: negateMoney(oldTx.amount),
          familyId,
          notFoundMessage: "Account not found or access denied!",
        })
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

        const sourceMutation = await applyAccountBalanceDelta(tx, {
          accountId: data.accountId,
          delta: negateMoney(absMoney(data.amount)),
          familyId,
          notFoundMessage: "Source account not found or access denied!",
        })
        const sourceBalanceAfter = sourceMutation.after.balance

        const inAmount = data.destinationAmount ?? data.amount
        const inCurrency = data.destinationCurrency ?? data.currency

        const destMutation = await applyAccountBalanceDelta(tx, {
          accountId: data.toAccountId!,
          delta: absMoney(inAmount),
          familyId,
          notFoundMessage: "Destination account not found or access denied!",
        })
        const destBalanceAfter = destMutation.after.balance

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
        const [newOutflow, newInflow, newAccounts] =
          await runTenantTransactionQueriesInOrder([
            () => findTransactionWithSplitEntries(tx, outflowTx.id),
            () => findTransactionWithSplitEntries(tx, inflowTx.id),
            () =>
              tx.account.findMany({
                where: { id: { in: Array.from(touchedAccountIds) } },
              }),
          ] as const)

        await auditLogs(tx, auditCtx, [
          ...accountBalanceAuditEntries(oldAccounts, newAccounts),
          {
            action: "update",
            entityType: "Transaction",
            entityId: oldTx.id,
            before: oldTx,
            after: newOutflow,
          },
          ...(oldInflowTx
            ? [
                {
                  action: "update" as const,
                  entityType: "Transaction",
                  entityId: oldInflowTx.id,
                  before: oldInflowTx,
                  after: newInflow,
                },
              ]
            : createdAuditEntries("Transaction", [newInflow])),
          oldTransfer
            ? {
                action: "update",
                entityType: "Transfer",
                entityId: oldTransfer.id,
                before: oldTransfer,
                after: createdTransfer,
              }
            : createdAuditEntries("Transfer", [createdTransfer])[0]!,
        ])
      } else {
        const amountSign: Money =
          data.type === "expense"
            ? negateMoney(absMoney(data.amount))
            : absMoney(data.amount)

        const accountMutation = await applyAccountBalanceDelta(tx, {
          accountId: data.accountId,
          delta: amountSign,
          familyId,
          notFoundMessage: "Account not found or access denied!",
        })
        const accountBalanceAfter = accountMutation.after.balance

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

        let createdSplitEntries: Awaited<
          ReturnType<TenantTransactionClient["splitEntry"]["create"]>
        >[] = []
        if (data.isSplit && data.splitEntries?.length) {
          createdSplitEntries = await runTenantTransactionQueriesInOrder(
            data.splitEntries.map(
              (entry) => () =>
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
        const [updatedTx, newAccounts] =
          await runTenantTransactionQueriesInOrder([
            () => findTransactionWithSplitEntries(tx, newTx.id),
            () =>
              tx.account.findMany({
                where: { id: { in: Array.from(touchedAccountIds) } },
              }),
          ] as const)

        await auditLogs(tx, auditCtx, [
          ...accountBalanceAuditEntries(oldAccounts, newAccounts),
          {
            action: "update",
            entityType: "Transaction",
            entityId: oldTx.id,
            before: oldTx,
            after: updatedTx,
          },
          ...oldTx.splitEntries.map((entry) => ({
            action: "delete" as const,
            entityType: "SplitEntry",
            entityId: entry.id,
            before: entry,
            after: null,
          })),
          ...createdAuditEntries("SplitEntry", createdSplitEntries),
          ...(oldInflowTx
            ? [
                {
                  action: "delete" as const,
                  entityType: "Transaction",
                  entityId: oldInflowTx.id,
                  before: oldInflowTx,
                  after: null,
                },
              ]
            : []),
          ...(oldTransfer
            ? [
                {
                  action: "delete" as const,
                  entityType: "Transfer",
                  entityId: oldTransfer.id,
                  before: oldTransfer,
                  after: null,
                },
              ]
            : []),
        ])
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
      const oldTxs = await findTransactionsWithTransferOutAndSplitEntries(
        tx,
        ids
      )

      const inflowTxIds: string[] = []
      const transferIds: string[] = []
      for (const oldTx of oldTxs) {
        if (oldTx.type === "transfer" && oldTx.transferOut) {
          inflowTxIds.push(oldTx.transferOut.inflowTransactionId)
          transferIds.push(oldTx.transferOut.id)
        }
      }

      const oldInflowTxs =
        inflowTxIds.length > 0
          ? await findTransactionsWithSplitEntries(tx, inflowTxIds)
          : []

      const oldTransfers =
        transferIds.length > 0 ? await findTransferGraphs(tx, transferIds) : []

      const touchedAccountIds = new Set(oldTxs.map((t) => t.accountId))
      oldInflowTxs.forEach((t) => touchedAccountIds.add(t.accountId))

      const oldAccounts = await tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      })

      const accountDeltas: AccountDeltaMap = {}
      const oldInflowTxsById = indexById(oldInflowTxs)
      for (const oldTx of oldTxs) {
        if (oldTx.type === "transfer" && oldTx.transferOut) {
          const inflowTx = oldInflowTxsById.get(
            oldTx.transferOut.inflowTransactionId
          )
          addAccountDelta(
            accountDeltas,
            oldTx.accountId,
            absMoney(oldTx.amount)
          )
          if (inflowTx) {
            addAccountDelta(
              accountDeltas,
              inflowTx.accountId,
              negateMoney(absMoney(inflowTx.amount))
            )
          }
        } else if (oldTx.type !== "transfer") {
          if (oldTx.type === "expense") {
            addAccountDelta(
              accountDeltas,
              oldTx.accountId,
              absMoney(oldTx.amount)
            )
          } else if (oldTx.type === "income") {
            addAccountDelta(
              accountDeltas,
              oldTx.accountId,
              negateMoney(absMoney(oldTx.amount))
            )
          }
        }
      }

      if (inflowTxIds.length > 0) {
        await tx.transaction.updateMany({
          where: { id: { in: inflowTxIds } },
          data: { deletedAt: new Date() },
        })
      }

      // 2. Terapkan agregasi delta secara masal
      await applyAccountDeltas(tx, familyId, accountDeltas)

      // 3. Soft delete
      await tx.transaction.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      })

      // PER-20 / ADR-0012: soft-delete the Transfer shadow rows so the
      // money-movement audit trail survives. Symmetry with the single-path
      // handler above.
      if (transferIds.length > 0) {
        await tx.transfer.updateMany({
          where: { id: { in: transferIds } },
          data: { deletedAt: new Date() },
        })
      }

      // Re-read data terbaru setelah mutasi
      const [newOutflowTxs, newInflowTxs, newAccounts, newTransfers] =
        await runTenantTransactionQueriesInOrder([
          () => findTransactionsWithSplitEntries(tx, ids),
          () =>
            inflowTxIds.length > 0
              ? findTransactionsWithSplitEntries(tx, inflowTxIds)
              : Promise.resolve([]),
          () =>
            tx.account.findMany({
              where: { id: { in: Array.from(touchedAccountIds) } },
            }),
          () =>
            oldTransfers.length > 0
              ? findTransferGraphs(
                  tx,
                  oldTransfers.map((transfer) => transfer.id)
                )
              : Promise.resolve([]),
        ] as const)

      await auditLogs(tx, auditCtx, [
        ...accountBalanceAuditEntries(oldAccounts, newAccounts),
        ...pairedAuditEntries({
          action: "soft_delete",
          beforeItems: oldTxs,
          afterItems: newOutflowTxs,
          entityType: "Transaction",
        }),
        ...pairedAuditEntries({
          action: "soft_delete",
          beforeItems: oldInflowTxs,
          afterItems: newInflowTxs,
          entityType: "Transaction",
        }),
        ...pairedAuditEntries({
          action: "soft_delete",
          beforeItems: oldTransfers,
          afterItems: newTransfers,
          entityType: "Transfer",
        }),
      ])

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
      // PER-94: validate every patched reference before any balance shift.
      await validateTenantReferences(tx, familyId, {
        accountId: data.accountId,
        merchantId: data.merchantId,
        categoryId: data.categoryId,
      })

      // Ambil data before
      const oldTxs = await findTransactionsWithSplitEntries(tx, data.ids)

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

        const accountDeltas: AccountDeltaMap = {}
        for (const t of txsToMove) {
          const magnitude = absMoney(t.amount)
          const refundSigned: bigint =
            t.type === "expense" ? magnitude : negateMoney(magnitude)
          const chargeSigned: bigint =
            t.type === "expense" ? negateMoney(magnitude) : magnitude

          addAccountDelta(accountDeltas, t.accountId, refundSigned)
          addAccountDelta(accountDeltas, data.accountId, chargeSigned)
        }

        await applyAccountDeltas(tx, familyId, accountDeltas)
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
      const [newTxs, newAccounts] = await runTenantTransactionQueriesInOrder([
        () => findTransactionsWithSplitEntries(tx, data.ids),
        () =>
          tx.account.findMany({
            where: { id: { in: Array.from(touchedAccountIds) } },
          }),
      ] as const)

      await auditLogs(tx, auditCtx, [
        ...accountBalanceAuditEntries(oldAccounts, newAccounts),
        ...pairedAuditEntries({
          action: "update",
          beforeItems: oldTxs,
          afterItems: newTxs,
          entityType: "Transaction",
        }),
      ])

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
      // PER-94: validate every distinct reference across the batch before any
      // row is created. Walk the batch with explicit indexes so the reported
      // field path tells the client which row carried the offending id.
      //
      await runTenantTransactionQueriesInOrder(
        data.transactions.map(
          (row, index) => () =>
            validateTenantReferences(tx, familyId, {
              accountId: row.accountId,
              merchantId: row.merchantId,
              categoryId: row.categoryId,
            }).catch((error: unknown) => {
              if (error instanceof TenantReferenceError) {
                throw new TenantReferenceError(
                  `transactions[${index}].${error.field}`,
                  error.referenceId,
                  error.familyId
                )
              }
              throw error
            })
        )
      )

      // Ambil data akun-akun terpengaruh sebelum mutasi
      const touchedAccountIds = new Set(
        data.transactions.map((t) => t.accountId)
      )
      const oldAccounts = await tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      })

      const transactionIds = data.transactions.map((t) => t.id)
      const accountDeltas: AccountDeltaMap = {}
      const rows = data.transactions.map((t) => {
        const signedAmount = signedIncomeExpenseAmount(t.type, t.amount)
        addAccountDelta(accountDeltas, t.accountId, signedAmount)

        return {
          id: t.id,
          userId: user.id,
          familyId,
          type: t.type,
          amount: signedAmount,
          description: t.description,
          accountId: t.accountId,
          categoryId: t.categoryId,
          merchantId: t.merchantId,
          date: t.date,
          notes: t.notes,
          status: t.status,
          attachmentUrl: t.attachmentUrl,
        }
      })

      await tx.transaction.createMany({ data: rows })
      await applyAccountDeltas(tx, familyId, accountDeltas)
      const [newTxs, newAccounts] = await runTenantTransactionQueriesInOrder([
        () => findTransactionsWithSplitEntries(tx, transactionIds),
        () =>
          tx.account.findMany({
            where: { id: { in: Array.from(touchedAccountIds) } },
          }),
      ] as const)
      await auditLogs(tx, auditCtx, [
        ...accountBalanceAuditEntries(oldAccounts, newAccounts),
        ...createdAuditEntries("Transaction", newTxs),
      ])

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
