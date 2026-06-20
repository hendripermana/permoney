import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"

// PER-148 — the route was shipped without ever being opened in a browser. This
// drives the real path (browser -> server-fn -> react-query -> render) that the
// integration tests bypass, and asserts the page actually renders content
// instead of being stuck on "Loading budget…".

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

test.describe("budgets route", () => {
  test("onboarded user can open /budgets and see content, not a stuck loader", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/budgets")
    await waitForHydration(page)

    // Unique page-body content (the "Budgets" h1 also appears in the site
    // header, so assert on the intro copy + section titles instead).
    await expect(
      page.getByText("Set what you plan to spend per category", {
        exact: false,
      })
    ).toBeVisible()
    // Proof the data resolved and the body rendered, not a stuck/errored loader.
    await expect(page.getByText("Set allocations")).toBeVisible()
    await expect(page.getByText("By category")).toBeVisible()
    await expect(page.getByText("Loading budget…")).toHaveCount(0)
    await expect(page.getByText("Couldn't load this budget")).toHaveCount(0)
  })
})
