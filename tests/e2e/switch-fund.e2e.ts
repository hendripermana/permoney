import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 Slice 4 / ADR-0054 — Switch UI (broker-agnostic; atomic sell-A +
// buy-B, ONE account, NO external cash). Onboard → create a Tracked Asset
// (valuation-tracked) account → add a holding (fund A) → open the Switch
// dialog and switch ALL of A into a brand-new fund B. A's row disappears
// (its position closed), B's row appears with the proceeds' worth of units,
// and — since A's switch price equals its average cost here — the account's
// total value is unchanged (no realized gain, no external cash).
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("switch fund UI (PER-259 Slice 4)", () => {
  test("switching ALL of A into a new fund B closes A and grows B; account value stays sane", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const portfolioName = `Portfolio ${suffix}`
    const fundAName = `Fund A ${suffix}`
    const fundBName = `Fund B ${suffix}`

    // --- Tracked Asset account ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Seed fund A: 2 units @ 1,000,000 (value = cost = 2,000,000). ---
    await page.getByRole("button", { name: "Add holding" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill(fundAName)
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Mutual fund" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(/Rp\s2,000,000\.00/).first()).toBeVisible()

    // --- Switch ALL of A into a brand-new fund B. ---
    await page.getByRole("button", { name: "Switch" }).first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Switch fund" })
    ).toBeVisible()

    // Only one holding exists, so the destination already defaults to "New
    // fund..." — fill the inline instrument fields directly.
    await dialog.getByLabel("Fund name").fill(fundBName)

    // Switch by quantity (the default basis) — all 2 units of A.
    await dialog.getByLabel("Quantity").fill("2")

    // Use A's current price (its average cost, 1,000,000/unit) so this switch
    // realizes NO gain — proceeds equal A's removed cost basis exactly.
    await dialog.getByRole("button", { name: /Use current/ }).click()

    // B's price: 500,000/unit -> proceeds 2,000,000 buys exactly 4 units.
    await dialog.getByLabel(/^B's price/).fill("500000")

    await dialog.getByRole("button", { name: "Record switch" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // A's position closed — its row is gone from the HOLDINGS list. (Scoped:
    // the Position activity list below records the switch as "A → B", so an
    // unscoped text match would still find A's name there — PER-259 Slice 5.)
    const holdingsList = page.getByRole("list", { name: "Holdings" })
    await expect(holdingsList.getByText(fundAName)).toHaveCount(0)

    // B's row appeared with the switched-in units (proceeds 2,000,000 / B's
    // price 500,000 = 4 units).
    await expect(page.getByText(fundBName).first()).toBeVisible()
    await expect(page.getByText(/4\.00000000/).first()).toBeVisible()

    // No realized gain (A's price == its average cost), so the account's
    // total value is unchanged at Rp 2,000,000.00 (B's row value + the
    // panel total, at least 2 occurrences).
    expect(
      await page.getByText(/Rp\s2,000,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)
  })
})
