import { createServerFn } from "@tanstack/react-start"
import { prisma } from "./db.server"
import { z } from "zod"

/**
 * 1. GET ALL RULES
 */
export const getSmartRulesFn = createServerFn({ method: "GET" }).handler(
  async () => {
    return prisma.smartRule.findMany({
      include: {
        category: true,
        merchant: true,
      },
      orderBy: { createdAt: "desc" },
    })
  }
)

/**
 * 2. CREATE NEW RULE
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
  .handler(async ({ data }) => {
    // Borrow default user for multi-tenant simulation
    const user = await prisma.user.findFirst()
    if (!user) throw new Error("User not found")

    return prisma.smartRule.create({
      data: {
        keyword: data.keyword.toLowerCase(), // store as lowercase for easy matching
        categoryId: data.categoryId,
        merchantId: data.merchantId,
        familyId: user.familyId,
      },
    })
  })

/**
 * 3. DELETE RULE
 */
export const deleteSmartRuleFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    return prisma.smartRule.delete({
      where: { id: data.id },
    })
  })
