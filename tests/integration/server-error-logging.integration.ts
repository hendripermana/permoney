import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test"
import {
  logAndRethrow,
  scrubLogText,
  updateServerLogContext,
  withServerLogContext,
} from "../../src/server/log.server"
import { createTransactionForFamily } from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

/**
 * F1 audit S5.1 — error capture against real Postgres.
 *
 * Why this file exists: TanStack's `ShallowErrorPlugin` keeps only `.message`
 * when an error crosses the server-fn boundary, so `.name`, Prisma's
 * `.code`/`.meta` and our own error fields are gone before the client sees
 * them. If the server does not write the error while it still exists, a
 * production failure leaves no evidence at all.
 *
 * What is covered here: the exact code the middleware runs on a failure
 * (`withServerLogContext` + `logAndRethrow`) driving a REAL database failure,
 * asserting one line, the operator's join keys, a scrubbed message, and the
 * absence of every payload value the caller had in hand.
 *
 * What is NOT covered here, deliberately: the TanStack middleware plumbing
 * itself (`authMiddleware` → `errorLogMiddleware` → `next()`). Executing it
 * requires TanStack Start's own request context, which only exists inside the
 * server runtime — a test cannot establish it without importing framework
 * internals the project does not depend on. The gap is stated in the slice
 * report rather than papered over with a synthetic harness.
 */

let harness: IntegrationHarness
let factories: TestFactories

beforeAll(async () => {
  harness = await createIntegrationHarness()
  factories = createTestFactories(harness)
})

beforeEach(async () => {
  await harness.reset()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await harness.teardown()
})

interface CapturedLog {
  level: string
  event: string
  requestId: string
  userId?: string
  familyId?: string
  fn?: string
  errorName?: string
  message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toCapturedLog(value: unknown): CapturedLog | null {
  if (!isRecord(value) || typeof value.level !== "string") {
    return null
  }
  if (typeof value.event !== "string" || typeof value.requestId !== "string") {
    return null
  }
  const log: CapturedLog = {
    level: value.level,
    event: value.event,
    requestId: value.requestId,
  }
  if (typeof value.userId === "string") log.userId = value.userId
  if (typeof value.familyId === "string") log.familyId = value.familyId
  if (typeof value.fn === "string") log.fn = value.fn
  if (typeof value.errorName === "string") log.errorName = value.errorName
  if (typeof value.message === "string") log.message = value.message
  return log
}

/** Capture structured lines written to stderr, keeping the raw text too. */
function captureStderr(): { logs: CapturedLog[]; raw: string[] } {
  const logs: CapturedLog[] = []
  const raw: string[] = []
  vi.spyOn(console, "error").mockImplementation((...args: Array<unknown>) => {
    const first: unknown = args[0]
    if (typeof first !== "string") {
      return
    }
    raw.push(first)
    const parsed = toCapturedLog(JSON.parse(first))
    if (parsed) {
      logs.push(parsed)
    }
  })
  return { logs, raw }
}

describe("server error logging — real failures", () => {
  test("one line, with ids and a scrubbed message, and no payload", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { logs, raw } = captureStderr()

    let thrown: unknown = null
    await withServerLogContext(async () => {
      updateServerLogContext({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      try {
        // A real failure from the real mutation path: the account does not
        // exist in this family, so the tenant-reference check rejects it.
        await createTransactionForFamily({
          data: {
            accountId: "acct_01J8ZQ9K7VQ8W9X2Y3Z4A5B6C7",
            amount: "5000000",
            date: new Date("2026-09-20T00:00:00.000Z"),
            description: "Distinctive Payload Description",
            idempotencyKey: factories.createIdempotencyKey(),
            status: "CLEARED",
            type: "expense",
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      } catch (error) {
        thrown = error
        logAndRethrow(error, { fn: "createTransactionFn" })
      }
    }).catch(() => undefined)

    expect(thrown).toBeInstanceOf(Error)

    const errorLogs = logs.filter((log) => log.level === "error")
    expect(errorLogs).toHaveLength(1)

    const log = errorLogs[0]
    expect(log.event).toBe("server_fn_error")
    expect(log.fn).toBe("createTransactionFn")
    expect(log.requestId.length).toBeGreaterThan(0)
    expect(log.userId).toBe(owner.user.id)
    expect(log.familyId).toBe(owner.family.id)
    expect(log.errorName).toBeTruthy()
    expect(log.errorName).not.toBe("undefined")

    // The message is the real one, scrubbed — not a placeholder.
    if (thrown instanceof Error) {
      expect(log.message).toBe(scrubLogText(thrown.message))
      expect(log.message?.length ?? 0).toBeGreaterThan(0)
    }

    // Nothing the caller passed may appear anywhere on stderr. Ids are the
    // deliberate exception — `userId`/`familyId` above ARE ids, and the error
    // message legitimately names the rejected reference. Payload is the thing
    // that must never appear.
    const everythingWritten = raw.join("\n")
    expect(everythingWritten).not.toContain("Distinctive Payload Description")
    expect(everythingWritten).not.toContain("5000000")
    expect(everythingWritten).not.toContain(owner.user.email)
  })

  test("a failure outside any log context still propagates unchanged", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { logs } = captureStderr()

    let thrown: unknown = null
    let rethrown: unknown = null
    try {
      await createTransactionForFamily({
        data: {
          accountId: "acct_01J8ZQ9K7VQ8W9X2Y3Z4A5B6C7",
          amount: "1000",
          date: new Date("2026-09-20T00:00:00.000Z"),
          description: "no context",
          idempotencyKey: factories.createIdempotencyKey(),
          status: "CLEARED",
          type: "expense",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    } catch (error) {
      thrown = error
      try {
        // `logAndRethrow` must not explode when there is no context (there is
        // nothing to correlate, but the error still has to reach the caller),
        // and it must rethrow the SAME instance.
        logAndRethrow(error)
      } catch (error2) {
        rethrown = error2
      }
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(rethrown).toBe(thrown)
    // Exactly one of OUR lines. `raw` may hold more: Prisma also writes its own
    // `prisma:error` banner to stderr, which is why the "one line" assertions
    // count parsed structured logs, not raw stderr text.
    expect(logs.filter((log) => log.level === "error")).toHaveLength(1)
    expect(logs[0]?.event).toBe("server_fn_error")
    expect(logs[0]?.requestId).toBe("")
  })
})
