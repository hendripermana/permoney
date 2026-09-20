import { afterEach, describe, expect, test, vi } from "vite-plus/test"
import {
  buildLogLine,
  getServerLogContext,
  logAndRethrow,
  logEvent,
  REDACTED_EMAIL,
  REDACTED_NUMBER,
  REDACTED_OPAQUE,
  scrubLogText,
  updateServerLogContext,
  withServerLogContext,
} from "./log.server"

/**
 * F1 audit S5.1 — the log contract.
 *
 * The value of a structured logger on a money app is entirely in what it
 * REFUSES to write: an amount, an email or a session token in a log line is a
 * data leak that survives forever in `docker logs`. These tests pin the
 * refusals, the closed field set, and the fact that a thrown error is logged
 * once and rethrown unchanged.
 */

const CONTEXT = { requestId: "req-1", userId: "user-1", familyId: "fam-1" }

afterEach(() => {
  vi.restoreAllMocks()
})

describe("scrubLogText — what must never reach the log", () => {
  test("redacts email addresses", () => {
    expect(scrubLogText("invite for bibi@example.com failed")).toBe(
      `invite for ${REDACTED_EMAIL} failed`
    )
  })

  test("redacts long digit runs (amounts, epoch stamps)", () => {
    expect(scrubLogText("amount 5000000 rejected")).toBe(
      `amount ${REDACTED_NUMBER} rejected`
    )
    expect(scrubLogText("value 1234567890123 out of range")).toBe(
      `value ${REDACTED_NUMBER} out of range`
    )
  })

  test("keeps short numbers (they are not amounts)", () => {
    expect(scrubLogText("retry 3 of 5")).toBe("retry 3 of 5")
  })

  test("redacts opaque tokens", () => {
    const token = "a".repeat(40)
    expect(scrubLogText(`token ${token} rejected`)).toBe(
      `token ${REDACTED_OPAQUE} rejected`
    )
  })

  test("redacts a bearer-style mixed token", () => {
    expect(
      scrubLogText("Authorization Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0")
    ).toBe(`Authorization Bearer ${REDACTED_OPAQUE}`)
  })

  test("redacts an email before the opaque-token rule can split it", () => {
    const longEmail = `${"x".repeat(30)}@example.com`
    expect(scrubLogText(longEmail)).toBe(REDACTED_EMAIL)
  })

  test("truncates unbounded text", () => {
    // Words, not one long unbroken run: the opaque-token rule would (correctly)
    // collapse a 1000-char single token before truncation ever applies.
    const scrubbed = scrubLogText("word ".repeat(200).trimEnd())
    expect(scrubbed).toHaveLength(400)
  })
})

describe("buildLogLine — the closed shape", () => {
  test("carries the correlation fields", () => {
    const line = buildLogLine(
      { level: "error", event: "server_fn_error" },
      CONTEXT,
      new Date("2026-09-20T12:00:00.000Z")
    )
    expect(line).toEqual({
      timestamp: "2026-09-20T12:00:00.000Z",
      level: "error",
      event: "server_fn_error",
      requestId: "req-1",
      userId: "user-1",
      familyId: "fam-1",
    })
  })

  test("omits absent optional fields instead of writing null", () => {
    const line = buildLogLine({ level: "info", event: "x" }, CONTEXT)
    expect(Object.keys(line)).not.toContain("message")
    expect(Object.keys(line)).not.toContain("errorName")
    expect(Object.keys(line)).not.toContain("durationMs")
  })

  test("scrubs a message that embeds payload data", () => {
    const line = buildLogLine(
      {
        level: "error",
        event: "server_fn_error",
        errorName: "PrismaClientKnownRequestError",
        message: "failed for bibi@example.com with amount 5000000",
      },
      CONTEXT
    )
    expect(line.message).toBe(
      `failed for ${REDACTED_EMAIL} with amount ${REDACTED_NUMBER}`
    )
  })

  test("tolerates a missing log context", () => {
    const line = buildLogLine({ level: "info", event: "x" }, undefined)
    expect(line.requestId).toBe("")
  })
})

describe("logEvent — routing", () => {
  test("writes errors and warnings to stderr", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    logEvent({ level: "error", event: "server_fn_error" })
    logEvent({ level: "warn", event: "slow_query" })

    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).not.toHaveBeenCalled()
  })

  test("writes info to stdout", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    logEvent({ level: "info", event: "started" })

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test("writes one line of valid JSON", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    logEvent({ level: "info", event: "started" })

    const serialized = logSpy.mock.calls[0]?.[0]
    expect(typeof serialized).toBe("string")
    expect((serialized as string).includes("\n")).toBe(false)
    expect(JSON.parse(serialized as string)).toMatchObject({
      level: "info",
      event: "started",
    })
  })
})

describe("request-scoped context", () => {
  test("mints a requestId per scope and shares it with nested calls", async () => {
    const seen: Array<string> = []
    await withServerLogContext(async () => {
      seen.push(getServerLogContext()?.requestId ?? "")
      await Promise.resolve()
      seen.push(getServerLogContext()?.requestId ?? "")
    })
    expect(seen[0]).not.toBe("")
    expect(seen[0]).toBe(seen[1])
  })

  test("two scopes get different request ids", async () => {
    const first = await withServerLogContext(
      async () => getServerLogContext()?.requestId ?? ""
    )
    const second = await withServerLogContext(
      async () => getServerLogContext()?.requestId ?? ""
    )
    expect(first).not.toBe(second)
  })

  test("updateServerLogContext adds fields the chain learns later", async () => {
    await withServerLogContext(async () => {
      updateServerLogContext({ userId: "u1" })
      updateServerLogContext({ familyId: "f1" })
      const context = getServerLogContext()
      expect(context?.userId).toBe("u1")
      expect(context?.familyId).toBe("f1")
      expect(context?.requestId).toBeTruthy()
    })
  })

  test("updateServerLogContext is a no-op outside a scope", () => {
    expect(() => updateServerLogContext({ userId: "u1" })).not.toThrow()
    expect(getServerLogContext()).toBeUndefined()
  })
})

describe("logAndRethrow", () => {
  test("logs exactly one line and rethrows the SAME error instance", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = new Error("conflict on Transaction")

    let caught: unknown = null
    try {
      logAndRethrow(original, { durationMs: 12, fn: "createTransactionFn" })
    } catch (thrown) {
      caught = thrown
    }

    expect(caught).toBe(original)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = JSON.parse(errorSpy.mock.calls[0]?.[0] as string)
    expect(line).toMatchObject({
      level: "error",
      event: "server_fn_error",
      errorName: "Error",
      message: "conflict on Transaction",
      durationMs: 12,
      fn: "createTransactionFn",
    })
  })

  test("logs only name + message — never the error's other properties", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    class PayloadCarryingError extends Error {
      readonly accountName = "Bibit Reksadana"
      readonly referenceId = "acct_123"
    }
    const original = new PayloadCarryingError("not found")

    try {
      logAndRethrow(original)
    } catch {
      // expected
    }

    const serialized = errorSpy.mock.calls[0]?.[0] as string
    expect(serialized).not.toContain("Bibit Reksadana")
    expect(serialized).not.toContain("acct_123")
    expect(serialized).toContain("not found")
  })

  test("handles a non-Error throw", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      logAndRethrow("string failure")
    } catch {
      // expected
    }
    const line = JSON.parse(errorSpy.mock.calls[0]?.[0] as string)
    expect(line.errorName).toBe("string")
    expect(line.message).toBe("string failure")
  })
})
