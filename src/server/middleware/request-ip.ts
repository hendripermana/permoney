// PER-audit-2026-09-13 (CommandCode finding #5) — trusted client-IP extraction.
//
// Production ingress is Cloudflare-only: docs/runbook-production.md's "Network
// hardening" section documents the host firewall restricting inbound 80/443 to
// Cloudflare's published IP ranges, verified live (direct curl to the VM's own
// IP times out). Caddy then reverse-proxies to the app on 127.0.0.1 only. That
// means every request this app ever sees genuinely passed through Cloudflare's
// edge, so `CF-Connecting-IP` — set/overwritten by Cloudflare itself, never by
// the client — is the trustworthy real-client-IP source here.
//
// `X-Forwarded-For`'s FIRST entry is NOT trustworthy: a client can send its own
// `X-Forwarded-For` header, and a proxy chain conventionally APPENDS rather
// than strips it, so the leftmost value can be attacker-chosen text. Both the
// login/signup rate limiter (rate-limit.ts) and the audit log (audit.ts) used
// to read that leftmost entry — a spoofable throttle key, and audit rows that
// record whatever IP string the client felt like sending.
export function getTrustedClientIp(headers: Headers): string | null {
  const cfConnectingIp = headers.get("cf-connecting-ip")?.trim()
  if (cfConnectingIp) return cfConnectingIp

  // Local dev / any deployment without Cloudflare in front: best-effort only,
  // never used in production (CF-Connecting-IP is always present there).
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  if (forwardedFor) return forwardedFor

  return headers.get("x-real-ip")?.trim() || null
}
