import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { AppError, isAuthError } from "@/lib/auth-errors"
import { createAccountFn } from "@/server/accounts"
import {
  upsertFxRateSnapshotFn,
  upsertFxRateSnapshotForFamily,
} from "@/server/fx"
import type { FamilyRole } from "@/server/middleware/authz"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import { callServerFnAs } from "./support/server-fn-request"

// ADR-0036 §3 — the capability gate must reject at the MIDDLEWARE, not merely
// inside the service layer. `roleCan` has a pure matrix assertion and the
// membership service fns have their own suite, but both can pass while the
// HTTP-facing endpoint is left unguarded. These tests therefore drive REAL
// `createServerFn` exports through their server path, so `familyMiddleware` and
// `requireCapability` run exactly as they do for a browser RPC call.
//
// The middleware chain is real (session → active membership → capability). The
// handler body is not executed in vitest — the framework only wires it into the
// server path via its build-time splitter — so these assertions are about the
// GATE, and write-side effects stay covered by the service-layer suites. See
// support/server-fn-request.ts.

describe("middleware authorization gate (ADR-0036 §3)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  const rateInput = (fromCurrency: string) => ({
    fromCurrency,
    toCurrency: "IDR",
    rate: "16000",
    asOfDate: new Date("2026-01-01"),
    source: "manual" as const,
  })

  const addMember = async (
    familyId: string,
    role: FamilyRole
  ): Promise<{ request: Request; user: { id: string } }> => {
    const user = await factories.createUser({ familyId })
    await factories.createFamilyMember({ familyId, userId: user.id, role })
    const authenticated = await factories.authenticateUser(user)
    return { request: authenticated.request, user }
  }

  const expectForbidden = (error: unknown): void => {
    expect(isAuthError(error)).toBe(true)
    if (!(error instanceof AppError)) {
      throw new Error(`expected AppError, got ${String(error)}`)
    }
    expect(error.code).toBe("FORBIDDEN")
  }

  test("a member is rejected on a settings:write endpoint (settings are owner/admin only)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const member = await addMember(owner.family.id, "member")

    const outcome = await callServerFnAs(
      member,
      upsertFxRateSnapshotFn,
      rateInput("USD")
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("the gate must not let a member through")
    expectForbidden(outcome.error)

    // Control: the SAME member and payload through the service layer the server
    // fn wraps succeed — the service does not check capabilities. The rejection
    // above therefore comes from the middleware gate, not business validation.
    await upsertFxRateSnapshotForFamily({
      data: rateInput("USD"),
      familyId: owner.family.id,
      user: member.user,
    })
    const rows = await harness.withFamily(
      owner.family.id,
      async (tx) => await tx.fxRateSnapshot.count()
    )
    expect(rows).toBe(1)
  })

  test("an admin holding settings:write passes the same gate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const admin = await addMember(owner.family.id, "admin")

    const outcome = await callServerFnAs(
      admin,
      upsertFxRateSnapshotFn,
      rateInput("USD")
    )

    // Pass-through, not rejection: no auth error is raised for a role that holds
    // the capability. (The write itself is asserted by the service-layer suite.)
    expect(outcome.ok).toBe(true)
  })

  test("a member still passes a ledger:write endpoint (the gate is not a blanket deny)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const member = await addMember(owner.family.id, "member")

    const outcome = await callServerFnAs(member, createAccountFn, {
      name: "Member account",
      accountType: "DEPOSITORY",
      currency: "IDR",
      openingBalance: "0",
      idempotencyKey: factories.createIdempotencyKey(),
    })

    expect(outcome.ok).toBe(true)
  })

  test("a viewer is rejected on a ledger:write endpoint", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const viewer = await addMember(owner.family.id, "viewer")

    const outcome = await callServerFnAs(viewer, createAccountFn, {
      name: "Viewer account",
      accountType: "DEPOSITORY",
      currency: "IDR",
      openingBalance: "0",
      idempotencyKey: factories.createIdempotencyKey(),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("the gate must not let a viewer write")
    expectForbidden(outcome.error)
  })
})
