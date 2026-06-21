import { createHash, randomUUID } from "node:crypto"
import type { Page, Request } from "@playwright/test"
import { expect, test } from "./support/fixtures"

const SERVER_FUNCTION_BASE_PATH = "/_serverFn/"

interface SignupIdentity {
  email: string
  fullName: string
  password: string
  username: string
}

interface ServerFunctionMatcher {
  displayName: string
  paths: ReadonlySet<string>
}

interface ServerFunctionCall {
  method: string
  url: string
}

function createSignupIdentity(): SignupIdentity {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const generatedPassword = randomUUID().replaceAll("-", "")

  return {
    email: `e2e-${suffix}@permoney.test`,
    fullName: `E2E User ${suffix}`,
    password: `${generatedPassword.slice(0, 12)}A1a`,
    username: `e2e_${suffix}`,
  }
}

function createServerFunctionMatcher(options: {
  exportName: string
  sourcePath: string
}): ServerFunctionMatcher {
  const functionName = `${options.exportName}_createServerFn_handler`
  const devId = Buffer.from(
    JSON.stringify({
      file: `/${options.sourcePath}?tss-serverfn-split`,
      export: functionName,
    }),
    "utf8"
  ).toString("base64url")
  const buildId = createHash("sha256")
    .update(`${options.sourcePath}--${functionName}`)
    .digest("hex")

  return {
    displayName: options.exportName,
    paths: new Set([
      `${SERVER_FUNCTION_BASE_PATH}${devId}`,
      `${SERVER_FUNCTION_BASE_PATH}${buildId}`,
    ]),
  }
}

const getTransactionsFnMatcher = createServerFunctionMatcher({
  exportName: "getTransactionsFn",
  sourcePath: "src/server/transactions.ts",
})

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.permoneyHydrated === "true"
  )
}

function startServerFunctionRecorder(
  page: Page,
  matcher: ServerFunctionMatcher
) {
  const calls: Array<ServerFunctionCall> = []
  const onRequest = (request: Request) => {
    const url = new URL(request.url())
    if (!matcher.paths.has(url.pathname)) return
    calls.push({ method: request.method(), url: request.url() })
  }

  page.on("request", onRequest)

  return {
    calls,
    stop: () => {
      page.off("request", onRequest)
    },
  }
}

async function expectNoServerFunctionCalls(
  recorder: ReturnType<typeof startServerFunctionRecorder>
): Promise<void> {
  await expect
    .poll(() => recorder.calls.length, {
      message: `${getTransactionsFnMatcher.displayName} must not be called`,
      timeout: 500,
    })
    .toBe(0)
}

async function expectServerFunctionCalled(
  recorder: ReturnType<typeof startServerFunctionRecorder>
): Promise<void> {
  await expect
    .poll(() => recorder.calls.length, {
      message: `${getTransactionsFnMatcher.displayName} should be called`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
}

async function expectLoginRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/login(?:\?.*)?$/),
    waitForHydration(page),
  ])
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible()
}

async function expectOnboardingRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/onboarding(?:\?.*)?$/),
    waitForHydration(page),
  ])
  await expect(
    page.getByRole("heading", { name: "Welcome to Permoney" })
  ).toBeVisible()
}

async function expectDashboardRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/),
    waitForHydration(page),
  ])
  // The route renders the title in the SiteHeader chrome AND as the page body
  // heading (PER-156). Scope to the header so the assertion stays unambiguous.
  await expect(
    page.locator("header").getByRole("heading", { name: "Dashboard" })
  ).toBeVisible()
}

async function expectTransactionsRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/transactions(?:\?.*)?$/),
    waitForHydration(page),
  ])
  await expect(
    page.getByRole("heading", { name: "Transactions" })
  ).toBeVisible()
  await expect(page.getByLabel("Search transactions")).toBeVisible()
}

async function expectTransactionsErrorBoundaryAbsent(
  page: Page
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Failed to load transactions" })
  ).toHaveCount(0)
}

async function signUpWithoutFamily(page: Page): Promise<SignupIdentity> {
  const identity = createSignupIdentity()

  await page.goto("/signup")
  await waitForHydration(page)
  await page.getByLabel("Full Name").fill(identity.fullName)
  await page.getByLabel("Username").fill(identity.username)
  await page.getByLabel("Email").fill(identity.email)
  await page.getByLabel("Password").fill(identity.password)
  await page.getByRole("button", { name: "Create Account" }).click()
  await expectOnboardingRoute(page)

  return identity
}

async function completeOnboarding(page: Page): Promise<SignupIdentity> {
  const identity = await signUpWithoutFamily(page)

  await page.getByRole("button", { name: "Get Started" }).click()
  await expectDashboardRoute(page)

  return identity
}

async function login(page: Page, identity: SignupIdentity): Promise<void> {
  await page.goto("/login")
  await waitForHydration(page)
  await page.getByLabel("Email").fill(identity.email)
  await page.getByLabel("Password").fill(identity.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expectDashboardRoute(page)
}

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
    await expectNoServerFunctionCalls(ledgerRecorder)
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
    await expectNoServerFunctionCalls(ledgerRecorder)
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
    await expectServerFunctionCalled(ledgerRecorder)
    ledgerRecorder.stop()

    await page.context().clearCookies()
    await login(page, identity)
  })
})
