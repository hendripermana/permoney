import { createServerFn } from "@tanstack/react-start"
import type { Tag } from "@prisma/client"
import { z } from "zod"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
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
// PER-145 — free-form, family-scoped Tags on Transaction.
//
// A category answers "what kind of spend"; a tag answers an orthogonal
// question ("is this reimbursable", "is this for trip X") and a transaction
// can carry several. Modeled as the closest existing precedent — a plain
// tenant-owned taxonomy row (Merchant's shape: no isSystem split, no parent
// hierarchy) plus a join table — rather than a heavier or lighter mutation
// contract than Category/Merchant already establish. Every mutation gets the
// same contract as Category/Merchant create (ADR-0008): an interactive
// `prisma.$transaction` with the `app.family_id`/`app.user_id` RLS GUCs set on
// the same transaction, an accepted idempotency key replayed through
// `IdempotencyRecord`, and an append-only `AuditLog` row in the same
// transaction. A Tag never touches an amount or balance, so it does NOT get
// Transaction-grade concurrency/serializable-retry machinery — CLAUDE.md §5A
// targets money-moving ledger data specifically.
// =============================================================================

const CREATE_TAG_ENDPOINT = "createTagFn"
const RENAME_TAG_ENDPOINT = "renameTagFn"
const ARCHIVE_TAG_ENDPOINT = "archiveTagFn"
const SET_TRANSACTION_TAGS_ENDPOINT = "setTransactionTagsFn"
const TAG_NAME_DEDUP_INDEX = "Tag_familyId_lower_name_key"
const DEFAULT_COLOR = "#6172F3"
const MAX_TAGS_PER_TRANSACTION = 50

const nameSchema = z.string().trim().min(1).max(60)
const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #RRGGBB hex value")

/**
 * Raised when a mutation references a `tagId` that does not resolve to a
 * tenant-owned tag of this family. Foreign keys alone are not tenant
 * isolation (CLAUDE.md §5A) — validated inside the same transaction before
 * any write.
 */
export class TagNotFoundError extends Error {
  override readonly name = "TagNotFoundError"
  readonly statusCode = 404
  constructor(readonly tagId: string) {
    super(`Tag ${tagId} not found for this family`)
  }
}

/**
 * Raised when `setTransactionTagsFn` targets a `transactionId` that does not
 * resolve to a tenant-owned, non-deleted transaction of this family.
 */
