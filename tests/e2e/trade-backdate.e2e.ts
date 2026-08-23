import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// Real production gap (found 2026-08-24, same report as the Sell sign bug):
// every OTHER money-movement dialog (Switch, Dividend, Fee, and the trade
// CORRECTION dialog itself) already has a Date field — the Buy/Sell trade
// dialog was the one exception, so a trade entered a few days after it
// actually happened (e.g. recorded 2026-08-23 for a sale that happened
// 2026-08-20) had no way to be dated correctly; it was always stamped with
// "now". This drives the real Buy dialog with a backdated date, then opens
// the trade for correction and confirms the SAME date round-trips back —
// proof the value is actually persisted server-side, not silently dropped.

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10)
}

test.describe("Buy/Sell trade backdating", () => {
  test("a trade recorded with a past date persists that date, not today's", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `Fund X ${suffix}`

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const backdatedValue = toDateInputValue(tenDaysAgo)

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Record a Buy dated 10 days ago. ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundName)
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Unit price/i).fill("100000")
    await dialog.getByLabel("Date").fill(backdatedValue)
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundName).first()).toBeVisible()

    // --- Open it for correction and confirm the date round-tripped. ---
    await page.getByRole("button", { name: "Edit Transaction" }).first().click()
    const correctionDialog = page.getByRole("dialog")
    await expect(
      correctionDialog.getByRole("heading", { name: `Edit ${fundName}` })
    ).toBeVisible()
    await expect(correctionDialog.getByLabel("Date")).toHaveValue(
      backdatedValue
    )
  })
})
