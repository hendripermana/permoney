/**
 * Shared arrange scaffolding for the holdings-driven integration suites
 * (`holding-rls-membership-guard`, `trades`, `holding-event-corrections`).
 *
 * WHY THIS EXISTS: the SonarCloud PR-quality gate rejects a PR whose
 * `new_duplicated_lines_density` exceeds 3%. It counted one 31-line block — the
 * "Bibit" investment-account helper, together with the suite lifecycle that
 * every integration `describe` repeats — as copy-paste shared across those
 * three suites, because all three arrange the same brokerage + cash accounts.
 * Those helpers are the genuinely shared surface, so they are built here once
 * and each suite binds them instead of re-declaring them inline.
 *
 * The harness and factories are read lazily (callbacks, not values) because
 * every suite creates them inside `beforeAll`, i.e. after the `describe` body
 * that performs the binding has already run.
 *
 * Account creation is NOT re-implemented: it delegates to
 * `holdings-fixtures.ts`, the suite-agnostic source of the same fixture shapes,
 * so the two cannot drift.
 */
import type { SerializedAccount } from "@/server/accounts"
import type { IntegrationHarness } from "./database"
import type { AuthenticatedOnboardedUser, TestFactories } from "./factories"
import {
  makeCashAccount as makeFixtureCashAccount,
  makeInvestmentAccount as makeFixtureInvestmentAccount,
} from "./holdings-fixtures"

/** The arrange helpers the holdings-driven integration suites agree on. */
export interface HoldingSuiteFixtures {
  /** A valuation-tracked "Bibit" brokerage account owned by `owner`. */
  makeInvestmentAccount: (
    owner: AuthenticatedOnboardedUser
  ) => Promise<SerializedAccount>
  /** A cash-like "Checking" funding account (opening 150,000 major). */
  makeCashAccount: (
    owner: AuthenticatedOnboardedUser
  ) => Promise<SerializedAccount>
  /** `accountId`'s stored balance, read inside `owner`'s family scope. */
  balanceOf: (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) => Promise<bigint>
}

/**
 * Builds the suite's arrange helpers. Both suppliers are read lazily so a suite
 * can create its harness and factories in `beforeAll`.
 */
export function createHoldingSuiteFixtures(
  getHarness: () => IntegrationHarness,
  getFactories: () => TestFactories
): HoldingSuiteFixtures {
  return {
    makeInvestmentAccount: (owner) =>
      makeFixtureInvestmentAccount(getFactories(), owner, "Bibit"),
    makeCashAccount: (owner) =>
      makeFixtureCashAccount(getFactories(), owner, "Checking", "150000"),
    balanceOf: async (owner, accountId) =>
      await getHarness().withFamily(owner.family.id, async (tx) => {
        const row = await tx.account.findUniqueOrThrow({
          where: { id: accountId },
          select: { balance: true },
        })
        return row.balance
      }),
  }
}
