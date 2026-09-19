// =============================================================================
// ADR-0057 — pure helpers for the family-invite bearer token and accept link.
//
// Deliberately isomorphic and free of Node built-ins (Web Crypto only): the
// module that owns the invite server functions is reachable from the client
// graph, so it must not statically pull `node:crypto`. Everything here is pure
// and unit-tested without a database.
// =============================================================================

/** How long an invite link stays valid after it is created or re-sent. */
export const INVITE_TTL_DAYS = 7

export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000

/** Invite emails are compared and stored normalized: trim + lowercase. */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase()
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

/**
 * A fresh 256-bit bearer token (43 base64url chars). It lives only in the
 * emailed link; the database stores `hashInviteToken(raw)` and nothing else.
 */
export function generateInviteToken(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)))
}

/** sha256(rawToken) as lowercase hex — the only form ever persisted. */
export async function hashInviteToken(rawToken: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawToken)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/**
 * The canonical origin the accept link points at: the existing
 * `BETTER_AUTH_URL` (already the app's canonical public origin). In production
 * an unset value is a misconfiguration and throws — falling back to the request
 * origin there would let a forged `Host` header mint links to another domain.
 * Outside production it falls back to the request origin so local dev works
 * without extra config.
 */
export function resolveInviteBaseUrl(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.BETTER_AUTH_URL?.trim()
  if (configured) return configured.replace(/\/+$/, "")
  if (env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_URL is not set — cannot build the family invitation link. " +
        "Set it to the app's canonical origin (see .env.example)."
    )
  }
  return new URL(requestUrl).origin
}

export function buildInviteAcceptUrl(
  baseUrl: string,
  rawToken: string
): string {
  return `${baseUrl}/invite/accept?token=${encodeURIComponent(rawToken)}`
}
