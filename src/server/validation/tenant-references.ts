import type { TenantTransactionClient } from "../middleware/with-family"

/**
 * Cross-tenant reference rejection.
 *
 * Carries the offending field path, the referenced ID, and the active family
 * so the client can surface a field-level diagnostic. See ADR-0011 for the
 * design rationale and the relationship with the PER-104 database backstop.
 *
 * The class is intentionally minimal. M3-5 will introduce the broader
 * `AppError` / `ValidationError` hierarchy across the entire server tree;
 * consumers that depend on `error.name === "TenantReferenceError"` plus the
 * three structured fields survive that future migration without changes.
 */
export class TenantReferenceError extends Error {
  override readonly name = "TenantReferenceError"
  constructor(
    readonly field: string,
    readonly referenceId: string,
    readonly familyId: string
  ) {
    super(
      `Cross-tenant reference rejected: ${field}=${referenceId} does not belong to family ${familyId}`
    )
  }
}

/**
 * PER-260: `categoryId` resolved to a tenant/system category, but not one of
 * the `Category.type` the caller requires for this mutation (e.g. a
 * reimbursement-kind income row must point at an EXPENSE category). Kept
 * distinct from `TenantReferenceError` because the failure is a business-rule
 * mismatch, not a cross-tenant/ownership violation — the category is valid,
 * just the wrong shape for this operation.
 */
export class CategoryTypeMismatchError extends Error {
  override readonly name = "CategoryTypeMismatchError"
  constructor(
    readonly field: string,
    readonly categoryId: string,
    readonly expectedType: string
  ) {
    super(`Category ${categoryId} (${field}) must be of type ${expectedType}`)
  }
}

export interface TenantReferenceSplitEntry {
  categoryId?: string | null
  merchantId?: string | null
}

export interface TenantReferenceCheck {
  accountId?: string | null
  toAccountId?: string | null
  merchantId?: string | null
  categoryId?: string | null
  // PER-260: when set, `categoryId` must resolve to a Category of this exact
  // `type` (in addition to the existing tenant-or-system ownership check).
  // Optional — omitting it preserves today's behavior of accepting any
  // category type for the transaction's own type.
  categoryType?: "income" | "expense"
  splitEntries?: ReadonlyArray<TenantReferenceSplitEntry>
}

/**
 * Validate that every tenant-owned reference in `refs` belongs to `familyId`.
 *
 * The lookup queries run on the caller's transaction client (`tx`) so they
 * inherit the same `app.family_id` GUC and run inside the same Postgres
 * transaction as the eventual mutation. A `null` or `undefined` reference is
 * a no-op for that field; explicitly missing references are not validated.
 *
 * `categoryId` accepts either a tenant row (`familyId = familyId`) OR a
 * global system row (`isSystem = true AND familyId IS NULL`), mirroring
 * ADR-0009 and ADR-0010.
 *
 * Throws `TenantReferenceError` on the first failed reference. The check is
 * sequential rather than parallel because pg's interactive transaction uses
 * one connection; concurrent queries on the same `tx` are rejected by
 * pg@9. See `src/server/middleware/with-family.ts` for the contract.
 */
export async function validateTenantReferences(
  tx: TenantTransactionClient,
  familyId: string,
  refs: TenantReferenceCheck
): Promise<void> {
  if (refs.accountId) {
    await assertAccountInFamily(tx, refs.accountId, familyId, "accountId")
  }
  if (refs.toAccountId) {
    await assertAccountInFamily(tx, refs.toAccountId, familyId, "toAccountId")
  }
  if (refs.merchantId) {
    await assertMerchantInFamily(tx, refs.merchantId, familyId, "merchantId")
  }
  if (refs.categoryId) {
    await assertCategoryInFamilyOrSystem(
      tx,
      refs.categoryId,
      familyId,
      "categoryId",
      refs.categoryType
    )
  }
  if (refs.splitEntries) {
    // The loop awaits sequentially on purpose: every `assertX` call queries
    // through `tx`, the single pg connection backing this Prisma interactive
    // transaction. pg@9 rejects concurrent `client.query()` on the same
    // connection — see the file-level docstring above and the integration
    // test `pg-client-query-deprecation.integration.ts`. React Doctor's
    // `async-await-in-loop` rule is a false positive here.
    for (let index = 0; index < refs.splitEntries.length; index += 1) {
      const entry = refs.splitEntries[index]
      if (entry?.categoryId) {
        await assertCategoryInFamilyOrSystem(
          tx,
          entry.categoryId,
          familyId,
          `splitEntries[${index}].categoryId`
        )
      }
      if (entry?.merchantId) {
        await assertMerchantInFamily(
          tx,
          entry.merchantId,
          familyId,
          `splitEntries[${index}].merchantId`
        )
      }
    }
  }
}

async function assertAccountInFamily(
  tx: TenantTransactionClient,
  id: string,
  familyId: string,
  field: string
): Promise<void> {
  // PER-183: a soft-deleted account is not a valid write target — it must
  // stay gone for every future mutation, not just disappear from the UI.
  // `deletedAt: null` here means "not found" for a deleted account, same as
  // for a genuinely cross-tenant one.
  const row = await tx.account.findFirst({
    select: { id: true },
    where: { id, familyId, deletedAt: null },
  })
  if (!row) {
    throw new TenantReferenceError(field, id, familyId)
  }
}

async function assertMerchantInFamily(
  tx: TenantTransactionClient,
  id: string,
  familyId: string,
  field: string
): Promise<void> {
  const row = await tx.merchant.findFirst({
    select: { id: true },
    where: { id, familyId },
  })
  if (!row) {
    throw new TenantReferenceError(field, id, familyId)
  }
}

async function assertCategoryInFamilyOrSystem(
  tx: TenantTransactionClient,
  id: string,
  familyId: string,
  field: string,
  requiredType?: "income" | "expense"
): Promise<void> {
  const row = await tx.category.findFirst({
    select: { id: true, type: true },
    where: {
      id,
      OR: [{ familyId }, { isSystem: true, familyId: null }],
    },
  })
  if (!row) {
    throw new TenantReferenceError(field, id, familyId)
  }
  if (requiredType && row.type !== requiredType) {
    throw new CategoryTypeMismatchError(field, id, requiredType)
  }
}
