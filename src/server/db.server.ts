import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

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
// DATABASE_URL VALIDATOR — fail-fast at boot, not at first query.
// =============================================================================
// `@prisma/adapter-pg` accepts a Postgres connection string in the standard
// libpq URI form: `postgres://user:pass@host:port/db?sslmode=require`.
// (`postgresql://` is also accepted as an alias.)
//
// We refuse anything else early — typical mistakes worth surfacing:
//   • An empty/missing DATABASE_URL (deploys with the env var unset).
//   • A leftover SQLite URL from the pre-ADR-0003 setup (`file:./...`).
//   • A leftover libSQL URL (`libsql://...`) from a previous Turso path.
// In each case we throw a precise message that names the actual offender,
// the expected scheme, and a copy-pasteable fix snippet.
//
// See ADR-0003 (docs/adr/0003-production-database.md) for the full
// production-database decision.
// =============================================================================
const POSTGRES_SCHEMES = ["postgres://", "postgresql://"] as const

function validatePostgresUrl(url: string | undefined): string {
  if (!url || url.trim() === "") {
    throw new Error(
      `🚨 DATABASE_URL is not set. Expected a Postgres URL like ` +
        `"postgres://user:pass@host:5432/db". For local dev: ` +
        `"postgres://permoney:permoney@localhost:5433/permoney" ` +
        `(start the local DB with \`vp run db:up\`).`
    )
  }
  const isPostgres = POSTGRES_SCHEMES.some((s) => url.startsWith(s))
  if (!isPostgres) {
    // Extract just the scheme (everything before the first `:`). We split
    // on `:` rather than `://` because legacy SQLite URLs use `file:` (no
    // double slash) — we want the message to read "got 'file:'", not the
    // entire URL with a spurious "://" appended.
    const scheme = url.includes(":") ? `${url.split(":")[0]}:` : "<no-scheme>"
    throw new Error(
      `🚨 DATABASE_URL must use a "postgres://" or "postgresql://" scheme ` +
        `(got "${scheme}"). Permoney migrated to Postgres in ADR-0003; ` +
        `legacy "file:" / "libsql:" URLs are no longer supported. ` +
        `For local dev: "postgres://permoney:permoney@localhost:5433/permoney".`
    )
  }
  return url
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

  // 2. DATABASE URL — validated at boot. Same URL is consumed by:
  //    (a) Prisma CLI (migrations, generate) via `prisma.config.ts`
  //    (b) Runtime adapter `@prisma/adapter-pg` here
  //    There is no fallback default — an unset DATABASE_URL is a deploy
  //    misconfiguration that should surface immediately, not be papered
  //    over with a hardcoded localhost.
  const dbUrl = validatePostgresUrl(process.env.DATABASE_URL)

  // 3. PRISMA V7 DRIVER ADAPTER — koneksi diserahkan ke adapter level kode.
  //    `PrismaPg` accepts the same `pg.Pool` config as `pg` itself; we
  //    pass the raw connection string and let it parse host/port/auth.
  //    For prod, set `?sslmode=require` (or `?sslmode=verify-full` with a
  //    CA bundle) on the URL — managed Postgres providers all require TLS.
  const adapter = new PrismaPg({ connectionString: dbUrl })

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
