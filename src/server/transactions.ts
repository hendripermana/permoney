import { createServerFn } from "@tanstack/react-start"
import type { Prisma } from "@prisma/client"
import { z } from "zod"
import {
  deriveTransferKindForAccounts,
  isLiabilityCostKind,
  parseAccountType,
  TRANSACTION_KIND_VALUES,
} from "@/lib/liability-semantics"
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
  type AuditContext,
  type AuditLogEntry,
} from "./middleware/audit"
import {
  TenantReferenceError,
  validateTenantReferences,
} from "./validation/tenant-references"
import { VersionDriftError } from "./middleware/with-retry"
import {
  IDEMPOTENCY_RECORD_TTL_MS,
  IdempotencyConflictError,
  hashCanonicalPayload,
  toCanonicalJson,
} from "./idempotency"

export { IdempotencyConflictError } from "./idempotency"

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

function accountListRelation(account: {
  accountType: string
  color: string | null
  name: string
}) {
  return {
    accountType: account.accountType,
    color: account.color,
    name: account.name,
    type: account.accountType,
  }
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
              select: { id: true, name: true, accountType: true, color: true },
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
  kind: z.enum(TRANSACTION_KIND_VALUES).optional().default("standard"),
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

const updateTransactionTransportInputSchema = transactionInputSchema.extend({
  id: z.string().min(1),
  idempotencyKey: uuidV7Schema.optional(),
})

const updateTransactionInputSchema =
  updateTransactionTransportInputSchema.required({
    idempotencyKey: true,
  })

const deleteTransactionTransportInputSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: uuidV7Schema.optional(),
})

const deleteTransactionInputSchema =
  deleteTransactionTransportInputSchema.required({
    idempotencyKey: true,
  })

const bulkTransactionRowInputSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: uuidV7Schema,
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

const bulkCreateTransactionsTransportInputSchema = z.object({
  idempotencyKey: uuidV7Schema.optional(),
  transactions: z.array(bulkTransactionRowInputSchema),
})

const bulkCreateTransactionsInputSchema =
  bulkCreateTransactionsTransportInputSchema.required({
    idempotencyKey: true,
  })

const bulkUpdateTransactionsTransportInputSchema = z.object({
  ids: z.array(z.string().min(1)),
  idempotencyKey: uuidV7Schema.optional(),
  categoryId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
  accountId: z.string().optional(),
})

const bulkUpdateTransactionsInputSchema =
  bulkUpdateTransactionsTransportInputSchema.required({
    idempotencyKey: true,
  })

const bulkDeleteTransactionsTransportInputSchema = z.object({
  ids: z.array(z.string().min(1)),
  idempotencyKey: uuidV7Schema.optional(),
})

const bulkDeleteTransactionsInputSchema =
  bulkDeleteTransactionsTransportInputSchema.required({
    idempotencyKey: true,
  })

type CreateTransactionInput = z.infer<typeof createTransactionInputSchema>
type UpdateTransactionInput = z.infer<typeof updateTransactionInputSchema>
type DeleteTransactionInput = z.infer<typeof deleteTransactionInputSchema>
type BulkCreateTransactionsInput = z.infer<
  typeof bulkCreateTransactionsInputSchema
>
type BulkUpdateTransactionsInput = z.infer<
  typeof bulkUpdateTransactionsInputSchema
>
type BulkDeleteTransactionsInput = z.infer<
  typeof bulkDeleteTransactionsInputSchema
>
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

export class TransactionGoneError extends Error {
  statusCode = 410

  constructor(message = "Transaction has been deleted and cannot be mutated") {
    super(message)
    this.name = "TransactionGoneError"
  }
}

function assertManualTransactionKindShape(data: {
  kind: string
  toAccountId?: string | null
  type: "expense" | "income" | "transfer"
}): void {
  if (data.type === "transfer") {
    if (data.kind !== "standard") {
      throw new Error("Transfer kind is derived from account direction")
    }
    return
  }

  if (
    data.type === "income" &&
    !["standard", "balance_adjustment"].includes(data.kind)
  ) {
    throw new Error("Income transactions must use kind standard")
  }

  if (
    data.type === "expense" &&
    ![
      "standard",
      "liability_interest",
      "liability_fee",
      "balance_adjustment",
    ].includes(data.kind)
  ) {
    throw new Error(`Expense transactions cannot use kind ${data.kind}`)
  }

  if (isLiabilityCostKind(data.kind) && !data.toAccountId) {
    throw new Error(`${data.kind} requires a liability toAccountId`)
  }
}

async function assertLiabilityCostTarget(
  tx: TenantTransactionClient,
  familyId: string,
  data: {
    kind: string
    toAccountId?: string | null
  }
): Promise<void> {
  if (!isLiabilityCostKind(data.kind)) return

  const target = await tx.account.findFirst({
    where: { familyId, id: data.toAccountId ?? "" },
    select: { accountClass: true, id: true },
  })

  if (!target || target.accountClass !== "LIABILITY") {
    throw new Error(`${data.kind} must point at a liability account`)
  }
}

