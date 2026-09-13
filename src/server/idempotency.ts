export class IdempotencyConflictError extends Error {
  statusCode = 409

  constructor(message = "Idempotency key reused with a different payload") {
    super(message)
    this.name = "IdempotencyConflictError"
  }
}

export const IDEMPOTENCY_RECORD_TTL_MS = 24 * 60 * 60 * 1000

export async function hashCanonicalPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(toCanonicalJson(payload))
  )
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

// NOTE: deliberately NOT the same function as `safeJsonCanonicalize` in
// middleware/audit.ts. This one SORTS object keys so two request payloads that
// differ only in key order produce the same hash; the audit variant preserves
// order and redacts sensitive keys instead. They look similar but have
// different contracts — merging them would either leak secrets into AuditLog
// (losing redaction) or make idempotency hashes key-order-dependent (losing
// conflict detection). See the mirror note in audit.ts.
export function toCanonicalJson(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toCanonicalJson(item))
  if (typeof value === "object") {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort(compareStableText)) {
      const item = source[key]
      if (item !== undefined) {
        result[key] = toCanonicalJson(item)
      }
    }
    return result
  }
  return value
}

function compareStableText(left: string, right: string): number {
  return left.localeCompare(right)
}
