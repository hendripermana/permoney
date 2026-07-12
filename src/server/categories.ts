import { createServerFn } from "@tanstack/react-start"
import type { Category } from "@prisma/client"
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
// PER-189 — quick-create Category from the transaction form.
//
// Same mutation contract as every other ledger-adjacent write (ADR-0008): an
// interactive `prisma.$transaction` with the `app.family_id` RLS GUC set on
// the same transaction, an accepted idempotency key replayed through
// `IdempotencyRecord`, and an append-only `AuditLog` row written inside the
// same transaction.
//
// Quick-created categories are always tenant-owned (isSystem=false,
// familyId set) — the DB CHECK `category_system_familyid_consistency`
// (migration `harden_category_system_rls`) backstops this. `parentId` is
// accepted (and tenant/type validated) so a caller with more context than the
// inline transaction-form combobox can nest a category, but the quick-create
// UI itself only offers a flat/top-level create — full parent management
// stays in PER-167.
// =============================================================================

const CREATE_CATEGORY_ENDPOINT = "createCategoryFn"
const CATEGORY_NAME_DEDUP_INDEX = "Category_familyId_lower_name_key"
const DEFAULT_COLOR = "#6172F3"
const DEFAULT_ICON = "shapes"

/**
 * Raised when a create references a `parentId` that does not resolve to a
 * tenant-owned category of the same family. Foreign keys alone are not
 * tenant isolation (CLAUDE.md ledger core rules) — this is validated inside
 * the same transaction before any write.
 */
export class CategoryNotFoundError extends Error {
  override readonly name = "CategoryNotFoundError"
  readonly statusCode = 404
  constructor(readonly categoryId: string) {
    super(`Category ${categoryId} not found for this family`)
  }
}

/**
 * Raised for category-input rejections that are real domain violations, not
 * schema shape errors (e.g. a parent/child type mismatch).
 */
export class CategoryValidationError extends Error {
  override readonly name = "CategoryValidationError"
  readonly statusCode = 422
}

const nameSchema = z.string().trim().min(1).max(120)
const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #RRGGBB hex value")
const iconSchema = z.string().trim().min(1).max(64)
const categoryTypeSchema = z.enum(["expense", "income"])

export const createCategoryInputSchema = z.object({
  name: nameSchema,
  type: categoryTypeSchema,
  color: hexColorSchema.optional(),
  icon: iconSchema.optional(),
  parentId: z.string().min(1).optional(),
  idempotencyKey: uuidV7Schema,
})

type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>

export interface SerializedCategory {
  id: string
  name: string
  type: string
  color: string
  icon: string
  parentId: string | null
}

function serializeCategory(category: Category): SerializedCategory {
  return {
    id: category.id,
    name: category.name,
    type: category.type,
    color: category.color,
    icon: category.icon,
    parentId: category.parentId,
  }
}

interface ServerUser {
  id: string
}

export async function createCategoryForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createCategoryInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedCategory> {
  const data: CreateCategoryInput = createCategoryInputSchema.parse(rawData)
  const trimmedName = data.name.trim()
  const color = data.color ?? DEFAULT_COLOR
  const icon = data.icon ?? DEFAULT_ICON
  const requestHash = await hashCanonicalPayload({
    color,
    icon,
    name: trimmedName,
    parentId: data.parentId ?? null,
    type: data.type,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedCategory>(
        tx,
        {
          endpoint: CREATE_CATEGORY_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      if (data.parentId) {
        const parent = await tx.category.findFirst({
          where: { id: data.parentId, familyId, isSystem: false },
        })
        if (!parent) throw new CategoryNotFoundError(data.parentId)
        if (parent.type !== data.type) {
          throw new CategoryValidationError(
            `Parent category type (${parent.type}) does not match the new category's type (${data.type})`
          )
        }
      }

      // Pre-check catches the common case with a clean, well-typed error. The
      // functional unique index (migration `merchant_category_name_dedup`) is
      // the durable backstop for the concurrent-double-submit race.
      const existing = await tx.category.findFirst({
        where: { familyId, name: { equals: trimmedName, mode: "insensitive" } },
      })
      if (existing) throw new DuplicateNameError("Category", trimmedName)

      const category = await tx.category.create({
        data: {
          familyId,
          name: trimmedName,
          type: data.type,
          color,
          icon,
          parentId: data.parentId ?? null,
          isSystem: false,
        },
      })

      const serialized = serializeCategory(category)
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Category",
        entityId: category.id,
        after: serialized,
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_CATEGORY_ENDPOINT,
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
    if (isNameDedupConstraintError(error, CATEGORY_NAME_DEDUP_INDEX)) {
      throw new DuplicateNameError("Category", trimmedName)
    }
    // A concurrent request with the same key may win the IdempotencyRecord
    // unique race; resolve it by replaying the stored response.
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        replayIdempotentEndpointResponse<SerializedCategory>(tx, {
          endpoint: CREATE_CATEGORY_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export const createCategoryFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof createCategoryInputSchema>) =>
    createCategoryInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createCategoryForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })
