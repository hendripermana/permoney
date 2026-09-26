/**
 * Is this request a DIRECT internal probe (Docker HEALTHCHECK, an operator's
 * `curl` on the VM) rather than public traffic that passed through the edge?
 *
 * Production ingress is Cloudflare -> Caddy -> the app, and both hops stamp
 * client-identifying headers (`CF-Connecting-IP`, `X-Forwarded-For`). The origin
 * firewall only admits Cloudflare's ranges (docs/runbook-production.md), so an
 * outside caller cannot reach the app without those headers being present.
 * A request with none of them is a loopback probe.
 *
 * Used to keep `/api/health?full=1` (last applied migration, connection
 * saturation) off the public internet without introducing a shared secret.
 * Best-effort infra hygiene, NOT an authorization boundary: never use it to
 * guard tenant data.
 */
export function isDirectInternalRequest(headers: Headers): boolean {
  return (
    !headers.has("cf-connecting-ip") &&
    !headers.has("x-forwarded-for") &&
    !headers.has("x-real-ip")
  )
}
