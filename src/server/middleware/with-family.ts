/**
 * M1-4: withFamily HOC + scopeTenant Prisma extension
 *
 * Architecture:
 *   - `scopeTenant(prisma, familyId)` — wraps every model-level query method
 *     with an automatic `where: { familyId }` injection via Prisma `$extends`.
 *     This is the load-bearing tenant-isolation primitive; the app middleware
 *     layer should be treated as the first wall, RLS (M1-5) as the second.
 *   - `familyMiddleware` (re-exported from session.ts) — TanStack Start
 *     createMiddleware that verifies session + familyId and injects both into
 *     the server-fn context.
 *
 * Usage in a server function:
 *
 *   ```ts
 *   export const getTransactionsFn = createServerFn({ method: "GET" })
 *     .middleware([familyMiddleware])
 *     .handler(async ({ context }) => {
 *       const db = scopeTenant(prisma, context.familyId)
 *       return db.transaction.findMany({ ... })
 *     })
 *   ```
 *
 * The scoped client automatically appends `AND family_id = '<familyId>'` to
 * every query that touches a tenant-scoped model. For `findUnique` / `findUniqueOrThrow`,
 * which require a unique filter, we fall through to the raw Prisma client so
 * that uniqueness lookups (e.g. by `id`) still work — callers must verify the
 * returned row's `familyId` matches the session's tenant when ownership matters.
 *
 * The `db.unsafe` escape hatch exposes the raw `prisma` client. Any use of it
 * MUST be grep-auditable and reviewed at PR time.
 */

import { PrismaClient } from "@prisma/client"
import { prisma } from "../db.server"

// Re-export middleware from session.ts for ergonomic import
export { authMiddleware, familyMiddleware } from "./session"

// ============================================================================
// TENANT-SCOPED PRISMA CLIENT
// ============================================================================
// We use Prisma's `$extends` to create a lightweight proxy that automatically
// injects `where: { familyId }` into queries for all tenant-scoped models.
//
// Tenant-scoped models (must match M1-5 RLS tables):
//   Account, Merchant, Category, Transaction, SplitEntry, SmartRule, Transfer
//
// Non-scoped models (auth / family scaffolding):
//   User, Session, AuthAccount, Verification, Family
// ============================================================================

const TENANT_SCOPED_MODELS = new Set([
  "account",
  "merchant",
  "category",
  "transaction",
  "splitEntry",
  "smartRule",
  "transfer",
])

/**
 * Returns a PrismaClient extension that injects `familyId` into every
 * `findMany`, `findFirst`, `count`, `aggregate`, `groupBy`, `updateMany`,
 * and `deleteMany` call on tenant-scoped models.
 *
 * The extension is created per-request (cheap — no new connection is opened)
 * and garbage-collected naturally. Prisma v6+ $extends is safe for this pattern.
 */
export function scopeTenant(
  client: PrismaClient,
  familyId: string
): PrismaClient & { unsafe: PrismaClient } {
  const extended = client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Only inject familyId filter for tenant-scoped models
          if (
            model &&
            TENANT_SCOPED_MODELS.has(
              model.charAt(0).toLowerCase() + model.slice(1)
            )
          ) {
            // Operations that accept a `where` clause for filtering by familyId:
            const filterOps = [
              "findMany",
              "findFirst",
              "findFirstOrThrow",
              "count",
              "aggregate",
              "groupBy",
              "updateMany",
              "deleteMany",
            ]
            if (filterOps.includes(operation)) {
              const typedArgs = (args ?? {}) as {
                where?: Record<string, unknown>
              }
              typedArgs.where = {
                ...typedArgs.where,
                familyId,
              }
              args = typedArgs
            }
            // Note: `findUnique` / `findUniqueOrThrow` / `create` / `update` / `delete`
            // are NOT injected — they require unique fields (id) or are handled
            // explicitly by the caller with the familyId from context.
          }
          return query(args)
        },
      },
    },
  })

  // Attach the escape hatch as a non-enumerable property
  Object.defineProperty(extended, "unsafe", {
    get: () => client,
    enumerable: false,
    configurable: false,
  })

  return extended as unknown as PrismaClient & { unsafe: PrismaClient }
}

/**
 * Convenience: creates a tenant-scoped client from the global prisma singleton.
 * This is the canonical way to create a scoped client in server functions.
 */
export function createTenantDb(
  familyId: string
): PrismaClient & { unsafe: PrismaClient } {
  return scopeTenant(prisma, familyId)
}

export type TenantDb = ReturnType<typeof createTenantDb>
