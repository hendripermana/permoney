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

// PER-212 / ADR-0049: "business" (classic payee) | "person" (informal-debt
// party). Defaults to "business" so every existing quick-create keeps its
// meaning; a person contact is created by passing kind="person".
export const MERCHANT_KIND_VALUES = ["business", "person"] as const
export type MerchantKind = (typeof MERCHANT_KIND_VALUES)[number]

export const createMerchantInputSchema = z.object({
  name: nameSchema,
  color: hexColorSchema.nullable().optional(),
  kind: z.enum(MERCHANT_KIND_VALUES).optional().default("business"),
  idempotencyKey: uuidV7Schema,
})

type CreateMerchantInput = z.infer<typeof createMerchantInputSchema>

export interface SerializedMerchant {
  id: string
  name: string
  color: string | null
  kind: MerchantKind
}

function serializeMerchant(merchant: Merchant): SerializedMerchant {
  return {
    id: merchant.id,
    name: merchant.name,
    color: merchant.color,
    kind: merchant.kind as MerchantKind,
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
  // PER-213 / locked "one contact = payee + debt-party": when true, a
  // case-insensitive name collision is REUSED instead of rejected, and the
  // existing merchant is promoted to the requested `kind` (e.g. a "business"
  // payee that already exists becomes a "person" debt-party) inside the same
  // tenant transaction with an audit row. Person creation passes this; ordinary
  // quick-create keeps the strict duplicate-name error.
  reuseExisting = false,
}: {
  data: z.input<typeof createMerchantInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
  reuseExisting?: boolean
}): Promise<SerializedMerchant> {
  const data: CreateMerchantInput = createMerchantInputSchema.parse(rawData)
  const trimmedName = data.name.trim()
  const color = data.color ?? null
  const kind = data.kind
  const requestHash = await hashCanonicalPayload({
    color,
    kind,
    name: trimmedName,
  })
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

      let merchant: Merchant
      if (existing) {
        if (!reuseExisting)
          throw new DuplicateNameError("Merchant", trimmedName)
        // Reuse the existing contact. Promote its kind if the caller asks for a
        // different one (business payee → person debt-party), auditing the
        // before/after inside this same transaction.
        if (existing.kind !== kind) {
          const before = serializeMerchant(existing)
          merchant = await tx.merchant.update({
            where: { id: existing.id },
            data: { kind },
          })
          await auditLog(tx, auditCtx, {
            action: "update",
            entityType: "Merchant",
            entityId: merchant.id,
            before,
            after: serializeMerchant(merchant),
          })
        } else {
          merchant = existing
        }
      } else {
        merchant = await tx.merchant.create({
          data: { familyId, name: trimmedName, color, kind },
        })
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Merchant",
          entityId: merchant.id,
          after: serializeMerchant(merchant),
        })
      }

      const serialized = serializeMerchant(merchant)
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
      // A concurrent create won the name race. For reuse callers, retry once so
      // the pre-check now finds and reuses (and promotes) the winning row
      // instead of surfacing a duplicate-name error.
      if (reuseExisting) return await runOnce()
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
