import { expect, test } from "./support/fixtures"
import {
  completeOnboarding,
  expectDashboardRoute,
  expectLoginRoute,
  expectOnboardingRoute,
  expectTransactionsErrorBoundaryAbsent,
  expectTransactionsRoute,
  login,
  signUpWithoutFamily,
  waitForHydration,
} from "./support/auth-helpers"
import {
  createServerFunctionMatcher,
  expectNoServerFunctionCalls,
  expectServerFunctionCalled,
  startServerFunctionRecorder,
} from "./support/server-fn-recorder"

const getTransactionsFnMatcher = createServerFunctionMatcher({
  exportName: "getTransactionsFn",
  sourcePath: "src/server/transactions.ts",
})

test.describe("core auth and transaction route smoke flows", () => {
  test("public user can open login and signup", async ({ page }) => {
    await page.goto("/login")
    await waitForHydration(page)
    await Promise.all([
      expect(
        page.getByRole("heading", { name: /Welcome to Permoney/ })
      ).toBeVisible(),
      expect(page.getByRole("button", { name: "Login" })).toBeVisible(),
    ])

    await page.goto("/signup")
    await waitForHydration(page)
    await Promise.all([
      expect(
        page.getByRole("heading", { name: /Join Permoney/ })
      ).toBeVisible(),
      expect(
        page.getByRole("button", { name: "Create Account" })
      ).toBeVisible(),
    ])
  })

  test("logged-out user hitting dashboard is redirected to login", async ({
    page,
  }) => {
    await page.goto("/dashboard")
    await expectLoginRoute(page)
  })

  test("logged-out user hitting transactions is redirected before ledger preload", async ({
    page,
  }) => {
    const ledgerRecorder = startServerFunctionRecorder(
      page,
      getTransactionsFnMatcher
    )

    await page.goto("/transactions")
    await expectLoginRoute(page)
    await expectTransactionsErrorBoundaryAbsent(page)
    await expectNoServerFunctionCalls(ledgerRecorder, getTransactionsFnMatcher)
    ledgerRecorder.stop()
  })

  test("logged-out user hitting onboarding is redirected to login", async ({
    page,
  }) => {
    await page.goto("/onboarding")
    await expectLoginRoute(page)
  })

  test("signed-up user without family is routed to onboarding", async ({
    page,
  }) => {
    await signUpWithoutFamily(page)
  })

  test("signed-up user without family is blocked from protected app routes", async ({
    page,
  }) => {
    await signUpWithoutFamily(page)

    await page.goto("/dashboard")
    await expectOnboardingRoute(page)

    const ledgerRecorder = startServerFunctionRecorder(
      page,
      getTransactionsFnMatcher
    )
    await page.goto("/transactions")
    await expectOnboardingRoute(page)
    await expectTransactionsErrorBoundaryAbsent(page)
    await expectNoServerFunctionCalls(ledgerRecorder, getTransactionsFnMatcher)
    ledgerRecorder.stop()

    await page.goto("/onboarding")
    await expectOnboardingRoute(page)
  })

  test("onboarded user lands on dashboard and can reach protected routes", async ({
    page,
  }) => {
    const identity = await completeOnboarding(page)

    await page.goto("/dashboard")
    await expectDashboardRoute(page)

    await page.goto("/onboarding")
    await expectDashboardRoute(page)

    const ledgerRecorder = startServerFunctionRecorder(
      page,
      getTransactionsFnMatcher
    )

    await page.goto("/transactions")
    await expectTransactionsRoute(page)
    await expectServerFunctionCalled(ledgerRecorder, getTransactionsFnMatcher)
    ledgerRecorder.stop()

    await page.context().clearCookies()
    await login(page, identity)
  })
})
