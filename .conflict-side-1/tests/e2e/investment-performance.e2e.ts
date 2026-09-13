import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-229 — Investment & Gold performance (Slice 1).
// Create a TRACKED_ASSET (gold) account with an opening cost, open its detail,
// and prove the Performance panel shows cost basis; then "Update value" to a
// higher market value and prove the unrealized gain + return % appear.

test.describe("investment performance (PER-229)", () => {
  test("tracked-asset account shows cost basis, then gain after an update", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const name = `Gold ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(name)
    // Pick the Tracked Asset type (valuation-tracked) via the labeled select.
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByLabel("Opening balance").fill("20000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${name}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // Performance panel renders; a fresh account's cost == its opening value.
    await expect(page.getByText("Performance")).toBeVisible()
    // \s (not a literal space) so it matches formatCurrency's non-breaking space.
    await expect(page.getByText(/Cost\s+Rp\s+20,000,000\.00/)).toBeVisible()

    // Record a higher market value → unrealized gain of 5,000,000 (+25%).
    await page
      .getByRole("button", { name: "Update value", exact: true })
      .click()
    const dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Update value" })
    ).toBeVisible()
    await dialog.getByLabel(/New value/i).fill("25000000")
    await dialog.getByRole("button", { name: "Update value" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await expect(page.getByText(/\+Rp\s+5,000,000\.00/).first()).toBeVisible()
    await expect(page.getByText(/\+25\.00%/).first()).toBeVisible()
  })
})
