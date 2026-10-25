import { describe, expect, test } from "vite-plus/test"
import { z } from "zod"
import { isAuthError } from "@/lib/auth-errors"
import { createAccountFn } from "@/server/accounts"
import type { TestFactories } from "./support/factories"
import { callServerFnAs } from "./support/server-fn-request"
import { useIntegrationSuite } from "./support/suite"

// The capability gate is covered by middleware-authorization.integration.ts.
// This suite pins the other half of the RPC contract: a caller that PASSES the
// gate is still refused by the server fn's `.validator(...)` before the handler,
// and that refusal reaches the test as a Zod rejection rather than as the
// helper's "server function did not run" sentinel or an auth error.
//
// `createAccountFn` is the subject because its schema is strict and rejects the
// payload without touching Postgres — `currency: 42` fails `z.string()` at the
// schema boundary, so a failure here means the validator contract changed, not
// that some downstream service happened to fail.

describe("server function input validation (createServerFn .validator)", () => {
  let factories: TestFactories

  useIntegrationSuite((_harness, boundFactories) => {
    factories = boundFactories
  })

  test("createAccountFn surfaces a Zod rejection for a non-string currency", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    const outcome = await callServerFnAs(owner, createAccountFn, {
      name: "Invalid currency account",
      accountType: "DEPOSITORY",
      // Untrusted wire payload: the schema, not the caller, decides validity.
      currency: 42,
      idempotencyKey: factories.createIdempotencyKey(),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      throw new Error("the validator must reject a non-string currency")
    }

    // A Zod rejection proves the request reached the server fn's validator: the
    // sentinel would mean the entry never reported an outcome, and an auth error
    // would mean the capability gate — not the schema — refused the call.
    expect(outcome.error).toBeInstanceOf(z.ZodError)
    expect(isAuthError(outcome.error)).toBe(false)
    if (!(outcome.error instanceof z.ZodError)) {
      throw new Error(`expected ZodError, got ${String(outcome.error)}`)
    }
    expect(outcome.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["currency"] })])
    )
  })
})
