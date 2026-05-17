import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"

interface SignupIdentity {
  email: string
  fullName: string
  password: string
  username: string
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

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.permoneyHydrated === "true"
  )
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
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(
    page.getByRole("heading", { name: "Welcome to Permoney" })
  ).toBeVisible()

  return identity
}

async function completeOnboarding(page: Page): Promise<SignupIdentity> {
  const identity = await signUpWithoutFamily(page)

  await page.getByRole("button", { name: "Get Started" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()

  return identity
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
    await Promise.all([
      expect(page).toHaveURL(/\/login$/),
      waitForHydration(page),
    ])
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible()
  })

  test("logged-out user hitting transactions is redirected before ledger preload", async ({
    page,
  }) => {
    await page.goto("/transactions")
    await Promise.all([
      expect(page).toHaveURL(/\/login$/),
      waitForHydration(page),
    ])
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible()
  })

  test("signed-up user without family is routed to onboarding", async ({
    page,
  }) => {
    await signUpWithoutFamily(page)
  })

  test("onboarded user can reach dashboard", async ({ page }) => {
    await completeOnboarding(page)
  })

  test("onboarded user can reach transactions without blocked console errors", async ({
    page,
  }) => {
    await completeOnboarding(page)

    await page.goto("/transactions")
    await Promise.all([
      expect(page).toHaveURL(/\/transactions(?:\?.*)?$/),
      expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible(),
      expect(page.getByLabel("Search transactions")).toBeVisible(),
    ])
  })
})