const UPDATE_TRANSACTION_ENDPOINT = "updateTransactionFn"
const DELETE_TRANSACTION_ENDPOINT = "deleteTransactionFn"
const BULK_CREATE_TRANSACTIONS_ENDPOINT = "bulkCreateTransactionsFn"
const BULK_UPDATE_TRANSACTIONS_ENDPOINT = "bulkUpdateTransactionsFn"
const BULK_DELETE_TRANSACTIONS_ENDPOINT = "bulkDeleteTransactionsFn"

type IdempotentMutationEndpoint =
  | typeof UPDATE_TRANSACTION_ENDPOINT
  | typeof DELETE_TRANSACTION_ENDPOINT
  | typeof BULK_CREATE_TRANSACTIONS_ENDPOINT
  | typeof BULK_UPDATE_TRANSACTIONS_ENDPOINT
  | typeof BULK_DELETE_TRANSACTIONS_ENDPOINT

interface SerializedTransactionResult {
  id: string
}

interface BulkUpdateReplacementResult {
  id: string
  replacementId: string
}

interface BulkCreateTransactionsResult {
  count: number
  success: boolean
  transactionIds: string[]
}

interface BulkUpdateTransactionsResult {
  replacements: BulkUpdateReplacementResult[]
  success: boolean
}

interface BulkDeleteTransactionsResult {
  count: number
  success: boolean
}

async function replayIdempotentEndpointResponse<TResponse>(
  tx: TenantTransactionClient,
  {
    endpoint,
    familyId,
    key,
    requestHash,
  }: {
    endpoint: IdempotentMutationEndpoint
    familyId: string
    key: string
    requestHash: string
  }
): Promise<TResponse | null> {
  const record = await tx.idempotencyRecord.findUnique({
    where: {
      familyId_endpoint_key: {
        endpoint,
        familyId,
        key,
      },
    },
  })
  if (!record) return null
  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError()
  }
  return record.responseJson as TResponse
}

async function persistIdempotentEndpointResponse(
  tx: TenantTransactionClient,
  {
    endpoint,
    familyId,
    key,
    requestHash,
    response,
  }: {
    endpoint: IdempotentMutationEndpoint
    familyId: string
    key: string
    requestHash: string
    response: unknown
  }
): Promise<void> {
  await tx.idempotencyRecord.create({
    data: {
      endpoint,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_RECORD_TTL_MS),
      familyId,
      key,
      requestHash,
      responseJson: toCanonicalJson(response) as Prisma.InputJsonValue,
      statusCode: 200,
    },
  })
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
    kind: data.type === "transfer" ? null : data.kind,
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

function canonicalUpdateRequestPayload(data: UpdateTransactionInput) {
  return {
    id: data.id,
    replacement: canonicalRequestPayload(data),
  }
}

function canonicalDeleteRequestPayload(data: DeleteTransactionInput) {
  return { id: data.id }
}