export class TagTransactionNotFoundError extends Error {
  override readonly name = "TagTransactionNotFoundError"
  readonly statusCode = 404
  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} not found for this family`)
  }
}

export interface SerializedTag {
  id: string
  name: string
  color: string
  archivedAt: string | null
}

function serializeTag(tag: Tag): SerializedTag {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    archivedAt: tag.archivedAt ? tag.archivedAt.toISOString() : null,
  }
}

// ===========================================================================
// READ — list a family's tags (used by the transaction form's tag picker and
// available for a future "manage tags" settings surface).
// ===========================================================================

export const listTagsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }): Promise<SerializedTag[]> => {
    return await scopedTenantTransaction(
      context.familyId,
      context.user.id,
      async (tx) => {
        const tags = await tx.tag.findMany({
          where: { familyId: context.familyId },
          orderBy: { name: "asc" },
        })
        return tags.map(serializeTag)
      }
    )
  })

// ===========================================================================
// WRITE — create
// ===========================================================================

export const createTagInputSchema = z.object({
  name: nameSchema,
  color: hexColorSchema.optional(),
  idempotencyKey: uuidV7Schema,
})

type CreateTagInput = z.infer<typeof createTagInputSchema>

export async function createTagForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createTagInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedTag> {
  const data: CreateTagInput = createTagInputSchema.parse(rawData)
  const trimmedName = data.name.trim()
  const color = data.color ?? DEFAULT_COLOR
  const requestHash = await hashCanonicalPayload({
    color,
    name: trimmedName,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedTag>(tx, {
        endpoint: CREATE_TAG_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay

      // Pre-check for a clean, well-typed error. The functional unique index
      // (migration `tags`) is the durable backstop for the concurrent
      // double-submit race.
      const existing = await tx.tag.findFirst({
        where: { familyId, name: { equals: trimmedName, mode: "insensitive" } },
      })
      if (existing) throw new DuplicateNameError("Tag", trimmedName)

      const tag = await tx.tag.create({
        data: { familyId, name: trimmedName, color },
      })

      const serialized = serializeTag(tag)
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Tag",
        entityId: tag.id,
        after: serialized,
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_TAG_ENDPOINT,
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
    if (isNameDedupConstraintError(error, TAG_NAME_DEDUP_INDEX)) {
      throw new DuplicateNameError("Tag", trimmedName)
    }
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedTag>(tx, {
        endpoint: CREATE_TAG_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const createTagFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof createTagInputSchema>) =>
    createTagInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createTagForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// WRITE — rename
// ===========================================================================

export const renameTagInputSchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  idempotencyKey: uuidV7Schema,
})

type RenameTagInput = z.infer<typeof renameTagInputSchema>

export async function renameTagForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof renameTagInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedTag> {
  const data: RenameTagInput = renameTagInputSchema.parse(rawData)
  const trimmedName = data.name.trim()
  const requestHash = await hashCanonicalPayload({
    id: data.id,
    name: trimmedName,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedTag>(tx, {
        endpoint: RENAME_TAG_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay

      const existingTag = await tx.tag.findFirst({
        where: { id: data.id, familyId },
      })
      if (!existingTag) throw new TagNotFoundError(data.id)

      const collision = await tx.tag.findFirst({
        where: {
          familyId,
          id: { not: data.id },
          name: { equals: trimmedName, mode: "insensitive" },
        },
      })
      if (collision) throw new DuplicateNameError("Tag", trimmedName)

      const before = serializeTag(existingTag)
      const updated = await tx.tag.update({
        where: { id: data.id },
        data: { name: trimmedName },
      })
      const serialized = serializeTag(updated)

      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "Tag",
        entityId: updated.id,
        before,
        after: serialized,
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: RENAME_TAG_ENDPOINT,
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
    if (isNameDedupConstraintError(error, TAG_NAME_DEDUP_INDEX)) {
      throw new DuplicateNameError("Tag", trimmedName)
    }
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedTag>(tx, {
        endpoint: RENAME_TAG_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const renameTagFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof renameTagInputSchema>) =>
    renameTagInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await renameTagForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// WRITE — archive (soft "delete")
//
// Mirrors Account/Transaction's soft-delete convention: an archived tag
// disappears from the picker but stays attached to whatever history already
// carries it. Naturally idempotent regardless of idempotency-key reuse — a
// second archive call on an already-archived tag is a no-op success, not an
// error (matches the ledger's "delete must be idempotent" contract, CLAUDE.md
// §5A, extended here even though a Tag never touches a balance).
// ===========================================================================

export const archiveTagInputSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

type ArchiveTagInput = z.infer<typeof archiveTagInputSchema>

export async function archiveTagForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof archiveTagInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedTag> {
  const data: ArchiveTagInput = archiveTagInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({ id: data.id })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedTag>(tx, {
        endpoint: ARCHIVE_TAG_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay

      const existingTag = await tx.tag.findFirst({
        where: { id: data.id, familyId },
      })
      if (!existingTag) throw new TagNotFoundError(data.id)

      let serialized: SerializedTag
      if (existingTag.archivedAt) {
        // Already archived — no-op, but the idempotency record still gets
        // written so a replay of THIS call is stable too.
        serialized = serializeTag(existingTag)
      } else {
        const before = serializeTag(existingTag)
        const updated = await tx.tag.update({
          where: { id: data.id },
          data: { archivedAt: new Date() },
        })
        serialized = serializeTag(updated)
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Tag",
          entityId: updated.id,
          before,
          after: serialized,
        })
      }

      await persistIdempotentEndpointResponse(tx, {
        endpoint: ARCHIVE_TAG_ENDPOINT,
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
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedTag>(tx, {
        endpoint: ARCHIVE_TAG_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const archiveTagFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof archiveTagInputSchema>) =>
    archiveTagInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await archiveTagForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// WRITE — set (full-replace) a transaction's tags
//
// Mirrors `setBudgetAllocationsFn`'s full-replace shape (the closest existing
// precedent for "replace this entity's set of related rows" in one call):
// upsert every requested tag attachment, delete the rest. Re-sending the same
// set is a no-op; attaching an already-attached tag is a no-op via the
// (transactionId, tagId) unique constraint, never a duplicate row.
// ===========================================================================

export const setTransactionTagsInputSchema = z.object({
  transactionId: z.string().min(1),
  tagIds: z.array(z.string().min(1)).max(MAX_TAGS_PER_TRANSACTION),
  idempotencyKey: uuidV7Schema,
})

type SetTransactionTagsInput = z.infer<typeof setTransactionTagsInputSchema>

export interface SetTransactionTagsResult {
  transactionId: string
  tags: SerializedTag[]
}

async function validateTenantOwnedTags(
  tx: TenantTransactionClient,
  familyId: string,
  tagIds: string[]
): Promise<void> {
  if (tagIds.length === 0) return
  // RLS scopes this to the caller's own family; a cross-tenant id simply
  // never comes back, which we turn into a validation error (tenant-owned
  // reference validation, CLAUDE.md §5A) rather than silently dropping it.
  const tags = await tx.tag.findMany({
    where: { id: { in: tagIds } },
    select: { id: true, familyId: true },
  })
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  for (const tagId of tagIds) {
    const tag = byId.get(tagId)
    if (!tag || tag.familyId !== familyId) throw new TagNotFoundError(tagId)
  }
}

export async function setTransactionTagsForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof setTransactionTagsInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SetTransactionTagsResult> {
  const data: SetTransactionTagsInput =
    setTransactionTagsInputSchema.parse(rawData)
  const uniqueTagIds = Array.from(new Set(data.tagIds))
  const canonicalTagIds = [...uniqueTagIds].sort((a, b) => a.localeCompare(b))
  const requestHash = await hashCanonicalPayload({
    transactionId: data.transactionId,
    tagIds: canonicalTagIds,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SetTransactionTagsResult>(tx, {
          endpoint: SET_TRANSACTION_TAGS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      // Tenant-owned reference validation (CLAUDE.md §5A): the transaction
      // and every tag must belong to this family before any write.
      //
      // The caller's `transactionId` can legitimately go stale between the
      // browser reading it and this call landing: editing ANY field on a
      // transaction replaces it (soft-delete + a new row, `supersededBy`
      // linked — `replaceTransactionWithinTenantTransaction`), and the tag
      // picker's own save fires as a SEPARATE, unawaited request alongside
      // that edit's save (not sequenced client-side). If the edit's replace
      // wins the race, `data.transactionId` now points at a soft-deleted
      // row — rather than fail the whole tagging action, follow
      // `supersededBy` to the transaction that's live NOW and attach there.
      // (The other race direction — tags land on the OLD id BEFORE the
      // replace runs — is handled on the other side, by
      // `replaceTransactionWithinTenantTransaction` re-pointing any existing
      // `TransactionTag` rows onto its new row.) Bounded to a handful of
      // hops so a corrupted cycle can never spin forever.
      let resolvedTransactionId = data.transactionId
      for (let hop = 0; hop < 5; hop++) {
        const row = await tx.transaction.findFirst({
          where: { id: resolvedTransactionId, familyId },
          select: { id: true, deletedAt: true, supersededBy: true },
        })
        if (!row) throw new TagTransactionNotFoundError(data.transactionId)
        if (row.deletedAt === null) break
        if (!row.supersededBy) {
          throw new TagTransactionNotFoundError(data.transactionId)
        }
        resolvedTransactionId = row.supersededBy
      }
      await validateTenantOwnedTags(tx, familyId, uniqueTagIds)

      const existing = await tx.transactionTag.findMany({
        where: { transactionId: resolvedTransactionId },
        select: { tagId: true },
      })
      const existingTagIds = existing.map((row) => row.tagId)
      const existingSet = new Set(existingTagIds)
      const nextSet = new Set(uniqueTagIds)
      const toAdd = uniqueTagIds.filter((tagId) => !existingSet.has(tagId))
      const toRemove = existingTagIds.filter((tagId) => !nextSet.has(tagId))

      if (toAdd.length > 0) {
        await tx.transactionTag.createMany({
          data: toAdd.map((tagId) => ({
            familyId,
            transactionId: resolvedTransactionId,
            tagId,
          })),
          skipDuplicates: true,
        })
      }
      if (toRemove.length > 0) {
        await tx.transactionTag.deleteMany({
          where: {
            transactionId: resolvedTransactionId,
            tagId: { in: toRemove },
          },
        })
      }

      const tags =
        uniqueTagIds.length > 0
          ? await tx.tag.findMany({ where: { id: { in: uniqueTagIds } } })
          : []
      const result: SetTransactionTagsResult = {
        transactionId: resolvedTransactionId,
        tags: tags
          .map(serializeTag)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }

      if (toAdd.length > 0 || toRemove.length > 0) {
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "TransactionTag",
          entityId: resolvedTransactionId,
          before: {
            tagIds: [...existingTagIds].sort((a, b) => a.localeCompare(b)),
          },
          after: { tagIds: canonicalTagIds },
        })
      }

      await persistIdempotentEndpointResponse(tx, {
        endpoint: SET_TRANSACTION_TAGS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: result,
      })
      return result
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SetTransactionTagsResult>(tx, {
        endpoint: SET_TRANSACTION_TAGS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const setTransactionTagsFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof setTransactionTagsInputSchema>) =>
    setTransactionTagsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await setTransactionTagsForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
