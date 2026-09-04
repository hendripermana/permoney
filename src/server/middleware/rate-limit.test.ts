import { afterEach, describe, expect, test, vi } from "vite-plus/test"

// Audit fix: a misconfigured or unreachable Redis backend must fail LOUD in
// production (not silently degrade to a non-distributed, unbounded-growth
// in-memory limiter). These tests exercise the module at IMPORT time,
// because getRedis() runs once, memoized, as a side effect of the
// module-level loginLimiter/signupLimiter construction — so each scenario
// needs vi.resetModules() + a fresh dynamic import under controlled env vars.

const ORIGINAL_ENV = { ...process.env }

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
}

async function freshRateLimitModule() {
  vi.resetModules()
  return await import("./rate-limit")
}

afterEach(() => {
  resetEnv()
  vi.restoreAllMocks()
})

describe("production degradation logging", () => {
  test("logs loudly when Redis env vars are missing in production", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await freshRateLimitModule()

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not set"
      ),
      undefined
    )
  })

  test("stays silent when Redis env vars are missing outside production", async () => {
    process.env.NODE_ENV = "test"
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await freshRateLimitModule()

    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe("fallbackMap sweep", () => {
  test("removes expired entries on the next limit() access", async () => {
    process.env.NODE_ENV = "test"
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    const mod = await freshRateLimitModule()

    mod.fallbackMap.set("rl:login:1.1.1.1", {
      count: 1,
      resetAt: Date.now() - 1_000,
    })
    mod.fallbackMap.set("rl:login:2.2.2.2", {
      count: 1,
      resetAt: Date.now() - 1_000,
    })
    expect(mod.fallbackMap.size).toBe(2)

    await mod.checkRateLimit(
      new Request("http://localhost", {
        headers: { "x-forwarded-for": "3.3.3.3" },
      })
    )

    expect(mod.fallbackMap.has("rl:login:1.1.1.1")).toBe(false)
    expect(mod.fallbackMap.has("rl:login:2.2.2.2")).toBe(false)
    expect(mod.fallbackMap.size).toBe(1)
  })
})
