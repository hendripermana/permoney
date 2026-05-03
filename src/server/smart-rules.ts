import { createServerFn } from "@tanstack/react-start"
import { prisma } from "./db.server"
import {
  familyMiddleware,
  createTenantDb,
} from "./middleware/with-family.server"
import { z } from "zod"

/**
 * 1. GET ALL RULES — tenant-scoped via familyMiddleware
 */
export const getSmartRulesFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    const db = createTenantDb(context.familyId)
    return db.smartRule.findMany({
      include: {
        category: true,
        merchant: true,
      },
      orderBy: { createdAt: "desc" },
    })
  })

/**
 * 2. CREATE NEW RULE — tenant-scoped via familyMiddleware
 */
const createRuleSchema = z.object({
  keyword: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
})

export const createSmartRuleFn = createServerFn({ method: "POST" })
  .inputValidator((data: z.infer<typeof createRuleSchema>) =>
    createRuleSchema.parse(data)
  )
  .middleware([familyMiddleware])
  .handler(async ({ data, context }) => {
    return prisma.smartRule.create({
      data: {
        keyword: data.keyword.toLowerCase(), // store as lowercase for easy matching
        categoryId: data.categoryId,
        merchantId: data.merchantId,
        familyId: context.familyId,
      },
    })
  })

/**
 * 3. DELETE RULE — tenant-scoped via familyMiddleware
 * Verifies ownership before deleting via the tenant-scoped client.
 */
export const deleteSmartRuleFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .middleware([familyMiddleware])
  .handler(async ({ data, context }) => {
    const db = createTenantDb(context.familyId)
    // findFirst with the scoped db ensures the rule belongs to this family
    const rule = await db.smartRule.findFirst({ where: { id: data.id } })
    if (!rule) throw new Error("Smart rule not found or access denied")
    return prisma.smartRule.delete({
      where: { id: data.id },
    })
  })
