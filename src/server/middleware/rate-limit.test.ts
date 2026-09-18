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

// ADR-0057 — the two invite tiers, plus proof the pre-existing tiers keep
// their exact identifier/limit behavior.
describe("invite rate-limit tiers (ADR-0057)", () => {
  const requestFrom = (ip: string) =>
    new Request("http://localhost", { headers: { "cf-connecting-ip": ip } })

  async function freshLocalModule() {
    process.env.NODE_ENV = "test"
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    return await freshRateLimitModule()
  }

  test("invite: 10 per window per inviting user, 11th rejected; other users unaffected", async () => {
    const mod = await freshLocalModule()
    for (let index = 0; index < 10; index += 1) {
      await mod.checkRateLimit(requestFrom("9.9.9.9"), "user-a", "invite")
    }
    await expect(
      mod.checkRateLimit(requestFrom("9.9.9.9"), "user-a", "invite")
    ).rejects.toBeInstanceOf(mod.RateLimitError)
    // Keyed by user, not IP: the same user from a NEW IP is still limited...
    await expect(
      mod.checkRateLimit(requestFrom("8.8.8.8"), "user-a", "invite")
    ).rejects.toBeInstanceOf(mod.RateLimitError)
    // ...and a different user from the original IP is not.
    await mod.checkRateLimit(requestFrom("9.9.9.9"), "user-b", "invite")
  })

  test("invite requires the inviting user id", async () => {
    const mod = await freshLocalModule()
    await expect(
      mod.checkRateLimit(requestFrom("9.9.9.9"), undefined, "invite")
    ).rejects.toThrow(/inviting user id/)
  })

  test("invite_lookup: 30 per window per client IP, 31st rejected", async () => {
    const mod = await freshLocalModule()
    for (let index = 0; index < 30; index += 1) {
      await mod.checkRateLimit(
        requestFrom("7.7.7.7"),
        undefined,
        "invite_lookup"
      )
    }
    await expect(
      mod.checkRateLimit(requestFrom("7.7.7.7"), undefined, "invite_lookup")
    ).rejects.toBeInstanceOf(mod.RateLimitError)
    await mod.checkRateLimit(requestFrom("6.6.6.6"), undefined, "invite_lookup")
  })

  test("login/signup keep their limits and ip:key identifiers", async () => {
    const mod = await freshLocalModule()
    for (let index = 0; index < 5; index += 1) {
      await mod.checkRateLimit(requestFrom("5.5.5.5"), "a@b.c", "login")
    }
    await expect(
      mod.checkRateLimit(requestFrom("5.5.5.5"), "a@b.c", "login")
    ).rejects.toBeInstanceOf(mod.RateLimitError)
    expect(mod.fallbackMap.has("rl:login:5.5.5.5:a@b.c")).toBe(true)

    for (let index = 0; index < 3; index += 1) {
      await mod.checkRateLimit(requestFrom("4.4.4.4"), "x@y.z", "signup")
    }
    await expect(
      mod.checkRateLimit(requestFrom("4.4.4.4"), "x@y.z", "signup")
    ).rejects.toBeInstanceOf(mod.RateLimitError)
  })
})
