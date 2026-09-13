import { randomUUID } from "node:crypto"
import { expect, type Page } from "@playwright/test"

export interface SignupIdentity {
  email: string
  fullName: string
  password: string
  username: string
}

export function createSignupIdentity(): SignupIdentity {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const generatedPassword = randomUUID().replaceAll("-", "")

  return {
    email: `e2e-${suffix}@permoney.test`,
    fullName: `E2E User ${suffix}`,
    password: `${generatedPassword.slice(0, 12)}A1a`,
    username: `e2e_${suffix}`,
  }
}

export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.permoneyHydrated === "true"
  )
}

export async function expectLoginRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/login(?:\?.*)?$/),
    waitForHydration(page),
  ])
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible()
}

export async function expectOnboardingRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/onboarding(?:\?.*)?$/),
    waitForHydration(page),
  ])
  await expect(
    page.getByRole("heading", { name: "Welcome to Permoney" })
  ).toBeVisible()
}

export async function expectDashboardRoute(page: Page): Promise<void> {
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

export async function expectTransactionsRoute(page: Page): Promise<void> {
  await Promise.all([
    expect(page).toHaveURL(/\/transactions(?:\?.*)?$/),
    waitForHydration(page),
  ])
  await expect(
    page.getByRole("heading", { name: "Transactions" })
  ).toBeVisible()
  await expect(page.getByLabel("Search transactions")).toBeVisible()
}

export async function expectTransactionsErrorBoundaryAbsent(
  page: Page
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Failed to load transactions" })
  ).toHaveCount(0)
}

export async function signUpWithoutFamily(page: Page): Promise<SignupIdentity> {
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

export async function completeOnboarding(page: Page): Promise<SignupIdentity> {
  const identity = await signUpWithoutFamily(page)

  await page.getByRole("button", { name: "Get Started" }).click()
  await expectDashboardRoute(page)

  return identity
}

export async function login(
  page: Page,
  identity: SignupIdentity
): Promise<void> {
  await page.goto("/login")
  await waitForHydration(page)
  await page.getByLabel("Email").fill(identity.email)
  await page.getByLabel("Password").fill(identity.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expectDashboardRoute(page)
}
