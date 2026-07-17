import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { expect } from "./fixtures"

// Shared onboarding helpers for e2e specs: spin up a unique identity, sign up,
// complete onboarding, and land on /dashboard. Kept in one place so route specs
// (budgets, dashboard, …) drive the real signup→onboard→protected path without
// re-copying the flow.

export interface Identity {
  email: string
  fullName: string
  password: string
  username: string
}

export function createIdentity(): Identity {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const password = randomUUID().replaceAll("-", "")
  return {
    email: `e2e-${suffix}@permoney.test`,
    fullName: `E2E User ${suffix}`,
    password: `${password.slice(0, 12)}A1a`,
    username: `e2e_${suffix}`,
  }
}

export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.permoneyHydrated === "true"
  )
}

/** Sign up a fresh user and complete onboarding, ending on /dashboard. */
export async function onboard(page: Page): Promise<Identity> {
  const identity = createIdentity()
  await page.goto("/signup")
  await waitForHydration(page)
  await page.getByLabel("Full Name").fill(identity.fullName)
  await page.getByLabel("Username").fill(identity.username)
  await page.getByLabel("Email").fill(identity.email)
  await page.getByLabel("Password").fill(identity.password)
  await page.getByRole("button", { name: "Create Account" }).click()
  await expect(page).toHaveURL(/\/onboarding(?:\?.*)?$/)
  await waitForHydration(page)
  await page.getByRole("button", { name: "Get Started" }).click()
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
  await waitForHydration(page)
  return identity
}
