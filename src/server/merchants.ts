import { createServerFn } from "@tanstack/react-start"
import type { Merchant } from "@prisma/client"
import { z } from "zod"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  requireCapability,
  scopedTenantTransaction,
} from "./middleware/with-family"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import {
  DuplicateNameError,
  isNameDedupConstraintError,
  isUniqueConstraintError,
  uuidV7Schema,
  type RunInTenantTransaction,
} from "./mutation-kit"

// =============================================================================
// PER-189 — quick-create Merchant from the transaction form.
//
// Merchant is a first-class analytics dimension (spend-by-merchant stats,
// SmartRule keys, recurring detection, future bank-sync matching), so it gets
// the same mutation contract as every other ledger-adjacent write (ADR-0008):
// an interactive `prisma.$transaction` with the `app.family_id` RLS GUC set on
// the same transaction, an accepted idempotency key replayed through
// `IdempotencyRecord`, and an append-only `AuditLog` row written inside the
// same transaction.
//
// Domain scope (head-eng decision recorded on PER-189): persons who are mere
// payment destinations are Merchants (one counterparty concept, YNAB-payee
// style). Persons with debt relationships are ACCOUNTS (loan/receivable). No
// "People" entity exists; a future `kind` discriminator on Merchant is the
// extension point if analytics ever needs the business/person split.
//
// Full management (rename/merge/delete) is out of scope here — PER-167.
// =============================================================================

const CREATE_MERCHANT_ENDPOINT = "createMerchantFn"
const MERCHANT_NAME_DEDUP_INDEX = "Merchant_familyId_lower_name_key"

const nameSchema = z.string().trim().min(1).max(120)
const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #RRGGBB hex value")

export const createMerchantInputSchema = z.object({
  name: nameSchema,
  color: hexColorSchema.nullable().optional(),
  idempotencyKey: uuidV7Schema,
})

type CreateMerchantInput = z.infer<typeof createMerchantInputSchema>

export interface SerializedMerchant {
  id: string
  name: string
  color: string | null
}

function serializeMerchant(merchant: Merchant): SerializedMerchant {
  return {
    id: merchant.id,
    name: merchant.name,
    color: merchant.color,
  }
}

interface ServerUser {
  id: string
}

export async function createMerchantForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createMerchantInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedMerchant> {
  const data: CreateMerchantInput = createMerchantInputSchema.parse(rawData)
  const trimmedName = data.name.trim()
  const color = data.color ?? null
  const requestHash = await hashCanonicalPayload({ color, name: trimmedName })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedMerchant>(
        tx,
        {
          endpoint: CREATE_MERCHANT_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      // Pre-check catches the common case with a clean, well-typed error. The
      // functional unique index (migration `merchant_category_name_dedup`) is
      // the durable backstop for the concurrent-double-submit race.
      const existing = await tx.merchant.findFirst({
        where: { familyId, name: { equals: trimmedName, mode: "insensitive" } },
      })
      if (existing) throw new DuplicateNameError("Merchant", trimmedName)

      const merchant = await tx.merchant.create({
        data: { familyId, name: trimmedName, color },
      })

      const serialized = serializeMerchant(merchant)
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Merchant",
        entityId: merchant.id,
        after: serialized,
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_MERCHANT_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (isNameDedupConstraintError(error, MERCHANT_NAME_DEDUP_INDEX)) {
      throw new DuplicateNameError("Merchant", trimmedName)
    }
    // A concurrent request with the same key may win the IdempotencyRecord
    // unique race; resolve it by replaying the stored response.
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        replayIdempotentEndpointResponse<SerializedMerchant>(tx, {
          endpoint: CREATE_MERCHANT_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export const createMerchantFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof createMerchantInputSchema>) =>
    createMerchantInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createMerchantForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })
