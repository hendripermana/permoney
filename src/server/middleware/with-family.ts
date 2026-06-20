import type { Prisma } from "@prisma/client"
import {
  withSerializableRetry,
  type SerializableRetryOptions,
} from "./with-retry"

// Re-export middleware from session.ts for ergonomic import
export { authMiddleware, familyMiddleware, requireCapability } from "./session"

/**
 * Transaction client yang sudah punya `app.family_id` via `set_config(..., true)`.
 * Semua query RLS-protected harus memakai client ini, bukan root `prisma`.
 *
 * Catatan pg: interactive transaction memakai satu client/connection. Query yang
 * memakai client ini harus diserialkan; `Promise.all(tx.*)` bisa memicu overlap
 * `client.query()` dan akan ditolak pg@9.
 */
export type TenantTransactionClient = Prisma.TransactionClient

// ============================================================================
// RLS: transaction-scoped GUC helpers
// ============================================================================

type ScopedTenantTransactionOptions = SerializableRetryOptions

/**
 * Sets BOTH transaction-scoped GUCs that drive RLS (ADR-0036):
 *   - `app.family_id` — tenant isolation on every tenant table.
 *   - `app.user_id`   — the acting member; the `app_is_active_member()` guard
 *     on every tenant-table policy rejects the query unless this user is an
 *     `active` member of `familyId`.
 *
 * Both are scoped to the current transaction (`set_config(..., true)`), so they
 * never leak across pooled connections. `userId` MUST be the real acting user
 * (`context.user.id`) — substituting an arbitrary member would defeat the
 * per-user membership guard.
 */
export async function setTenantGuc(
  tx: TenantTransactionClient,
  familyId: string,
  userId: string
): Promise<string> {
  await tx.$executeRaw`
    SELECT
      set_config('app.family_id', ${familyId}, true),
      set_config('app.user_id', ${userId}, true)
  `
  return familyId
}

export async function scopedTenantTransaction<T>(
  familyId: string,
  userId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>,
  options?: ScopedTenantTransactionOptions
): Promise<T> {
  const { prisma } = await import("../db.server")
  return await withSerializableRetry(
    prisma,
    async (tx) => {
      await setTenantGuc(tx, familyId, userId)
      return await fn(tx)
    },
    options
  )
}
