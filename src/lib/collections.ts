import { createCollection } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { getQueryClient } from "./query-client"
import {
  createTransactionFn,
  deleteTransactionFn,
  getTransactionsFn,
  updateTransactionFn,
} from "@/server/transactions"

// 1. ENTERPRISE TYPE EXTRACTION (End-to-End Type Safety)
// Kita mengekstrak tipe kembalian langsung dari Server Function!
// Awaited: Menghapus bungkus Promise.
// ReturnType: Mengambil tipe data yang di-return oleh fungsi.
// [number]: Mengambil tipe dari SATU baris data (karena aslinya berupa Array).
type TransactionRecord = Awaited<ReturnType<typeof getTransactionsFn>>[number]

// 1. Definisikan Koleksi Transaksi kita
export const transactionCollection = createCollection(
  queryCollectionOptions({
    // QueryKey ini bertindak sebagai ID unik di dalam sistem caching TanStack
    queryKey: ["transactions_live"],

    // QueryClient yang akan digunakan untuk melakukan query
    queryClient: getQueryClient(),

    // Fungsi untuk mengambil data awal dari server
    queryFn: async () => {
      const data = await getTransactionsFn()
      return data
    },

    // Primary key dari setiap baris data
    getKey: (item: TransactionRecord) => item.id,

    // Konfigurasi Enterprise: SyncMode
    // 'eager' sangat cocok untuk personal finance karena jumlah transaksi
    // bulanan biasanya di bawah 10.000 baris, membuat UI terasa instan.
    syncMode: "eager",

    // Enterprise Architecture: OPTIMISTIC MUTATION HANDLER
    // Ketika UI memanggil transactionCollection.insert(), kode ini berjalan di background
    onInsert: async ({ transaction }) => {
      try {
        const payload = transaction.mutations[0].changes

        await createTransactionFn({
          data: {
            id: payload.id as string,
            type: payload.type as "expense" | "income" | "transfer",
            amount: payload.amount as number,
            description: payload.description as string,
            accountId: payload.accountId as string,
            categoryId: payload.categoryId as string | null,
            toAccountId: payload.toAccountId as string | null,
            merchantId: payload.merchantId as string | null,
            date: payload.date as Date,
            notes: payload.notes as string | null,
            // Split Transaction Engine: kirim ke server
            isSplit: (payload.isSplit as boolean | undefined) ?? false,
            splitEntries:
              (payload.splitEntries as
                | Array<{
                    description: string
                    amount: number
                    categoryId?: string | null
                    merchantId?: string | null
                  }>
                | undefined) ?? [],
            status:
              (payload.status as
                | "PENDING"
                | "CLEARED"
                | "RECONCILED"
                | undefined) ?? "CLEARED",
            destinationAmount:
              (payload.destinationAmount as number | null | undefined) ?? null,
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
            amount: payload.amount as number,
            description: payload.description as string,
            accountId: payload.accountId as string,
            categoryId: payload.categoryId as string | null,
            toAccountId: payload.toAccountId as string | null,
            merchantId: payload.merchantId as string | null,
            date: payload.date as Date,
            notes: payload.notes as string | null,
            // Split Transaction Engine: kirim ke server
            isSplit: (payload.isSplit as boolean | undefined) ?? false,
            splitEntries:
              (payload.splitEntries as
                | Array<{
                    description: string
                    amount: number
                    categoryId?: string | null
                    merchantId?: string | null
                  }>
                | undefined) ?? [],
            status:
              (payload.status as
                | "PENDING"
                | "CLEARED"
                | "RECONCILED"
                | undefined) ?? "CLEARED",
            destinationAmount:
              (payload.destinationAmount as number | null | undefined) ?? null,
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
