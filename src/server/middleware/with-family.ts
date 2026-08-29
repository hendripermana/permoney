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
  // PER-264 / PER-265 — the `.server` suffix is a HARD FENCE, not a style
  // choice: this module is client-reachable (it re-exports `familyMiddleware` /
  // `requireCapability`), and without the fence this edge drags
  // `middleware/audit` and its `@tanstack/react-start/server` import into the
  // client bundle, failing `vp build`'s import-protection check. Imported
  // dynamically, mirroring the `db.server` idiom above, so the module cycle
  // (anchor-rebuild.server -> valuations -> this file) never forms at load.
  const { flushAnchorRebuilds } = await import("../anchor-rebuild.server")
  return await withSerializableRetry(
    prisma,
    async (tx) => {
      await setTenantGuc(tx, familyId, userId)
      const result = await fn(tx)
      // ADR-0043 anchor-provenance amendment: re-materialize any account whose
      // balance this transaction moved incrementally AND whose latest anchor is
      // `ground_truth`, before the transaction commits. Runs here rather than
      // at the delta call site because several mutation paths apply the delta
      // before writing the row it accounts for; by this point every row write
      // in this transaction has landed. A no-op (one WeakMap miss) for the vast
      // majority of transactions, which register nothing at all.
      await flushAnchorRebuilds(tx, familyId, userId)
      return result
    },
    options
  )
}
