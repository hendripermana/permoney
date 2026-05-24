import { Prisma } from "@prisma/client"

export type AuditAction = "create" | "update" | "soft_delete" | "delete"

export interface AuditContext {
  session: {
    user: {
      id: string
      familyId: string | null
    }
  }
  requestId: string
  idempotencyKey?: string | null
  ip?: string | null
  userAgent?: string | null
}

const SENSITIVE_KEY_PATTERNS = ["password", "token", "secret"] as const

/**
 * Mengonversi nilai secara aman ke format yang kompatibel dengan JSON (tidak ada BigInt),
 * menangani Date, undefined, serta menyensor data sensitif (password, token, dll).
 */
export function safeJsonCanonicalize(val: unknown): unknown {
  if (val === null || val === undefined) {
    return null
  }

  if (typeof val === "bigint") {
    return val.toString()
  }

  if (val instanceof Date) {
    return val.toISOString()
  }

  if (Array.isArray(val)) {
    return val.map((item) => {
      if (item === undefined) {
        return null // Menjaga urutan/posisi indeks array
      }
      return safeJsonCanonicalize(item)
    })
  }

  if (typeof val === "object") {
    const res: Record<string, unknown> = {}
    const obj = val as Record<string, unknown>

    for (const key of Object.keys(obj)) {
      const v = obj[key]
      if (v === undefined) {
        continue // Omit undefined properties
      }

      const normalizedKey = key.toLowerCase()
      if (
        SENSITIVE_KEY_PATTERNS.some((pattern) =>
          normalizedKey.includes(pattern)
        )
      ) {
        res[key] = "[REDACTED]"
      } else {
        res[key] = safeJsonCanonicalize(v)
      }
    }
    return res
  }

  return val
}

/**
 * Membuat context audit terpadu di awal mutasi.
 * Fungsi ini server-only dan menggunakan dynamic import untuk mencegah kebocoran modul server.
 */
export async function createAuditContext(
  session: { user: { id: string; familyId?: string | null } },
  idempotencyKey?: string | null
): Promise<AuditContext> {
  const { getRequest } = await import("@tanstack/react-start/server")
  let ip: string | null = null
  let userAgent: string | null = null
  let requestId: string | null = null

  try {
    const req = getRequest()
    userAgent = req.headers.get("user-agent")
    requestId = req.headers.get("x-request-id")

    ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null
  } catch {
    // Abaikan jika tidak berjalan dalam context HTTP request (misalnya unit test)
  }

  if (!requestId) {
    requestId = crypto.randomUUID()
  }

  return {
    session: {
      user: {
        id: session.user.id,
        familyId: session.user.familyId ?? null,
      },
    },
    requestId,
    idempotencyKey: idempotencyKey ?? null,
    ip,
    userAgent,
  }
}

/**
 * Menulis baris audit ke database di bawah transaksi yang sama.
 */
export async function auditLog(
  tx: Prisma.TransactionClient,
  ctx: AuditContext,
  entry: {
    action: AuditAction
    entityType: string
    entityId: string
    before?: unknown
    after?: unknown
    familyId?: string // override opsional untuk onboarding
  }
): Promise<void> {
  const familyId = entry.familyId ?? ctx.session.user.familyId
  if (!familyId) {
    throw new Error("Cannot write audit log without familyId")
  }

  await tx.auditLog.create({
    data: {
      familyId,
      userId: ctx.session.user.id,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson:
        entry.before === undefined
          ? Prisma.DbNull
          : (safeJsonCanonicalize(entry.before) as Prisma.InputJsonValue),
      afterJson:
        entry.after === undefined
          ? Prisma.DbNull
          : (safeJsonCanonicalize(entry.after) as Prisma.InputJsonValue),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
      idempotencyKey: ctx.idempotencyKey ?? null,
    },
  })
}
