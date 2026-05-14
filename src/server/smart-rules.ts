import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  familyMiddleware,
  createTenantDb,
  scopedTx,
  withGuc,
} from "./middleware/with-family"

/**
 * 1. GET ALL RULES — tenant-scoped via familyMiddleware + RLS GUC
 */
export const getSmartRulesFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return withGuc(context.familyId, async () => {
      const db = createTenantDb(context.familyId)
      return db.smartRule.findMany({
        include: { category: true, merchant: true },
        orderBy: { createdAt: "desc" },
      })
    })
  })

/**
 * 2. CREATE NEW RULE — tenant-scoped via familyMiddleware + scopedTx
 */
const createRuleSchema = z.object({
  keyword: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
})

export const createSmartRuleFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof createRuleSchema>) =>
    createRuleSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return scopedTx(context.familyId, async (tx) => {
      return tx.smartRule.create({
        data: {
          keyword: data.keyword.toLowerCase(),
          categoryId: data.categoryId,
          merchantId: data.merchantId,
          familyId: context.familyId,
        },
      })
    })
  })

/**
 * 3. DELETE RULE — tenant-scoped via familyMiddleware + scopedTx
 */
export const deleteSmartRuleFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    return scopedTx(context.familyId, async (tx) => {
      const res = await tx.smartRule.deleteMany({
        where: { id: data.id, familyId: context.familyId },
      })
      if (res.count !== 1)
        throw new Error("Smart rule not found or access denied")
      return { success: true, deletedId: data.id }
    })
  })
