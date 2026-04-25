// File: src/lib/query-client.ts
import { QueryClient } from "@tanstack/react-query"

// 1. ENTERPRISE SSR PATTERN: Factory pattern untuk keamanan SSR
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data tidak akan fetch ulang otomatis dalam 1 menit
        // untuk mencegah spam request ke backend
        staleTime: 60 * 1000,
      },
    },
  })
}

// 2. Variabel penampung untuk Singleton di Browser
let browserQueryClient: QueryClient | undefined = undefined

export function getQueryClient() {
  // Aturan SSR: Jika di server, selalu buat instance baru per-request!
  if (typeof window === "undefined") {
    return makeQueryClient()
  }

  // Aturan Client: Jika di browser, selalu gunakan instance yang sama (Singleton)
  if (!browserQueryClient) browserQueryClient = makeQueryClient()
  return browserQueryClient
}
