import { Prisma } from "@prisma/client"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  requireCapability,
  scopedTenantTransaction,
} from "./middleware/with-family"

// Schema input validator untuk pagination dan filtering audit log
const getAuditLogInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z
    .object({
      createdAt: z.string(), // Format ISO string dari Date
      id: z.string(),
    })
    .optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
})

/**
 * Mengambil data AuditLog terpaginasi secara stabil (cursor-based) untuk keluarga/family tertentu.
 */
export async function getAuditLogForFamily({
  data,
  familyId,
  userId,
}: {
  data: z.infer<typeof getAuditLogInputSchema>
  familyId: string
  userId: string
}) {
  return await scopedTenantTransaction(familyId, userId, async (tx) => {
    const limit = Math.min(data.limit ?? 50, 100)

    // Definisikan filter pencarian dengan tipe data Prisma yang aman
    const where: Prisma.AuditLogWhereInput = {
      familyId,
    }

    if (data.entityType) {
      where.entityType = data.entityType
    }
    if (data.entityId) {
      where.entityId = data.entityId
    }

    // Query database dengan limit + 1 untuk mengetahui apakah ada data selanjutnya (hasNextPage)
    const logs = await tx.auditLog.findMany({
      where,
      take: limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      cursor: data.cursor
        ? {
            createdAt_id: {
              createdAt: new Date(data.cursor.createdAt),
              id: data.cursor.id,
            },
          }
        : undefined,
      // Jika cursor aktif, kita lewati elemen pertama (karena cursor mengembalikan data yang ditunjuk)
      skip: data.cursor ? 1 : undefined,
    })

    const hasNextPage = logs.length > limit
    const items = hasNextPage ? logs.slice(0, limit) : logs

    let nextCursor = null
    if (items.length > 0 && hasNextPage) {
      const lastItem = items[items.length - 1]
      if (lastItem) {
        nextCursor = {
          createdAt: lastItem.createdAt.toISOString(),
          id: lastItem.id,
        }
      }
    }

    return {
      items,
      nextCursor,
      hasNextPage,
    }
  })
}

/**
 * BACKEND FUNCTION: Mengambil data AuditLog terpaginasi secara stabil (cursor-based).
 * Dilindungi oleh familyMiddleware dan berjalan dalam context scopedTenantTransaction.
 */
export const getAuditLogFn = createServerFn({ method: "GET" })
  .middleware([requireCapability("audit:read")])
  .inputValidator((data: z.infer<typeof getAuditLogInputSchema>) =>
    getAuditLogInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getAuditLogForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
