import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 Slice 5 / ADR-0054 — Edit/correct + delete a Buy/Sell trade, driven
// through the real per-account statement row (not a direct server-fn call).
// Record a Buy via the Trade dialog, correct its quantity through the
// dedicated TradeCorrectionDialog (proving the statement row's Edit button
// routes a trade to the CORRECTION flow, not the generic transaction modal),
// then delete the corrected trade and verify the position/cash fully
// reverse — the same "reversal-and-replace" / "reversal-only" the server
// tests already prove, now proven end to end through the browser.
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("trade correction UI (PER-259 Slice 5)", () => {
  test("editing a trade corrects quantity/cash via the dedicated dialog; deleting it fully reverses the position", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `Fund X ${suffix}`

    // --- Cash (funding) account ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("10000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Tracked Asset (valuation-tracked) investment account ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Record a Buy: 10 units @ 100,000 = 1,000,000 cash out. ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    let dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundName)
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Unit price/i).fill("100000")
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await expect(page.getByText(fundName).first()).toBeVisible()
    await expect(page.getByText(/Rp\s1,000,000\.00/).first()).toBeVisible()

    // --- Edit the trade: statement row's Edit button routes a trade to the
    // dedicated correction dialog (not the generic transaction modal). ---
    await page.getByRole("button", { name: "Edit Transaction" }).first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: `Edit ${fundName}` })
    ).toBeVisible()

    // Correct the quantity down to 8 units (same price) — cash moves to
    // 800,000, and the position becomes 8.00000000 units.
    await dialog.getByLabel("Quantity").fill("8")
    await dialog.getByRole("button", { name: "Save correction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Position corrected: 8 units, value 800,000. The wallet kept 200,000 of
    // the original 1,000,000 debit (10,000,000 - 800,000 = 9,200,000).
    await expect(page.getByText(/8\.00000000/).first()).toBeVisible()
    await expect(page.getByText(/Rp\s800,000\.00/).first()).toBeVisible()
    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText(/Rp\s9,200,000\.00/).first()).toBeVisible()

    // --- Delete the (corrected) trade: position + cash fully reverse. ---
    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    page.once("dialog", (d) => void d.accept())
    await page
      .getByRole("button", { name: "Delete Transaction" })
      .first()
      .click()
    await expect(page.getByText(fundName)).toHaveCount(0)

    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText(/Rp\s10,000,000\.00/).first()).toBeVisible()
    await expect(page.getByText("Balance drift")).toHaveCount(0)
  })
})
