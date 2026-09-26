/**
 * Shared arrange scaffolding for the holdings-driven integration suites
 * (`holding-rls-membership-guard`, `trades`, `holding-event-corrections`).
 *
 * WHY THIS EXISTS: the SonarCloud PR-quality gate rejects a PR whose
 * `new_duplicated_lines_density` exceeds 3%. It counted one 31-line block — the
 * "Bibit" investment-account helper (together with the suite lifecycle that
 * every integration `describe` repeats) — as copy-paste shared across those
 * three suites, because they all seed the same brokerage + cash accounts. The
 * account helpers are the genuinely shared surface, so they live here once and
 * every involved suite imports them instead of re-declaring them inline.
 *
 * Account creation is NOT re-implemented: this module delegates to
 * `holdings-fixtures.ts` — the suite-agnostic source of the same fixture shapes
 * — so the two cannot drift. It only pins the defaults these suites agree on
 * and adds the family-scoped balance reader that `holdings-fixtures` does not
 * carry (it needs the harness to open the RLS-scoped transaction).
 */
import type { IntegrationHarness } from "./database"
import type { AuthenticatedOnboardedUser, TestFactories } from "./factories"
import {
  makeCashAccount as makeFixtureCashAccount,
  makeInvestmentAccount as makeFixtureInvestmentAccount,
} from "./holdings-fixtures"

/**
 * A valuation-tracked "Bibit" brokerage account (TRACKED_ASSET → balanceSource
 * "valuation") owned by `owner`.
 */
export const makeInvestmentAccount = (
  factories: TestFactories,
  owner: AuthenticatedOnboardedUser
) => makeFixtureInvestmentAccount(factories, owner, "Bibit")

/**
 * A cash-like "Checking" funding account (DEPOSITORY → balanceSource
 * "transaction_flow"). Opening balance 150,000 major = 15,000,000 sen.
 */
export const makeCashAccount = (
  factories: TestFactories,
  owner: AuthenticatedOnboardedUser
) => makeFixtureCashAccount(factories, owner, "Checking", "150000")

/**
 * Reads `accountId`'s stored balance from inside `owner`'s family scope; the
 * harness opens the RLS-scoped transaction, so callers never touch GUCs.
 */
export const balanceOf = async (
  harness: IntegrationHarness,
  owner: AuthenticatedOnboardedUser,
  accountId: string
): Promise<bigint> =>
  await harness.withFamily(owner.family.id, async (tx) => {
    const row = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { balance: true },
    })
    return row.balance
  })
