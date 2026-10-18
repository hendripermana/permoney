import { afterAll, beforeAll, beforeEach } from "vite-plus/test"
import { createIntegrationHarness, type IntegrationHarness } from "./database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./factories"

/**
 * Registers the standard integration-suite lifecycle — a fresh harness in
 * `beforeAll`, a database reset before every test, teardown after all — and
 * binds the live `harness`/`factories` into the caller's scope. Call it once
 * inside a `describe` body, next to the caller's own
 * `let harness: IntegrationHarness` / `let factories: TestFactories`
 * declarations; every `harness.*` / `factories.*` reference in the suite then
 * stays exactly as it was:
 *
 * ```ts
 * let harness: IntegrationHarness
 * let factories: TestFactories
 * useIntegrationSuite((h, f) => {
 *   harness = h
 *   factories = f
 * })
 * ```
 *
 * `beforeAll`/`beforeEach`/`afterAll` register on the suite whose `describe`
 * body invokes this function (Vitest collects hooks synchronously during
 * collection), so each suite keeps its own harness instance.
 */
export function useIntegrationSuite(
  bind: (harness: IntegrationHarness, factories: TestFactories) => void
): void {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
    bind(harness, factories)
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })
}

/**
 * The `setFamilyDefaults(owner, currency, timezone)` suite helper, shared
 * verbatim by the insights and net-worth-series suites. It is bound to a
 * suite's harness through a getter because the harness only exists after
 * `beforeAll` has run.
 */
export const createFamilyDefaultsSetter =
  (harness: () => IntegrationHarness) =>
  (owner: AuthenticatedOnboardedUser, currency: string, timezone: string) =>
    harness().withFamily(owner.family.id, async (tx) =>
      tx.family.update({
        where: { id: owner.family.id },
        data: { currency, timezone },
      })
    )
