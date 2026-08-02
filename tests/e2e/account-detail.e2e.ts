import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-216 — per-account detail route + ATM-card hero.
// Onboard → create an account → open it from the grid card → assert the detail
// hero (name + balance), the empty statement state for a fresh account, that
// "Open in ledger" carries the account filter, and that "Back to accounts"
// returns. The per-account transaction LENS itself (transfer legs) is covered
// by per-account-incoming-transfer.e2e + applyFilters unit tests; this spec
// proves the route, navigation, and wiring.

test.describe("account detail (PER-216)", () => {
  test("open an account card → detail hero + statement + open-in-ledger + back", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E Detail ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Open the account from its grid card ---
    await page.getByRole("button", { name: `Open ${accountName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(
      page.getByRole("link", { name: "Back to accounts" })
    ).toBeVisible()

    // Hero shows the name + formatted balance.
    await expect(page.getByText(accountName).first()).toBeVisible()
    await expect(page.getByText("Rp 2,000,000.00").first()).toBeVisible()

    // The statement section renders. A fresh account's opening balance is an
    // opening VALUATION anchor, not a posted transaction, so the ledger is
    // genuinely empty here.
    await expect(
      page.getByRole("heading", { name: /Transactions \(/ })
    ).toBeVisible()
    await expect(
      page.getByText("No transactions for this account yet.")
    ).toBeVisible()

    // --- Analytics tools (PER-218) render and are interactive ---
    await expect(
      page.getByRole("heading", { name: "Balance trend" })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Spending by category" })
    ).toBeVisible()
    // Range selector toggles the active window.
    const oneMonth = page.getByRole("button", { name: "1M", exact: true })
    await oneMonth.click()
    await expect(oneMonth).toHaveAttribute("aria-pressed", "true")
    // The in-account search box accepts input without crashing the page.
    const search = page.getByRole("textbox", { name: "Search transactions" })
    await search.fill("coffee")
    await expect(search).toHaveValue("coffee")
    await search.clear()

    // --- Open in ledger carries the account filter ---
    await page.getByRole("link", { name: "Open in ledger" }).click()
    await expect(page).toHaveURL(/\/transactions\?.*accounts/)

    // --- Back to accounts ---
    await page.goBack()
    await expect(page).toHaveURL(/\/accounts\/[^/]+$/)
    await page.getByRole("link", { name: "Back to accounts" }).click()
    await expect(page).toHaveURL(/\/accounts$/)
    // "New account" button is unique to the list route (the SiteHeader also
    // renders an <h1> page title, so the heading text is not unique).
    await expect(
      page.getByRole("button", { name: "New account" })
    ).toBeVisible()
  })
})
