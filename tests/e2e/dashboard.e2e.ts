import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"

// PER-156 — R3 dashboard realization. Drives the real path
// (browser -> server-fn -> react-query -> render) for the three reporting
// engines (R1 net worth, R2 cash flow + top categories, P1 budget progress)
// against the data a freshly onboarded family already has: a starter account
// with a non-zero opening balance (so R1 renders a real net-worth headline).
// Asserts the page renders headline content instead of being stuck on a
// skeleton or error.

interface Identity {
  email: string
  fullName: string
  password: string
  username: string
}

function createIdentity(): Identity {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const password = randomUUID().replaceAll("-", "")
  return {
    email: `e2e-${suffix}@permoney.test`,
    fullName: `E2E User ${suffix}`,
    password: `${password.slice(0, 12)}A1a`,
    username: `e2e_${suffix}`,
  }
}

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.permoneyHydrated === "true"
  )
}

async function onboard(page: Page): Promise<void> {
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
}

test.describe("dashboard route", () => {
  test("onboarded user sees net worth, cash flow, top categories, and budget", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/dashboard")
    await waitForHydration(page)

    // Each section title only renders once its server-fn data has resolved.
    await expect(
      page.getByText("Net worth in base currency", { exact: false })
    ).toBeVisible()
    await expect(page.getByText("Cash flow", { exact: true })).toBeVisible()
    await expect(page.getByText("Net cash flow")).toBeVisible()
    await expect(page.getByText("Top spending categories")).toBeVisible()
    await expect(page.getByText("Budget progress")).toBeVisible()

    // R1 produced a real net-worth headline from the seeded starter account —
    // a formatted figure (contains a digit), never the "—" empty placeholder.
    const netWorthValue = page.getByTestId("dashboard-net-worth-value")
    await expect(netWorthValue).toBeVisible()
    await expect(netWorthValue).toHaveText(/\d/)

    // Not stuck loading / not errored.
    await expect(page.getByText(/Couldn't load/)).toHaveCount(0)
  })
})
