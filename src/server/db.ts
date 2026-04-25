import { PrismaClient } from "@prisma/client"
import { PrismaLibSql } from "@prisma/adapter-libsql"

// =============================================================================
// MAANG ARCHITECTURE NOTE — SIDE-EFFECT FREE SERVER MODULE
// =============================================================================
// Modul ini WAJIB side-effect free agar Vite/Rolldown bebas mengeliminasinya
// dari client bundle setelah TanStack Start's `createServerFn` splitter
// menghapus seluruh referensi `prisma` dari handler bodies. Jika modul ini
// punya top-level side effect (seperti `new PrismaClient()` langsung, atau
// `throw` di modul scope), ESM spec memaksa bundler untuk mempertahankan
// evaluasi modul — sehingga @prisma/client ikut ter-bundle ke browser dan
// trap meledak di client. Solusinya: lazy factory + Proxy.
// =============================================================================

// SINGLETON STORAGE — HMR-safe via globalThis di dev
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// 1. LAZY FACTORY — dipanggil PERTAMA KALI saat properti prisma diakses.
//    Client bundle tidak pernah boleh mencapai fungsi ini; jika ada yang
//    menerobos arsitektur server/client, trap di sini yang fire.
function createPrismaClient(): PrismaClient {
  // SECURITY TRAP (runtime defense-in-depth)
  if (typeof window !== "undefined") {
    throw new Error(
      "🚨 SECURITY BREACH: The database connection file (db.ts) was imported into the client-side bundle. Check your UI component imports!"
    )
  }

  // 2. SSR SAFE DATABASE URL
  const dbUrl = process.env.DATABASE_URL || "file:./prisma/dev.db"

  // 3. PRISMA V7 DRIVER ADAPTER — koneksi diserahkan ke adapter level kode
  const adapter = new PrismaLibSql({ url: dbUrl })

  // 4. PRISMA V7 INITIALIZATION
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })

  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client
  return client
}

// 5. PROXY SINGLETON — zero module-level side effects.
//    Semua akses (prisma.user, prisma.$transaction, dll) akan lazy-init
//    singleton pada hit pertama, lalu di-cache via globalForPrisma.
//    `/* @__PURE__ */` memberi petunjuk ke Rolldown bahwa ekspresi ini
//    aman dihapus jika `prisma` tidak pernah dipakai di bundle terkait
//    (mis. setelah createServerFn splitter membuang handler bodies di
//    client bundle).
export const prisma: PrismaClient = /* @__PURE__ */ new Proxy(
  {} as PrismaClient,
  {
    get(_target, prop) {
      const client = globalForPrisma.prisma ?? createPrismaClient()
      const value = Reflect.get(client, prop) as unknown
      // Bind method agar `this` tetap mereferensikan client asli (penting
      // untuk `prisma.$transaction`, `prisma.$connect`, dsb).
      return typeof value === "function"
        ? (value as (...args: Array<unknown>) => unknown).bind(client)
        : value
    },
  }
)
