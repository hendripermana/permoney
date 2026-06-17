import type { Prisma } from "@prisma/client"
import type { TenantTransactionClient } from "./middleware/with-family"
import {
  IDEMPOTENCY_RECORD_TTL_MS,
  IdempotencyConflictError,
  toCanonicalJson,
} from "./idempotency"

/**
 * Endpoint-scoped idempotency replay/persist helpers (ADR-0006 / ADR-0032).
 *
 * These mirror the create-style `Transaction.idempotencyKey` uniqueness but for
 * entities that have no per-row idempotency column (such as `Account`). They run
 * on the caller's tenant transaction so the replay lookup, the mutation, and the
 * record write all share the same Postgres transaction and `app.family_id` GUC.
 *
 * `replay` returns the stored response when the same `(familyId, endpoint, key)`
 * has already succeeded with the same `requestHash`. A reused key carrying a
 * different payload raises `IdempotencyConflictError` (HTTP 409).
 */
export async function replayIdempotentEndpointResponse<TResponse>(
  tx: TenantTransactionClient,
  {
    endpoint,
    familyId,
    key,
    requestHash,
  }: {
    endpoint: string
    familyId: string
    key: string
    requestHash: string
  }
): Promise<TResponse | null> {
  const record = await tx.idempotencyRecord.findUnique({
    where: {
      familyId_endpoint_key: {
        endpoint,
        familyId,
        key,
      },
    },
  })
  if (!record) return null
  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError()
  }
  return record.responseJson as TResponse
}

export async function persistIdempotentEndpointResponse(
  tx: TenantTransactionClient,
  {
    endpoint,
    familyId,
    key,
    requestHash,
    response,
  }: {
    endpoint: string
    familyId: string
    key: string
    requestHash: string
    response: unknown
  }
): Promise<void> {
  await tx.idempotencyRecord.create({
    data: {
      endpoint,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_RECORD_TTL_MS),
      familyId,
      key,
      requestHash,
      responseJson: toCanonicalJson(response) as Prisma.InputJsonValue,
      statusCode: 200,
    },
  })
}