function canonicalBulkCreateRequestPayload(data: BulkCreateTransactionsInput) {
  return {
    transactions: data.transactions
      .map((row) => ({
        accountId: row.accountId,
        amount: encodeMoney(absMoney(row.amount)),
        attachmentUrl: row.attachmentUrl ?? null,
        categoryId: row.categoryId ?? null,
        date: row.date.toISOString(),
        description: row.description,
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        merchantId: row.merchantId ?? null,
        notes: row.notes ?? null,
        status: row.status,
        type: row.type,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function canonicalBulkUpdateRequestPayload(data: BulkUpdateTransactionsInput) {
  const patch: Record<string, unknown> = {}
  if (data.accountId !== undefined) patch.accountId = data.accountId
  if (data.categoryId !== undefined) patch.categoryId = data.categoryId
  if (data.merchantId !== undefined) patch.merchantId = data.merchantId

  return {
    ids: canonicalIds(data.ids),
    patch,
  }
}

function canonicalBulkDeleteRequestPayload(data: BulkDeleteTransactionsInput) {
  return { ids: canonicalIds(data.ids) }
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right))
}

function assertNoDuplicateValues(
  values: readonly string[],
  label: string
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} must not contain duplicate values`)
    }
    seen.add(value)
  }
}

function assertAllRequestedTransactionsLoaded(
  requestedIds: readonly string[],
  loadedRows: readonly { id: string }[]
): void {
  const loadedIds = new Set(loadedRows.map((row) => row.id))
  const missingId = requestedIds.find((id) => !loadedIds.has(id))
  if (missingId) {
    throw new Error("Transaction not found or access denied")
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
    kind: tx.type === "transfer" ? null : tx.kind,
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

async function normalizeUpdateTransactionTransportInput(
  data: z.infer<typeof updateTransactionTransportInputSchema>
): Promise<UpdateTransactionInput> {
  const rawHeaderKey = await readIdempotencyHeader()
  const headerKey =
    rawHeaderKey == null ? null : uuidV7Schema.parse(rawHeaderKey)
  if (headerKey && data.idempotencyKey && headerKey !== data.idempotencyKey) {
    throw new Error("Idempotency-Key header does not match idempotencyKey")
  }

  return updateTransactionInputSchema.parse({
    ...data,
    idempotencyKey: headerKey ?? data.idempotencyKey,
  })
}

async function normalizeDeleteTransactionTransportInput(
  data: z.infer<typeof deleteTransactionTransportInputSchema>
): Promise<DeleteTransactionInput> {
  const rawHeaderKey = await readIdempotencyHeader()
  const headerKey =
    rawHeaderKey == null ? null : uuidV7Schema.parse(rawHeaderKey)
  if (headerKey && data.idempotencyKey && headerKey !== data.idempotencyKey) {
    throw new Error("Idempotency-Key header does not match idempotencyKey")
  }

  return deleteTransactionInputSchema.parse({
    ...data,
    idempotencyKey: headerKey ?? data.idempotencyKey,
  })
}

async function normalizeBulkCreateTransactionsTransportInput(
  data: z.infer<typeof bulkCreateTransactionsTransportInputSchema>
): Promise<BulkCreateTransactionsInput> {
  const rawHeaderKey = await readIdempotencyHeader()
  const headerKey =
    rawHeaderKey == null ? null : uuidV7Schema.parse(rawHeaderKey)
  if (headerKey && data.idempotencyKey && headerKey !== data.idempotencyKey) {
    throw new Error("Idempotency-Key header does not match idempotencyKey")
  }

  return bulkCreateTransactionsInputSchema.parse({
    ...data,
    idempotencyKey: headerKey ?? data.idempotencyKey,
  })
}

async function normalizeBulkUpdateTransactionsTransportInput(
  data: z.infer<typeof bulkUpdateTransactionsTransportInputSchema>
): Promise<BulkUpdateTransactionsInput> {
  const rawHeaderKey = await readIdempotencyHeader()
  const headerKey =
    rawHeaderKey == null ? null : uuidV7Schema.parse(rawHeaderKey)
  if (headerKey && data.idempotencyKey && headerKey !== data.idempotencyKey) {
    throw new Error("Idempotency-Key header does not match idempotencyKey")
  }

  return bulkUpdateTransactionsInputSchema.parse({
    ...data,
    idempotencyKey: headerKey ?? data.idempotencyKey,
  })
}

async function normalizeBulkDeleteTransactionsTransportInput(
  data: z.infer<typeof bulkDeleteTransactionsTransportInputSchema>
): Promise<BulkDeleteTransactionsInput> {
  const rawHeaderKey = await readIdempotencyHeader()
  const headerKey =
    rawHeaderKey == null ? null : uuidV7Schema.parse(rawHeaderKey)
  if (headerKey && data.idempotencyKey && headerKey !== data.idempotencyKey) {
    throw new Error("Idempotency-Key header does not match idempotencyKey")
  }

  return bulkDeleteTransactionsInputSchema.parse({
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
        assertManualTransactionKindShape(data)

        // A. HANDLE TRANSFER (DOUBLE-ENTRY)
        if (data.type === "transfer") {
          if (!data.toAccountId)
            throw new Error("Transfer requires a destination account!")
          const toAccountId = data.toAccountId

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
          const kind = deriveTransferKindForAccounts({
            fromAccountType: parseAccountType(oldSrcAcc.accountType),
            toAccountType: parseAccountType(oldDstAcc.accountType),
          })

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
        await assertLiabilityCostTarget(tx, familyId, data)
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
            kind: data.kind,
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

async function softDeleteTransactionWithinTenantTransaction(
  tx: TenantTransactionClient,
  {
    auditCtx,
    familyId,
    id,
  }: {
    auditCtx: AuditContext
    familyId: string
    id: string
  }
): Promise<void> {
  // 1. Cari transaksi lama beserta relasi transfernya dan split entries.
  let oldTx = await findTransactionAuditGraph(tx, id)

  if (!oldTx) throw new Error("Transaction not found!")

  if (oldTx.deletedAt !== null) {
    throw new TransactionGoneError()
  }

  // PER-20 / ADR-0012: a transfer is one money movement. If the user clicked
  // the inflow leg, redirect to the outflow leg so the symmetric handler logic
  // below treats outflow as the source of truth.
  if (oldTx.type === "transfer" && oldTx.transferIn && !oldTx.transferOut) {
    const outflowAuditGraph = await findTransactionAuditGraph(
      tx,
      oldTx.transferIn.outflowTransactionId
    )
    if (!outflowAuditGraph) {
      throw new Error("Transfer outflow leg missing for inflow soft-delete")
    }
    if (outflowAuditGraph.deletedAt !== null) {
      throw new TransactionGoneError()
    }
    oldTx = outflowAuditGraph
  }

  const oldTransferGraph =
    oldTx.type === "transfer" && oldTx.transferOut
      ? await findTransferGraph(tx, oldTx.transferOut.id)
      : null
  if (oldTransferGraph?.deletedAt !== null && oldTransferGraph) {
    throw new TransactionGoneError()
  }

  const inflowTx =
    oldTx.type === "transfer" && oldTx.transferOut
      ? await findOptionalTransactionWithSplitEntries(
          tx,
          oldTx.transferOut.inflowTransactionId
        )
      : null

  const affectedAccountIds = [oldTx.accountId]
  if (inflowTx) {
    affectedAccountIds.push(inflowTx.accountId)
  }
  const oldAccounts = await tx.account.findMany({
    where: { id: { in: affectedAccountIds } },
  })

  // 2. Reverse balances exactly once inside the caller transaction.
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

  const deletedAt = new Date()
  if (oldTx.type === "transfer" && oldTx.transferOut && inflowTx) {
    const outflowUpdate = await tx.transaction.updateMany({
      where: { id: oldTx.id, familyId, deletedAt: null },
      data: { deletedAt },
    })
    if (outflowUpdate.count !== 1) throw new TransactionGoneError()

    const inflowUpdate = await tx.transaction.updateMany({
      where: { id: inflowTx.id, familyId, deletedAt: null },
      data: { deletedAt },
    })
    if (inflowUpdate.count !== 1) throw new TransactionGoneError()

    const transferUpdate = await tx.transfer.updateMany({
      where: { id: oldTx.transferOut.id, deletedAt: null },
      data: { deletedAt },
    })
    if (transferUpdate.count !== 1) throw new TransactionGoneError()
  } else {
    const update = await tx.transaction.updateMany({
      where: { id: oldTx.id, familyId, deletedAt: null },
      data: { deletedAt },
    })
    if (update.count !== 1) throw new TransactionGoneError()
  }

  const [updatedOutflowTx, updatedInflowTx, newAccounts, updatedTransferGraph] =
    await runTenantTransactionQueriesInOrder([
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
}

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
  idempotencyKey,
  familyId,
  user,
}: {
  id: string
  idempotencyKey: string
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const data = deleteTransactionInputSchema.parse({ id, idempotencyKey })
  const requestHash = await hashCanonicalPayload(
    canonicalDeleteRequestPayload(data)
  )
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const deleteOrReplay = async () =>
    await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay = await replayIdempotentEndpointResponse<{
          success: boolean
        }>(tx, {
          endpoint: DELETE_TRANSACTION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
        if (replay) return replay

        await softDeleteTransactionWithinTenantTransaction(tx, {
          auditCtx,
          familyId,
          id: data.id,
        })

        const response = { success: true }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: DELETE_TRANSACTION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })

        return response
      }
    )

  try {
    return await deleteOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const replay = await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) =>
        await replayIdempotentEndpointResponse<{ success: boolean }>(tx, {
          endpoint: DELETE_TRANSACTION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay

    throw error
  }
}

/**
 * BACKEND FUNCTION: Delete Transaction (Soft Delete — GAAP Compliance)
 * Transaksi tidak pernah benar-benar dihapus; hanya ditandai dengan deletedAt.
 */
export const deleteTransactionFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    (data: z.input<typeof deleteTransactionTransportInputSchema>) =>
      deleteTransactionTransportInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const normalized = await normalizeDeleteTransactionTransportInput(data)
    return await deleteTransactionForFamily({
      id: normalized.id,
      idempotencyKey: normalized.idempotencyKey,
      familyId: context.familyId,
      user: context.user,
    })
  })

async function replaceTransactionWithinTenantTransaction(
  tx: TenantTransactionClient,
  {
    auditCtx,
    data,
    familyId,
    user,
  }: {
    auditCtx: AuditContext
    data: UpdateTransactionInput
    familyId: string
    user: { id: string; familyId?: string | null }
  }
): Promise<SerializedTransactionResult> {
  // PER-94: validate updated foreign references before reversal/replace.
  await validateTenantReferences(tx, familyId, {
    accountId: data.accountId,
    toAccountId: data.toAccountId,
    merchantId: data.merchantId,
    categoryId: data.categoryId,
    splitEntries: data.splitEntries,
  })

  assertSplitParity(data)
  assertManualTransactionKindShape(data)

  // Ambil snapshot graph lengkap sebelum mutasi dilakukan.
  let oldTx = await findTransactionAuditGraph(tx, data.id)

  if (!oldTx) throw new Error("Original transaction not found")
  if (oldTx.deletedAt !== null) throw new TransactionGoneError()

  if (oldTx.type === "transfer" && oldTx.transferIn && !oldTx.transferOut) {
    const outflowAuditGraph = await findTransactionAuditGraph(
      tx,
      oldTx.transferIn.outflowTransactionId
    )
    if (!outflowAuditGraph) {
      throw new Error("Transfer outflow leg missing for update")
    }
    if (outflowAuditGraph.deletedAt !== null) {
      throw new TransactionGoneError()
    }
    oldTx = outflowAuditGraph
  }

  const oldInflowTx =
    oldTx.type === "transfer" && oldTx.transferOut
      ? await findTransactionWithSplitEntries(
          tx,
          oldTx.transferOut.inflowTransactionId
        )
      : null
  const oldTransferGraph =
    oldTx.type === "transfer" && oldTx.transferOut
      ? await findTransferGraph(tx, oldTx.transferOut.id)
      : null
  if (oldTransferGraph?.deletedAt !== null && oldTransferGraph) {
    throw new TransactionGoneError()
  }

  // Kumpulkan semua akun yang terpengaruh (sebelum dan sesudah).
  const touchedAccountIds = new Set([oldTx.accountId, data.accountId])
  if (oldInflowTx) touchedAccountIds.add(oldInflowTx.accountId)
  if (data.toAccountId) touchedAccountIds.add(data.toAccountId)

  const oldAccounts = await tx.account.findMany({
    where: { id: { in: Array.from(touchedAccountIds) } },
  })

  const accountDeltas: AccountDeltaMap = {}
  if (oldTx.type === "transfer" && oldTx.transferOut) {
    if (!oldInflowTx) {
      throw new Error("Transfer inflow leg missing for update")
    }
    addAccountDelta(accountDeltas, oldTx.accountId, absMoney(oldTx.amount))
    addAccountDelta(
      accountDeltas,
      oldInflowTx.accountId,
      negateMoney(absMoney(oldInflowTx.amount))
    )
  } else {
    addAccountDelta(accountDeltas, oldTx.accountId, negateMoney(oldTx.amount))
  }

  let resultTransaction: Awaited<
    ReturnType<TenantTransactionClient["transaction"]["create"]>
  >
  let createdInflowTx: Awaited<
    ReturnType<TenantTransactionClient["transaction"]["create"]>
  > | null = null
  let createdTransfer: Awaited<
    ReturnType<TenantTransactionClient["transfer"]["create"]>
  > | null = null
  let createdSplitEntries: Awaited<
    ReturnType<TenantTransactionClient["splitEntry"]["create"]>
  >[] = []

  if (data.type === "transfer") {
    if (!data.toAccountId)
      throw new Error("Transfer requires a destination account!")
    const toAccountId = data.toAccountId
    const fromAccount = oldAccounts.find(
      (account) => account.id === data.accountId
    )
    const toAccount = oldAccounts.find((account) => account.id === toAccountId)
    if (!fromAccount)
      throw new Error("Source account not found or access denied!")
    if (!toAccount)
      throw new Error("Destination account not found or access denied!")
    const kind = deriveTransferKindForAccounts({
      fromAccountType: parseAccountType(fromAccount.accountType),
      toAccountType: parseAccountType(toAccount.accountType),
    })

    const inAmount = data.destinationAmount ?? data.amount
    const inCurrency = data.destinationCurrency ?? data.currency

    addAccountDelta(
      accountDeltas,
      data.accountId,
      negateMoney(absMoney(data.amount))
    )
    addAccountDelta(accountDeltas, toAccountId, absMoney(inAmount))
    await applyAccountDeltas(tx, familyId, accountDeltas)

    const sourceBalanceAfter = (
      await findAccountBalanceVersion(
        tx,
        data.accountId,
        familyId,
        "Source account not found or access denied!"
      )
    ).balance
    const destBalanceAfter = (
      await findAccountBalanceVersion(
        tx,
        toAccountId,
        familyId,
        "Destination account not found or access denied!"
      )
    ).balance

    const outflowTx = await tx.transaction.create({
      data: {
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
        supersedes: oldTx.id,
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
        ...(oldInflowTx ? { supersedes: oldInflowTx.id } : {}),
      },
    })

    createdTransfer = await tx.transfer.create({
      data: {
        outflowTransactionId: outflowTx.id,
        inflowTransactionId: inflowTx.id,
      },
    })

    resultTransaction = outflowTx
    createdInflowTx = inflowTx
  } else {
    await assertLiabilityCostTarget(tx, familyId, data)
    const amountSign: Money =
      data.type === "expense"
        ? negateMoney(absMoney(data.amount))
        : absMoney(data.amount)

    addAccountDelta(accountDeltas, data.accountId, amountSign)
    await applyAccountDeltas(tx, familyId, accountDeltas)
    const accountBalanceAfter = (
      await findAccountBalanceVersion(
        tx,
        data.accountId,
        familyId,
        "Account not found or access denied!"
      )
    ).balance

    const newTx = await tx.transaction.create({
      data: {
        type: data.type,
        kind: data.kind,
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
        supersedes: oldTx.id,
      },
    })

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
  }

  const deletedAt = new Date()
  const outflowUpdate = await tx.transaction.updateMany({
    where: { id: oldTx.id, familyId, deletedAt: null },
    data: { deletedAt, supersededBy: resultTransaction.id },
  })
  if (outflowUpdate.count !== 1) throw new TransactionGoneError()

  if (oldInflowTx) {
    const inflowUpdate = await tx.transaction.updateMany({
      where: { id: oldInflowTx.id, familyId, deletedAt: null },
      data: {
        deletedAt,
        ...(createdInflowTx ? { supersededBy: createdInflowTx.id } : {}),
      },
    })
    if (inflowUpdate.count !== 1) throw new TransactionGoneError()
  }

  if (oldTransferGraph) {
    const transferUpdate = await tx.transfer.updateMany({
      where: { id: oldTransferGraph.id, deletedAt: null },
      data: { deletedAt },
    })
    if (transferUpdate.count !== 1) throw new TransactionGoneError()
  }

  const [
    updatedOldOutflow,
    updatedOldInflow,
    newOutflow,
    newInflow,
    updatedOldTransfer,
    newTransferGraph,
    newAccounts,
  ] = await runTenantTransactionQueriesInOrder([
    () => findTransactionWithSplitEntries(tx, oldTx.id),
    () =>
      oldInflowTx
        ? findTransactionWithSplitEntries(tx, oldInflowTx.id)
        : Promise.resolve(null),
    () => findTransactionWithSplitEntries(tx, resultTransaction.id),
    () =>
      createdInflowTx
        ? findTransactionWithSplitEntries(tx, createdInflowTx.id)
        : Promise.resolve(null),
    () =>
      oldTransferGraph
        ? findTransferGraph(tx, oldTransferGraph.id)
        : Promise.resolve(null),
    () =>
      createdTransfer
        ? findTransferGraph(tx, createdTransfer.id)
        : Promise.resolve(null),
    () =>
      tx.account.findMany({
        where: { id: { in: Array.from(touchedAccountIds) } },
      }),
  ] as const)

  await auditLogs(tx, auditCtx, [
    ...accountBalanceAuditEntries(oldAccounts, newAccounts),
    {
      action: "soft_delete",
      entityType: "Transaction",
      entityId: oldTx.id,
      before: oldTx,
      after: updatedOldOutflow,
    },
    ...(oldInflowTx && updatedOldInflow
      ? [
          {
            action: "soft_delete" as const,
            entityType: "Transaction",
            entityId: oldInflowTx.id,
            before: oldInflowTx,
            after: updatedOldInflow,
          },
        ]
      : []),
    ...(oldTransferGraph && updatedOldTransfer
      ? [
          {
            action: "soft_delete" as const,
            entityType: "Transfer",
            entityId: oldTransferGraph.id,
            before: oldTransferGraph,
            after: updatedOldTransfer,
          },
        ]
      : []),
    ...createdAuditEntries("Transaction", [
      newOutflow,
      ...(newInflow ? [newInflow] : []),
    ]),
    ...(newTransferGraph
      ? createdAuditEntries("Transfer", [newTransferGraph])
      : []),
    ...createdAuditEntries("SplitEntry", createdSplitEntries),
  ])

  return serializeTransaction({
    ...resultTransaction,
    amount: absMoney(resultTransaction.amount),
  })
}

export async function updateTransactionForFamily({
  data: rawData,
  familyId,
  user,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const data = updateTransactionInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload(
    canonicalUpdateRequestPayload(data)
  )
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const updateOrReplay = async () =>
    await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay =
          await replayIdempotentEndpointResponse<SerializedTransactionResult>(
            tx,
            {
              endpoint: UPDATE_TRANSACTION_ENDPOINT,
              familyId,
              key: data.idempotencyKey,
              requestHash,
            }
          )
        if (replay) return replay

        const response = await replaceTransactionWithinTenantTransaction(tx, {
          auditCtx,
          data,
          familyId,
          user,
        })

        await persistIdempotentEndpointResponse(tx, {
          endpoint: UPDATE_TRANSACTION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })

        return response
      }
    )

  try {
    return await updateOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const replay = await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) =>
        await replayIdempotentEndpointResponse<SerializedTransactionResult>(
          tx,
          {
            endpoint: UPDATE_TRANSACTION_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
    )
    if (replay) return replay

    throw error
  }
}

/**
 * BACKEND FUNCTION: Update Transaction (soft-delete + new-row supersession)
 */
export const updateTransactionFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    (data: z.input<typeof updateTransactionTransportInputSchema>) =>
      updateTransactionTransportInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const normalized = await normalizeUpdateTransactionTransportInput(data)
    return await updateTransactionForFamily({
      data: normalized,
      familyId: context.familyId,
      user: context.user,
    })
  })

type BulkUpdateSourceTransaction = Awaited<
  ReturnType<typeof findTransactionsWithTransferOutAndSplitEntries>
>[number]

function assertNoDeletedTransactionTargets(
  transactions: readonly { deletedAt: Date | null }[]
): void {
  if (transactions.some((transaction) => transaction.deletedAt !== null)) {
    throw new TransactionGoneError()
  }
}

function hasBulkUpdatePatch(data: BulkUpdateTransactionsInput): boolean {
  return (
    data.accountId !== undefined ||
    data.categoryId !== undefined ||
    data.merchantId !== undefined
  )
}

function buildBulkUpdateReplacementInput(
  transaction: BulkUpdateSourceTransaction,
  data: BulkUpdateTransactionsInput
): UpdateTransactionInput {
  const patchedSplitEntries = transaction.isSplit
    ? transaction.splitEntries.map((entry) => ({
        amount: absMoney(entry.amount),
        categoryId:
          data.categoryId !== undefined ? data.categoryId : entry.categoryId,
        description: entry.description,
        merchantId:
          data.merchantId !== undefined ? data.merchantId : entry.merchantId,
      }))
    : []

  return updateTransactionInputSchema.parse({
    accountId: data.accountId ?? transaction.accountId,
    amount: absMoney(transaction.amount),
    attachmentUrl: transaction.attachmentUrl,
    categoryId: transaction.isSplit
      ? null
      : data.categoryId !== undefined
        ? data.categoryId
        : transaction.categoryId,
    currency: transaction.currency,
    date: transaction.date,
    description: transaction.description,
    destinationAmount:
      transaction.destinationAmount == null
        ? null
        : absMoney(transaction.destinationAmount),
    destinationCurrency: transaction.destinationCurrency,
    id: transaction.id,
    idempotencyKey: data.idempotencyKey,
    isSplit: transaction.isSplit,
    merchantId: transaction.isSplit
      ? null
      : data.merchantId !== undefined
        ? data.merchantId
        : transaction.merchantId,
    notes: transaction.notes,
    splitEntries: patchedSplitEntries,
    status: transaction.status,
    toAccountId: transaction.toAccountId,
    type: transaction.type,
  })
}

export async function bulkDeleteTransactionsForFamily({
  ids,
  idempotencyKey,
  familyId,
  user,
}: {
  ids: string[]
  idempotencyKey: string
  familyId: string
  user: { id: string; familyId?: string | null }
}): Promise<BulkDeleteTransactionsResult> {
  const data = bulkDeleteTransactionsInputSchema.parse({ ids, idempotencyKey })
  assertNoDuplicateValues(data.ids, "bulk delete ids")
  const requestHash = await hashCanonicalPayload(
    canonicalBulkDeleteRequestPayload(data)
  )
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const deleteOrReplay = async () =>
    await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay =
          await replayIdempotentEndpointResponse<BulkDeleteTransactionsResult>(
            tx,
            {
              endpoint: BULK_DELETE_TRANSACTIONS_ENDPOINT,
              familyId,
              key: data.idempotencyKey,
              requestHash,
            }
          )
        if (replay) return replay

        const targets = await findTransactionsWithTransferOutAndSplitEntries(
          tx,
          data.ids
        )
        assertAllRequestedTransactionsLoaded(data.ids, targets)
        assertNoDeletedTransactionTargets(targets)

        for (const id of data.ids) {
          await softDeleteTransactionWithinTenantTransaction(tx, {
            auditCtx,
            familyId,
            id,
          })
        }

        const response = { count: data.ids.length, success: true }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: BULK_DELETE_TRANSACTIONS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })

        return response
      }
    )

  try {
    return await deleteOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const replay = await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) =>
        await replayIdempotentEndpointResponse<BulkDeleteTransactionsResult>(
          tx,
          {
            endpoint: BULK_DELETE_TRANSACTIONS_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
    )
    if (replay) return replay

    throw error
  }
}

/**
 * BACKEND FUNCTION: Bulk Delete Transactions (Soft Delete — GAAP Compliance)
 */
export const bulkDeleteTransactionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    (data: z.input<typeof bulkDeleteTransactionsTransportInputSchema>) =>
      bulkDeleteTransactionsTransportInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const normalized = await normalizeBulkDeleteTransactionsTransportInput(data)
    if (data.ids.length === 0) return { success: true }
    return await bulkDeleteTransactionsForFamily({
      ids: normalized.ids,
      idempotencyKey: normalized.idempotencyKey,
      familyId: context.familyId,
      user: context.user,
    })
  })

export async function bulkUpdateTransactionsForFamily({
  data: rawData,
  familyId,
  user,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
}): Promise<BulkUpdateTransactionsResult> {
  const data = bulkUpdateTransactionsInputSchema.parse(rawData)
  assertNoDuplicateValues(data.ids, "bulk update ids")
  const requestHash = await hashCanonicalPayload(
    canonicalBulkUpdateRequestPayload(data)
  )
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const updateOrReplay = async () =>
    await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay =
          await replayIdempotentEndpointResponse<BulkUpdateTransactionsResult>(
            tx,
            {
              endpoint: BULK_UPDATE_TRANSACTIONS_ENDPOINT,
              familyId,
              key: data.idempotencyKey,
              requestHash,
            }
          )
        if (replay) return replay

        if (!hasBulkUpdatePatch(data)) {
          const response = { replacements: [], success: true }
          await persistIdempotentEndpointResponse(tx, {
            endpoint: BULK_UPDATE_TRANSACTIONS_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
            response,
          })
          return response
        }

        // PER-94: validate every patched reference before any ledger mutation.
        await validateTenantReferences(tx, familyId, {
          accountId: data.accountId,
          merchantId: data.merchantId,
          categoryId: data.categoryId,
        })

        const targets = await findTransactionsWithTransferOutAndSplitEntries(
          tx,
          data.ids
        )
        assertAllRequestedTransactionsLoaded(data.ids, targets)
        assertNoDeletedTransactionTargets(targets)

        const targetsById = indexById(targets)
        const replacements: BulkUpdateReplacementResult[] = []
        for (const id of data.ids) {
          const target = targetsById.get(id)
          if (!target) throw new Error("Transaction not found or access denied")
          const replacement = await replaceTransactionWithinTenantTransaction(
            tx,
            {
              auditCtx,
              data: buildBulkUpdateReplacementInput(target, data),
              familyId,
              user,
            }
          )
          replacements.push({ id, replacementId: replacement.id })
        }

        const response = { replacements, success: true }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: BULK_UPDATE_TRANSACTIONS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })

        return response
      }
    )

  try {
    return await updateOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const replay = await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) =>
        await replayIdempotentEndpointResponse<BulkUpdateTransactionsResult>(
          tx,
          {
            endpoint: BULK_UPDATE_TRANSACTIONS_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
    )
    if (replay) return replay

    throw error
  }
}

/**
 * BACKEND FUNCTION: Bulk Update Transactions
 */
export const bulkUpdateTransactionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    (data: z.input<typeof bulkUpdateTransactionsTransportInputSchema>) =>
      bulkUpdateTransactionsTransportInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const normalized = await normalizeBulkUpdateTransactionsTransportInput(data)
    if (data.ids.length === 0) return { success: true }
    return await bulkUpdateTransactionsForFamily({
      data: normalized,
      familyId: context.familyId,
      user: context.user,
    })
  })

export async function bulkCreateTransactionsForFamily({
  data: rawData,
  familyId,
  user,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
}): Promise<BulkCreateTransactionsResult> {
  const data = bulkCreateTransactionsInputSchema.parse(rawData)
  assertNoDuplicateValues(
    data.transactions.map((row) => row.id),
    "bulk create transaction ids"
  )
  assertNoDuplicateValues(
    data.transactions.map((row) => row.idempotencyKey),
    "bulk create row idempotency keys"
  )
  const requestHash = await hashCanonicalPayload(
    canonicalBulkCreateRequestPayload(data)
  )
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const createOrReplay = async () =>
    await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) => {
        const replay =
          await replayIdempotentEndpointResponse<BulkCreateTransactionsResult>(
            tx,
            {
              endpoint: BULK_CREATE_TRANSACTIONS_ENDPOINT,
              familyId,
              key: data.idempotencyKey,
              requestHash,
            }
          )
        if (replay) return replay

        // PER-94: validasi seluruh referensi batch sebelum satu pun ledger row
        // dibuat supaya batch tetap all-or-nothing.
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

        const touchedAccountIds = new Set(
          data.transactions.map((row) => row.accountId)
        )
        const oldAccounts = await tx.account.findMany({
          where: { id: { in: Array.from(touchedAccountIds) } },
        })

        const transactionIds = data.transactions.map((row) => row.id)
        const accountDeltas: AccountDeltaMap = {}
        const rows = data.transactions.map((row) => {
          const signedAmount = signedIncomeExpenseAmount(row.type, row.amount)
          addAccountDelta(accountDeltas, row.accountId, signedAmount)

          return {
            id: row.id,
            userId: user.id,
            familyId,
            type: row.type,
            amount: signedAmount,
            description: row.description,
            accountId: row.accountId,
            categoryId: row.categoryId ?? null,
            merchantId: row.merchantId ?? null,
            date: row.date,
            notes: row.notes ?? null,
            status: row.status,
            attachmentUrl: row.attachmentUrl ?? null,
            idempotencyKey: row.idempotencyKey,
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

        const response = {
          count: data.transactions.length,
          success: true,
          transactionIds,
        }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: BULK_CREATE_TRANSACTIONS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })

        return response
      }
    )

  try {
    return await createOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error

    const replay = await scopedTenantTransaction(
      familyId,
      async (tx: TenantTransactionClient) =>
        await replayIdempotentEndpointResponse<BulkCreateTransactionsResult>(
          tx,
          {
            endpoint: BULK_CREATE_TRANSACTIONS_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
    )
    if (replay) return replay

    throw error
  }
}

/**
 * BACKEND FUNCTION: Bulk Create Transactions
 */
export const bulkCreateTransactionsFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(
    (data: z.input<typeof bulkCreateTransactionsTransportInputSchema>) =>
      bulkCreateTransactionsTransportInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const normalized = await normalizeBulkCreateTransactionsTransportInput(data)
    if (normalized.transactions.length === 0) {
      return { count: 0, success: true, transactionIds: [] }
    }
    return await bulkCreateTransactionsForFamily({
      data: normalized,
      familyId: context.familyId,
      user: context.user,
    })
  })
