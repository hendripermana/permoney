import type { Prisma } from "@prisma/client"
import { prisma } from "../db.server"

// Re-export middleware from session.ts for ergonomic import
export { authMiddleware, familyMiddleware } from "./session"

/**
 * Transaction client yang sudah punya `app.family_id` via `set_config(..., true)`.
 * Semua query RLS-protected harus memakai client ini, bukan root `prisma`.
 */
export type TenantTransactionClient = Prisma.TransactionClient

// ============================================================================
// RLS: transaction-scoped GUC helpers
// ============================================================================

interface ScopedTenantTransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel
  maxWait?: number
  timeout?: number
}

export async function setTenantGuc(
  tx: TenantTransactionClient,
  familyId: string
): Promise<void> {
  await tx.$executeRaw`
    SELECT set_config('app.family_id', ${familyId}, true)
  `
}

export async function scopedTenantTransaction<T>(
  familyId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>,
  options?: ScopedTenantTransactionOptions
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setTenantGuc(tx, familyId)
    return await fn(tx)
  }, options)
}
