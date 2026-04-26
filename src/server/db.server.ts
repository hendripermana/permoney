import { PrismaClient } from "@prisma/client"
import { PrismaLibSql } from "@prisma/adapter-libsql"

// =============================================================================
// MAANG ARCHITECTURE NOTE — HARD SERVER-ONLY MODULE (.server.ts boundary)
// =============================================================================
// File ini berakhiran `.server.ts` — sebuah HARD COMPILE-TIME FENCE yang
// dikenali TanStack Start's Vite plugin. Source code modul ini dijamin
// TIDAK PERNAH masuk ke client bundle, karena plugin replace dengan empty
// module sebelum Vite optimizeDeps berjalan. Tanpa fence ini, pre-bundling
// optimizeDeps akan mengikuti `import { PrismaClient } from "@prisma/client"`
// dan mencoba bundle browser-version Prisma yang pakai CJS `require()` —
// Rolldown menolak dan crash di runtime client dengan error:
//   "Calling `require` for '.prisma/client/index-browser' in an environment
//    that doesn't expose the `require` function".
//
// Defense-in-depth tetap dipertahankan:
//   1. Lazy factory pattern — `new PrismaClient()` baru fire saat property diakses
//   2. Proxy + globalForPrisma — HMR-safe singleton di dev
//   3. `typeof window !== "undefined"` runtime trap — kalau ada cara
//      mistery yang menerobos fence, error message langsung kelihatan
//   4. `/* @__PURE__ */` annotation — bantuan tambahan untuk tree-shaking
//      pada code path yang reachable dari server bundle saja
// =============================================================================

// SINGLETON STORAGE — HMR-safe via globalThis di dev
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// =============================================================================
// CONFIG RESOLVER — URL-scheme-aware config for `@prisma/adapter-libsql`.
// =============================================================================
// `@libsql/client` accepts the same config shape for both local (`file:`) and
// remote (`libsql:`/`https:`/`wss:`) URLs, but remote URLs additionally
// require an `authToken`. Rather than let a misconfigured prod env discover
// this on its first query (with an opaque 401), we validate at boot and
// emit a precise, actionable error.
//
// Schemes:
//   • `file:` (and `:memory:` for tests) → local embedded SQLite. No token.
//   • `libsql://`, `https://`, `wss://`  → Turso remote replica. Token required.
//
// Remote schemes per Turso docs: `libsql://` is the canonical form;
// `https://` and `wss://` are supported aliases (auto-upgraded by the
// libSQL client to its native protocol). Anything else falls through to
// libSQL's default handling (Turso may extend the scheme list later).
//
// See ADR-0003 (docs/adr/0003-production-database.md) for the full
// production-database decision and revisit triggers.
// =============================================================================
const REMOTE_LIBSQL_SCHEMES = ["libsql://", "https://", "wss://"] as const

interface LibSqlConfig {
  url: string
  authToken?: string
}

function resolveLibSqlConfig(url: string): LibSqlConfig {
  const isRemote = REMOTE_LIBSQL_SCHEMES.some((scheme) =>
    url.startsWith(scheme)
  )
  if (!isRemote) {
    // Local SQLite (dev or tests). Pass through; no token expected.
    return { url }
  }

  // Remote Turso. Token is mandatory — fail fast.
  const authToken = process.env.DATABASE_AUTH_TOKEN
  if (!authToken || authToken.trim() === "") {
    throw new Error(
      `🚨 DATABASE_AUTH_TOKEN is required when DATABASE_URL uses a remote ` +
        `libSQL scheme (got "${url.split("://")[0]}://"). Set the token in ` +
        `your environment (Turso: \`turso db tokens create <db-name>\`). ` +
        `For local development, set DATABASE_URL to a "file:" URL instead.`
    )
  }
  return { url, authToken }
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

  // 3. PRISMA V7 DRIVER ADAPTER — koneksi diserahkan ke adapter level kode.
  //    Resolve adapter config from URL scheme (see ADR-0003):
  //      • `file:` → local embedded SQLite (dev). No auth token expected.
  //      • `libsql:` / `https:` / `wss:` → Turso remote replica (prod).
  //        DATABASE_AUTH_TOKEN is REQUIRED; we fail fast here with an
  //        actionable error message rather than letting the first query
  //        hit a 401 from Turso at runtime.
  const adapter = new PrismaLibSql(resolveLibSqlConfig(dbUrl))

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
