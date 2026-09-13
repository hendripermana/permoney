import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-183 — a fresh family must start genuinely empty: no auto-seeded
// "Everyday Cash" starter account, no "Welcome coffee" sample transaction.
// Drives the real signup → onboard → dashboard/accounts path and asserts the
// empty state is a real, actionable surface (DESIGN.md) rather than a blank
// or crashed page, with both required CTAs (add an account, or import from
// Sure) visible without digging.

test.describe("onboarding lands on a genuinely empty workspace", () => {
  test("dashboard shows the empty state, not stale seeded figures", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/dashboard")
    await waitForHydration(page)

    await expect(page.getByText("Nothing tracked yet")).toBeVisible()
    await expect(
      page.getByRole("link", { name: /Add your first account/ })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: /Moving from Sure\? Import your data/ })
    ).toBeVisible()

    // No stray report content, and definitely no trace of the old seeded
    // account/transaction (Rp 87,500 was the original dogfooding bug report).
    await expect(page.getByText("Everyday Cash")).toHaveCount(0)
    await expect(page.getByText("Welcome coffee")).toHaveCount(0)
    await expect(page.getByText("Net worth in base currency")).toHaveCount(0)
  })

  test("accounts page shows the empty state with both CTAs", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/accounts")
    await waitForHydration(page)

    await expect(page.getByText("No accounts yet")).toBeVisible()
    await expect(
      page.getByRole("button", { name: /Add your first account/ })
    ).toBeVisible()

    await page
      .getByRole("link", { name: /Moving from Sure\? Import your data/ })
      .click()
    await expect(page).toHaveURL(/\/import\/sure$/)
  })

  test("dashboard's add-account CTA reaches the accounts page", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/dashboard")
    await waitForHydration(page)

    await page.getByRole("link", { name: /Add your first account/ }).click()
    await expect(page).toHaveURL(/\/accounts(?:\?.*)?$/)
    await waitForHydration(page)
    await expect(page.getByText("No accounts yet")).toBeVisible()
  })
})
