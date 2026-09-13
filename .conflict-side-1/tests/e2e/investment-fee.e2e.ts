import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 Slice 3 / ADR-0054 — Investment fee UI (broker-agnostic).
// Onboard → create a cash account + a Tracked Asset (valuation-tracked) account
// → add a holding → open the Fee dialog and record a STANDALONE fee. The fee is
// an EXPENSE on the chosen cash account; the source holding is unchanged.
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("investment fee UI (PER-259 Slice 3)", () => {
  test("a standalone fee reduces the chosen cash account; source holding unchanged", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `Wallet ${suffix}`
    const portfolioName = `Portfolio ${suffix}`

    // --- Cash account the fee is charged to (opening balance 1,000,000) ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Tracked Asset account ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Seed a holding: 2 units @ 1,000,000 (value = cost = 2,000,000). ---
    await page.getByRole("button", { name: "Add holding" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill("Gold")
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Metal" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(/Rp\s2,000,000\.00/).first()).toBeVisible()

    // --- Record a Rp 25,000 fee charged to the wallet. ---
    await page.getByRole("button", { name: "Fee" }).first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Investment fee" })
    ).toBeVisible()
    await dialog.getByLabel(/^Amount/).fill("25000")
    await dialog.getByRole("combobox", { name: "Fee source account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByRole("button", { name: "Record fee" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Source holding UNCHANGED — value still Rp 2,000,000.00, and the account
    // hero still re-materializes to Rp 2,000,000.00 (>= 2 occurrences). A fee
    // never touches the position.
    expect(
      await page.getByText(/Rp\s2,000,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)

    // The fee expense landed on the wallet: open it and see the debit + row.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${walletName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(page.getByText(/Fee . Gold/).first()).toBeVisible()
    // Wallet balance is now 1,000,000 − 25,000 = 975,000.
    await expect(page.getByText(/Rp\s975,000\.00/).first()).toBeVisible()
  })
})
