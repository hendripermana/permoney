import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-166 — public surface & auth UX cohesion. Drives the real front door in a
// browser: a guest landing at "/" sees a branded landing with working Log in /
// Sign up CTAs (no manual URL typing), navigation between landing ↔ login ↔
// signup is SPA (no full document reload), and an authed visitor to "/" is
// redirected straight to /dashboard.

const RELOAD_SENTINEL = "__per166NoReload"

/** Plant a sentinel on window; survives SPA nav, wiped by a full page reload. */
async function plantReloadSentinel(page: Page): Promise<void> {
  await page.evaluate((key) => {
    Object.assign(window, { [key]: true })
  }, RELOAD_SENTINEL)
}

async function expectNoFullReload(page: Page): Promise<void> {
  const survived = await page.evaluate(
    (key) => Reflect.has(window, key),
    RELOAD_SENTINEL
  )
  expect(survived, "navigation should be client-side (no full reload)").toBe(
    true
  )
}

test.describe("public surface & auth UX cohesion", () => {
  test("guest landing at / shows a branded landing, not the Vite stub", async ({
    page,
  }) => {
    await page.goto("/")
    await waitForHydration(page)

    await expect(
      page.getByRole("heading", { name: /finally makes sense/i })
    ).toBeVisible()
    // The old Vite starter stub is gone.
    await expect(page.getByText("Project ready!")).toHaveCount(0)
    // On-page entry points exist (no URL typing required).
    await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible()
  })

  test("guest reaches signup from the landing via a CTA, SPA (no reload)", async ({
    page,
  }) => {
    await page.goto("/")
    await waitForHydration(page)
    await plantReloadSentinel(page)

    await page.getByRole("link", { name: "Sign up" }).click()

    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/)
    await expect(
      page.getByRole("heading", { name: /Join Permoney/ })
    ).toBeVisible()
    await expectNoFullReload(page)
  })

  test("guest reaches login from the landing via a CTA, SPA (no reload)", async ({
    page,
  }) => {
    await page.goto("/")
    await waitForHydration(page)
    await plantReloadSentinel(page)

    await page.getByRole("link", { name: "Log in" }).click()

    await expect(page).toHaveURL(/\/login(?:\?.*)?$/)
    await expect(
      page.getByRole("heading", { name: /Welcome to Permoney/ })
    ).toBeVisible()
    await expectNoFullReload(page)
  })

  test("login ↔ signup cross-links are SPA (no reload)", async ({ page }) => {
    await page.goto("/login")
    await waitForHydration(page)
    await plantReloadSentinel(page)

    await page.getByRole("link", { name: "Sign up here" }).click()
    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/)
    await expect(
      page.getByRole("heading", { name: /Join Permoney/ })
    ).toBeVisible()
    await expectNoFullReload(page)

    await page.getByRole("link", { name: "Login here" }).click()
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/)
    await expect(
      page.getByRole("heading", { name: /Welcome to Permoney/ })
    ).toBeVisible()
    await expectNoFullReload(page)
  })

  test("authed visitor to / is redirected to /dashboard", async ({ page }) => {
    await onboard(page)

    await page.goto("/")

    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await waitForHydration(page)
    await expect(
      page.locator("header").getByRole("heading", { name: "Dashboard" })
    ).toBeVisible()
  })

  test("logout from the app lands on the public landing", async ({ page }) => {
    await onboard(page)
    await page.goto("/dashboard")
    await waitForHydration(page)

    // Open the sidebar user menu, then choose Log out. Goes through the logoutFn
    // server function (relative path) — proves it no longer silently fails the
    // way the old :3006-pinned auth-client signOut did off the dev port.
    await page.getByRole("button", { name: /Hendri Permana/ }).click()
    await page.getByRole("menuitem", { name: "Log out" }).click()

    await expect(page).toHaveURL(/\/(?:\?.*)?$/)
    await waitForHydration(page)
    await expect(
      page.getByRole("heading", { name: /finally makes sense/i })
    ).toBeVisible()
  })
})
