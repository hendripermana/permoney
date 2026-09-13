import { z } from "zod"
import type { TenantTransactionClient } from "./middleware/with-family"

// =============================================================================
// Shared ledger-mutation helpers.
//
// Every tenant mutation service (accounts, transactions, valuations) needs the
// same idempotency-key shape, the same Prisma unique-violation check for
// idempotency-race replay, and the same overridable tenant-transaction runner.
// Centralized here so the contract stays identical and cannot drift between
// services (and so the same nine lines are not copy-pasted three times).
// =============================================================================

// Client-generated UUIDv7 idempotency key (ADR-0006). Lower-cased so the stored
// key is canonical regardless of how the client formatted it.
export const uuidV7Schema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "idempotencyKey must be a UUIDv7"
  )
  .transform((value) => value.toLowerCase())

// Prisma unique-constraint violation (P2002). A concurrent request that wins the
// IdempotencyRecord unique race surfaces as P2002; callers catch it and replay
// the stored response.
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  )
}

// Raised when a quick-create mutation targets a name that already exists
// (case/whitespace-insensitive) within the family — Merchant and Category
// (PER-189) both enforce this at the DB layer with a functional unique index,
// not just an app-level check (see migration `merchant_category_name_dedup`).
export class DuplicateNameError extends Error {
  override readonly name = "DuplicateNameError"
  readonly statusCode = 409
  constructor(
    readonly entityType: string,
    readonly attemptedName: string
  ) {
    super(
      `A ${entityType.toLowerCase()} named "${attemptedName}" already exists`
    )
  }
}

// P2002 raised specifically by a name-dedup functional unique index (as
// opposed to the IdempotencyRecord unique race, which callers already handle
// via isUniqueConstraintError + replay). Prisma reports the violated index
// name as `meta.target` — either a bare string or an array — for indexes not
// modeled in schema.prisma, since it cannot map back to column names.
export function isNameDedupConstraintError(
  error: unknown,
  indexName: string
): boolean {
  if (!isUniqueConstraintError(error)) return false
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  if (typeof target === "string") return target.includes(indexName)
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === "string" && t.includes(indexName))
  }
  return false
}

// A tenant-scoped interactive transaction runner. Production callers default to
// `scopedTenantTransaction`; tests inject a harness-scoped runner. `userId` is
// the acting member, set into the `app.user_id` GUC for the RLS membership
// guard (ADR-0036).
export type RunInTenantTransaction = <T>(
  familyId: string,
  userId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>
) => Promise<T>
