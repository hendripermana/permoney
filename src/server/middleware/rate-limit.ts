import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import { getTrustedClientIp } from "./request-ip"

export class RateLimitError extends Error {
  public remaining: number
  public resetAt: Date
  constructor({ resetAt, remaining }: { resetAt: Date; remaining: number }) {
    super("Rate limit exceeded")
    this.name = "RateLimitError"
    this.remaining = remaining
    this.resetAt = resetAt
  }
}

// Lazy initialization: defer Redis creation until first use
let redis: Redis | undefined
let redisInitialized = false

// Degraded-to-fallback is silent-by-design in non-production (no Redis
// configured locally is the normal case), but in production it means
// brute-force protection is no longer distributed across instances and
// resets on every restart — that must never happen quietly. Never log the
// env var VALUES here, only the fact/error, so this can't leak secrets.
function logProductionDegradation(reason: string, error?: unknown): void {
  if (process.env.NODE_ENV !== "production") return
  console.error(
    `[rate-limit] ${reason} — falling back to a per-process in-memory ` +
      `rate limiter, which is NOT distributed across instances and resets ` +
      `on every restart. Brute-force protection is degraded. Set ` +
      `UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to restore it.`,
    error instanceof Error ? error.message : error
  )
}

function getRedis(): Redis | undefined {
  if (redisInitialized) return redis
  redisInitialized = true
  try {
    if (
      process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN
    ) {
      redis = Redis.fromEnv()
    } else {
      logProductionDegradation(
        "UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not set"
      )
    }
  } catch (error) {
    logProductionDegradation(
      "Failed to initialize the Upstash Redis client",
      error
    )
  }
  return redis
}

// In-memory fallback map for local dev/testing, or a degraded production
// Redis. Swept on every access (see sweepFallbackMap) so it never grows
// unbounded under sustained traffic. Exported for direct testability
// (rate-limit.test.ts), matching this codebase's convention of exporting
// otherwise-private module state/schemas specifically to unit-test them.
export const fallbackMap = new Map<string, { count: number; resetAt: number }>()

function sweepFallbackMap(now: number): void {
  for (const [key, record] of fallbackMap) {
    if (record.resetAt < now) fallbackMap.delete(key)
  }
}

const getRateLimiter = (
  prefix: string,
  maxRequests: number,
  windowMs: number
) => {
  const redisClient = getRedis()
  if (redisClient) {
    return new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(maxRequests, `${windowMs} ms`),
      prefix,
    })
  }

  // Mock implementation for local dev
  return {
    limit: async (identifier: string) => {
      const now = Date.now()
      sweepFallbackMap(now)
      const key = `${prefix}:${identifier}`
      let record = fallbackMap.get(key)
      if (!record || record.resetAt < now) {
        record = { count: 0, resetAt: now + windowMs }
      }
      record.count++
      fallbackMap.set(key, record)
      return {
        success: record.count <= maxRequests,
        reset: record.resetAt,
        remaining: Math.max(0, maxRequests - record.count),
      }
    },
  }
}

// ADR-0004 limits
// login: 5 req / 15 min
const loginLimiter = getRateLimiter("rl:login", 5, 15 * 60 * 1000)
// signup: 3 req / 1 h
const signupLimiter = getRateLimiter("rl:signup", 3, 60 * 60 * 1000)
// ADR-0057 invite: 10 invites (create + resend) / 1 h, keyed by the INVITING
// USER (not the IP) — the limiter exists to blunt email-bombing an arbitrary
// address from one account, and a rotating IP must not reset it.
const inviteLimiter = getRateLimiter("rl:invite", 10, 60 * 60 * 1000)
// ADR-0057 invite_lookup: 30 lookups / 15 min per client IP. The token lookup
// is unauthenticated (the invitee has no session yet), so IP is the only key.
const inviteLookupLimiter = getRateLimiter(
  "rl:invite_lookup",
  30,
  15 * 60 * 1000
)

export type RateLimitType = "login" | "signup" | "invite" | "invite_lookup"

async function enforce(
  limiter: ReturnType<typeof getRateLimiter>,
  identifier: string
): Promise<void> {
  const { success, reset, remaining } = await limiter.limit(identifier)
  if (!success) {
    throw new RateLimitError({ resetAt: new Date(reset), remaining })
  }
}

/**
 * ADR-0057 — per-inviting-user limit shared by create and resend. Needs no
 * request (the key is the user id), so the domain functions can enforce it
 * directly and integration tests exercise it without an HTTP context.
 */
export async function checkInviteRateLimit(userId: string): Promise<void> {
  await enforce(inviteLimiter, userId)
}

export async function checkRateLimit(
  request: Request,
  _key?: string,
  type: RateLimitType = "login"
): Promise<void> {
  if (type === "invite") {
    if (!_key) {
      throw new Error("The invite rate limit requires the inviting user id")
    }
    return await checkInviteRateLimit(_key)
  }

  const ip = getTrustedClientIp(request.headers) || "127.0.0.1"

  if (type === "invite_lookup") {
    return await enforce(inviteLookupLimiter, ip)
  }

  const identifier = _key ? `${ip}:${_key}` : ip
  const limiter = type === "signup" ? signupLimiter : loginLimiter
  await enforce(limiter, identifier)
}
