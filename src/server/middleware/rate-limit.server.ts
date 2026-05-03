import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

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

function getRedis(): Redis | undefined {
  if (redisInitialized) return redis
  redisInitialized = true
  try {
    if (
      process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN
    ) {
      redis = Redis.fromEnv()
    }
  } catch {
    // Ignore
  }
  return redis
}

// In-memory fallback map for local dev/testing
const fallbackMap = new Map<string, { count: number; resetAt: number }>()

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

export async function checkRateLimit(
  request: Request,
  _key?: string,
  type: "login" | "signup" = "login"
): Promise<void> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0] || "127.0.0.1"
  const identifier = _key ? `${ip}:${_key}` : ip

  const limiter = type === "signup" ? signupLimiter : loginLimiter

  const { success, reset, remaining } = await limiter.limit(identifier)
  if (!success) {
    throw new RateLimitError({ resetAt: new Date(reset), remaining })
  }
}
