import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  scopedTenantTransaction,
} from "./middleware/with-family"
import { validateTenantReferences } from "./validation/tenant-references"

/**
 * 1. GET ALL RULES — tenant-scoped via familyMiddleware + RLS GUC
 */
export const getSmartRulesFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return scopedTenantTransaction(context.familyId, async (tx) => {
      return tx.smartRule.findMany({
        where: { familyId: context.familyId },
        include: { category: true, merchant: true },
        orderBy: { createdAt: "desc" },
      })
    })
  })

/**
 * 2. CREATE NEW RULE — tenant-scoped via familyMiddleware + scopedTenantTransaction
 */
const createRuleSchema = z.object({
  keyword: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
})

export async function createSmartRuleForFamily({
  data,
  familyId,
  user,
}: {
  data: z.infer<typeof createRuleSchema>
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return scopedTenantTransaction(familyId, async (tx) => {
    // The three awaits below run sequentially by design:
    //   1. `validateTenantReferences(tx, ...)` — queries through `tx`.
    //   2. `tx.smartRule.create(...)` — must wait for validation to pass and
    //      runs on the same pg connection.
    //   3. `auditLog(tx, ...)` — same connection AND it needs `newRule.id`
    //      from step 2.
    // pg@9 rejects concurrent `client.query()` on the same connection (see
    // src/server/middleware/with-family.ts), and step 3 has a logical
    // dependency on step 2. React Doctor's `async-parallel` rule cannot see
    // either constraint; the warning is a false positive.

    // PER-94: validate the rule's references before insert.
    await validateTenantReferences(tx, familyId, {
      categoryId: data.categoryId,
      merchantId: data.merchantId,
    })

    const newRule = await tx.smartRule.create({
      data: {
        keyword: data.keyword.toLowerCase(),
        categoryId: data.categoryId,
        merchantId: data.merchantId,
        familyId,
      },
    })

    await auditLog(tx, auditCtx, {
      action: "create",
      entityType: "SmartRule",
      entityId: newRule.id,
      before: null,
      after: newRule,
    })

    return newRule
  })
}

export async function deleteSmartRuleForFamily({
  id,
  familyId,
  user,
}: {
  id: string
  familyId: string
  user: { id: string; familyId?: string | null }
}) {
  const auditCtx = await createAuditContext({ user })
  return scopedTenantTransaction(familyId, async (tx) => {
    const oldRule = await tx.smartRule.findFirst({
      where: { id, familyId },
    })
    if (!oldRule) {
      throw new Error("Smart rule not found or access denied")
    }

    await tx.smartRule.delete({
      where: { id },
    })

    await auditLog(tx, auditCtx, {
      action: "delete",
      entityType: "SmartRule",
      entityId: id,
      before: oldRule,
      after: null,
    })

    return { success: true, deletedId: id }
  })
}

export const createSmartRuleFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof createRuleSchema>) =>
    createRuleSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createSmartRuleForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

/**
 * 3. DELETE RULE — tenant-scoped via familyMiddleware + scopedTenantTransaction
 */
export const deleteSmartRuleFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    return await deleteSmartRuleForFamily({
      id: data.id,
      familyId: context.familyId,
      user: context.user,
    })
  })
