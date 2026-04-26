import { createCollection } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { decodeMoney, encodeMoney, type Money } from "./money"
import { getQueryClient } from "./query-client"
import {
  createTransactionFn,
  deleteTransactionFn,
  getTransactionsFn,
  updateTransactionFn,
} from "@/server/transactions"

// =============================================================================
// WIRE-FORMAT REVIVAL (post-ADR-0001)
//
// `getTransactionsFn` returns monetary values as digit-strings (the wire form,
// because JSON cannot carry BigInt). In the client-side collection we IMMEDIATELY
// revive those strings back to `Money` (branded bigint) so:
//
//   1. Every consumer of the collection — live queries, components, derived
//      views — sees bigints, never strings. No "wait, is this a string or
//      a number" branching scattered through the UI.
//
//   2. We never accidentally do string concatenation (`"100" + "200" = "100200"`)
//      where arithmetic was intended. The type system catches it.
//
// Mutations going the OTHER way (insert/update) re-encode bigint → string just
// before crossing the server boundary, since `JSON.stringify(10n)` throws.
// =============================================================================

interface RawWireTransaction {
  id: string
  amount: string
  destinationAmount: string | null
  accountBalanceAfter: string | null
  splitEntries?: Array<{ amount: string } & Record<string, unknown>>
  [key: string]: unknown
}

function reviveTransaction<T extends RawWireTransaction>(
  tx: T
): Omit<
  T,
  "amount" | "destinationAmount" | "accountBalanceAfter" | "splitEntries"
> & {
  amount: Money
  destinationAmount: Money | null
  accountBalanceAfter: Money | null
  splitEntries?: Array<
    Omit<NonNullable<T["splitEntries"]>[number], "amount"> & { amount: Money }
  >
} {
  const {
    amount,
    destinationAmount,
    accountBalanceAfter,
    splitEntries,
    ...rest
  } = tx
  const result = {
    ...rest,
    amount: decodeMoney(amount),
    destinationAmount:
      destinationAmount == null ? null : decodeMoney(destinationAmount),
    accountBalanceAfter:
      accountBalanceAfter == null ? null : decodeMoney(accountBalanceAfter),
  } as Omit<
    T,
    "amount" | "destinationAmount" | "accountBalanceAfter" | "splitEntries"
  > & {
    amount: Money
    destinationAmount: Money | null
    accountBalanceAfter: Money | null
    splitEntries?: Array<
      Omit<NonNullable<T["splitEntries"]>[number], "amount"> & {
        amount: Money
      }
    >
  }
  if (splitEntries) {
    result.splitEntries = splitEntries.map(
      (e) =>
        ({
          ...e,
          amount: decodeMoney(e.amount),
        }) as Omit<NonNullable<T["splitEntries"]>[number], "amount"> & {
          amount: Money
        }
    )
  }
  return result
}

// =============================================================================
// PUBLIC TYPE — derived from the revived collection record. This is what the
// rest of the app should use. NOTE: amounts are `Money` (bigint), not numbers.
// =============================================================================
type RawTransactionFromServer = Awaited<
  ReturnType<typeof getTransactionsFn>
>[number]
export type TransactionRecord = ReturnType<
  typeof reviveTransaction<RawTransactionFromServer>
>

