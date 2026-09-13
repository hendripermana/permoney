import { createFileRoute } from "@tanstack/react-router"

// CommandCode audit finding #4 — native better-auth endpoints bypass the
// app's rate limiter.
//
// `src/server/auth-fns.ts`'s loginFn/signupFn call `checkRateLimit` (ADR-0004:
// 5 req/15min login, 3 req/hour signup) before ever touching better-auth, but
// that only protects callers who go through those server functions. This
// route forwards every request straight into `auth.handler`, which is
// better-auth's own router and serves `/api/auth/sign-in/email` and
// `/api/auth/sign-up/email` directly — a client that calls those paths
// itself (skipping the app's UI/server-fn layer entirely) never hits
// `checkRateLimit`. Gate the same two endpoints here too, as defense in
// depth; auth-fns.ts keeps its own check since the UI still goes through it.
//
// Matched by path SUFFIX rather than an exact `/api/auth/...` string so this
// stays correct if `betterAuth()`'s `basePath` ever changes — better-auth's
// own internal route matching (see e.g. its two-factor/captcha plugins)
// likewise compares against the un-prefixed `/sign-in/email` /
// `/sign-up/email` path.
const SIGN_IN_EMAIL_SUFFIX = "/sign-in/email"
const SIGN_UP_EMAIL_SUFFIX = "/sign-up/email"

function rateLimitResponse(resetAt: Date): Response {
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((resetAt.getTime() - Date.now()) / 1000)
  )
  // Mirrors better-auth's own built-in rate-limiter response shape
  // (dist/api/rate-limiter): 429 + `{ message }` body + a retry-after
  // header, so any caller (including better-auth's own client) sees a
  // familiar shape regardless of which layer rejected the request.
  return new Response(
    JSON.stringify({ message: "Too many requests. Please try again later." }),
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "content-type": "application/json",
        "X-Retry-After": retryAfterSeconds.toString(),
      },
    }
  )
}

/**
 * Best-effort extraction of the `email` field from a sign-in/sign-up request
 * body, used only as the rate limiter's secondary key (matching how
 * auth-fns.ts keys on `data.email`). Reads a clone so the original request
 * body stream is left intact for `auth.handler` to parse. A malformed or
 * non-JSON body simply falls back to IP-only limiting here — `auth.handler`
 * is still the one that rejects the body itself.
 */
async function extractEmail(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.clone().json()
    if (
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof (body as { email?: unknown }).email === "string"
    ) {
      return (body as { email: string }).email
    }
  } catch {
    // Not JSON / no body — leave key undefined (IP-only limiting).
  }
  return undefined
}

/**
 * Returns a 429 Response when the request targets sign-in/sign-up-by-email
 * and has exceeded ADR-0004's limits; otherwise returns null so the caller
 * forwards to `auth.handler` unchanged.
 */
async function enforceNativeAuthRateLimit(
  request: Request,
  pathname: string
): Promise<Response | null> {
  const type = pathname.endsWith(SIGN_UP_EMAIL_SUFFIX)
    ? ("signup" as const)
    : pathname.endsWith(SIGN_IN_EMAIL_SUFFIX)
      ? ("login" as const)
      : null
  if (!type) return null

  const [{ checkRateLimit, RateLimitError }, email] = await Promise.all([
    import("@/server/middleware/rate-limit"),
    extractEmail(request),
  ])

  try {
    await checkRateLimit(request, email, type)
  } catch (error) {
    if (error instanceof RateLimitError) {
      return rateLimitResponse(error.resetAt)
    }
    throw error
  }
  return null
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { auth } = await import("@/server/auth.server")
        return auth.handler(request)
      },
      POST: async ({ request }) => {
        const pathname = new URL(request.url).pathname
        const limited = await enforceNativeAuthRateLimit(request, pathname)
        if (limited) return limited

        const { auth } = await import("@/server/auth.server")
        return auth.handler(request)
      },
    },
  },
})
