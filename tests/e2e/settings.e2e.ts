import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-113 — Settings hub + navigation cohesion. Drives the real browser path:
//   * the sidebar "Settings" link is a TanStack <Link>, so clicking it performs
//     an in-app (no full reload) navigation — proven by a window sentinel that
//     survives the click;
//   * the previously-orphaned Members and Smart Rules panes are reachable from
//     the hub;
//   * theme + family-timezone preferences round-trip through the server fns.

test.describe("settings hub & nav cohesion", () => {
  test("reaches /settings from the sidebar without a full reload", async ({
    page,
  }) => {
    await onboard(page)
    await page.goto("/dashboard")
    await waitForHydration(page)

    // Sentinel on the live window. A full page reload would wipe it; an SPA
    // navigation keeps it. This is the architectural assertion of this ticket.
    await page.evaluate(() => {
      ;(window as unknown as { __permoneySpa?: boolean }).__permoneySpa = true
    })

    await page.getByRole("link", { name: "Settings" }).click()
    await expect(page).toHaveURL(/\/settings$/)

    const survived = await page.evaluate(
      () => (window as unknown as { __permoneySpa?: boolean }).__permoneySpa
    )
    expect(survived).toBe(true)
  })

  test("opens the Members and Smart Rules panes from the hub", async ({
    page,
  }) => {
    await onboard(page)
    await page.goto("/settings")
    await waitForHydration(page)

    await page
      .getByRole("link", { name: /Members/ })
      .first()
      .click()
    await expect(page).toHaveURL(/\/settings\/members$/)
    // "Family members" is both the site-header title and the page's own h1
    // (header first in DOM order), so target the page heading with .last() to
    // avoid a strict-mode double match.
    await expect(
      page.getByRole("heading", { name: "Family members" }).last()
    ).toBeVisible()

    await page.goto("/settings")
    await waitForHydration(page)
    await page
      .getByRole("link", { name: /Smart rules/ })
      .first()
      .click()
    await expect(page).toHaveURL(/\/settings\/rules$/)
  })

  test("changes the theme to dark and persists it", async ({ page }) => {
    await onboard(page)
    await page.goto("/settings/profile")
    await waitForHydration(page)

    await page.getByRole("button", { name: "Dark" }).click()
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByText("Profile updated.")).toBeVisible()
  })

  test("changes the family timezone", async ({ page }) => {
    await onboard(page)
    await page.goto("/settings/family")
    await waitForHydration(page)

    await page.getByRole("combobox", { name: "Timezone" }).click()
    await page.getByRole("option", { name: "UTC" }).click()
    await page.getByRole("button", { name: "Save timezone" }).click()
    await expect(page.getByText("Timezone updated.")).toBeVisible()
  })

  // PER-186 — dogfooding incident: the sidebar showed a hardcoded name/email
  // on every account, so a multi-account user genuinely could not tell which
  // account a tab was signed in as. This proves the sidebar reads the REAL
  // signed-in identity, and that it survives a real logout → login round trip
  // (not just whatever session state happened to exist right after signup).
  test("shows the real signed-in identity in the sidebar after logging back in", async ({
    page,
  }) => {
    const identity = await onboard(page)

    await page
      .getByRole("button", { name: new RegExp(identity.fullName) })
      .click()
    await page.getByRole("menuitem", { name: "Log out" }).click()
    await expect(page).toHaveURL(/\/(?:\?.*)?$/)

    await page.goto("/login")
    await waitForHydration(page)
    await page.getByLabel("Email").fill(identity.email)
    await page.getByLabel("Password").fill(identity.password)
    await page.getByRole("button", { name: "Login" }).click()
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await waitForHydration(page)

    await expect(page.getByText(identity.email)).toBeVisible()
    await expect(page.getByText(new RegExp(identity.fullName))).toBeVisible()
  })
})