// 1. Definisikan Koleksi Transaksi kita
export const transactionCollection = createCollection(
  queryCollectionOptions({
    // QueryKey ini bertindak sebagai ID unik di dalam sistem caching TanStack
    queryKey: ["transactions_live"],

    // QueryClient yang akan digunakan untuk melakukan query
    queryClient: getQueryClient(),

    // Fetch from server, then revive wire-strings → Money (bigint).
    // This boundary is the ONLY place client code touches the wire format.
    queryFn: async () => {
      const data = await getTransactionsFn()
      return data.map((tx) => reviveTransaction(tx))
    },

    // Primary key dari setiap baris data
    getKey: (item: TransactionRecord) => item.id,

    // Konfigurasi Enterprise: SyncMode
    // 'eager' sangat cocok untuk personal finance karena jumlah transaksi
    // bulanan biasanya di bawah 10.000 baris, membuat UI terasa instan.
    syncMode: "eager",

    // ENTERPRISE: OPTIMISTIC MUTATION HANDLER
    // The form layer puts a `Money` (bigint) into `amount`. We re-encode to
    // a wire-string just before the server-fn boundary, since BigInt cannot
    // be JSON-stringified. The server's Zod schema decodes it back.
    onInsert: async ({ transaction }) => {
      try {
        const payload = transaction.mutations[0].changes

        await createTransactionFn({
          data: {
            id: payload.id as string,
            type: payload.type as "expense" | "income" | "transfer",
            amount: encodeMoney(payload.amount as Money),
            description: payload.description as string,
            accountId: payload.accountId as string,
            categoryId: payload.categoryId as string | null,
            toAccountId: payload.toAccountId as string | null,
            merchantId: payload.merchantId as string | null,
            date: payload.date as Date,
            notes: payload.notes as string | null,
            // Split Transaction Engine: kirim ke server (re-encode each entry)
            isSplit: (payload.isSplit as boolean | undefined) ?? false,
            splitEntries: (
              (payload.splitEntries as
                | Array<{
                    description: string
                    amount: Money
                    categoryId?: string | null
                    merchantId?: string | null
                  }>
                | undefined) ?? []
            ).map((e) => ({ ...e, amount: encodeMoney(e.amount) })),
            status:
              (payload.status as
                | "PENDING"
                | "CLEARED"
                | "RECONCILED"
                | undefined) ?? "CLEARED",
            destinationAmount: payload.destinationAmount
              ? encodeMoney(payload.destinationAmount as Money)
              : null,
            destinationCurrency:
              (payload.destinationCurrency as string | null | undefined) ??
              null,
            attachmentUrl:
              (payload.attachmentUrl as string | null | undefined) ?? null,
          },
        })
        // WAJIB: Tunggu server untuk sync ulang agar optimistic state tetap valid
        await transactionCollection.utils.refetch()
      } catch (error) {
        console.error("Optimistic Insert Failed! Rolled back:", error)
        throw error
      }
    },

    onUpdate: async ({ transaction }) => {
      try {
        const payload = transaction.mutations[0].modified

        await updateTransactionFn({
          data: {
            id: payload.id as string,
            type: payload.type as "expense" | "income" | "transfer",
            amount: encodeMoney(payload.amount as Money),
            description: payload.description as string,
            accountId: payload.accountId as string,
            categoryId: payload.categoryId as string | null,
            toAccountId: payload.toAccountId as string | null,
            merchantId: payload.merchantId as string | null,
            date: payload.date as Date,
            notes: payload.notes as string | null,
            // Split Transaction Engine: kirim ke server (re-encode each entry)
            isSplit: (payload.isSplit as boolean | undefined) ?? false,
            splitEntries: (
              (payload.splitEntries as
                | Array<{
                    description: string
                    amount: Money
                    categoryId?: string | null
                    merchantId?: string | null
                  }>
                | undefined) ?? []
            ).map((e) => ({ ...e, amount: encodeMoney(e.amount) })),
            status:
              (payload.status as
                | "PENDING"
                | "CLEARED"
                | "RECONCILED"
                | undefined) ?? "CLEARED",
            destinationAmount: payload.destinationAmount
              ? encodeMoney(payload.destinationAmount as Money)
              : null,
            destinationCurrency:
              (payload.destinationCurrency as string | null | undefined) ??
              null,
            attachmentUrl:
              (payload.attachmentUrl as string | null | undefined) ?? null,
          },
        })
        // WAJIB: Tunggu server sync ulang agar data edit tersinkron permanen
        await transactionCollection.utils.refetch()
      } catch (error) {
        console.error("Optimistic Update Failed! Rolled back:", error)
        throw error
      }
    },

    onDelete: async ({ transaction }) => {
      try {
        const id = transaction.mutations[0].original.id
        await deleteTransactionFn({
          data: { id: id as string },
        })
        // WAJIB: Sync ulang setelah hapus agar UI konsisten dengan server
        await transactionCollection.utils.refetch()
      } catch (error) {
        console.error("Optimistic Delete Failed! Rolled back:", error)
        throw error
      }
    },
  })
)
