import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 / ADR-0054 audit (2026-08-24) — two Sell-side gaps in the Buy/Sell
// dialog that `switch-dialog.tsx` already handled for its own sell leg:
//
//  1. OVERSELL was invisible until the server rejected it. ADR-0054's Sell
//     cascade calls for a "sell-qty <= held" guard; the dialog neither showed
//     how many units were held nor blocked submitting more than that.
//  2. The instrument choice is STICKY across a Side flip, so picking
//     "New instrument…" on Buy and then switching to Sell submitted the literal
//     `__new__` sentinel and surfaced the raw server error
//     "Instrument __new__ not found for this family".
//
// The server was (and stays) the law in both cases; this drives the real
// browser to prove the dialog now refuses the first and never sends the second.

test.describe("Sell guards in the Buy/Sell dialog", () => {
  test("selling more units than held is blocked in the dialog, and a Buy→Sell flip keeps a real instrument", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `Fund S ${suffix}`

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

    // --- Seed a 10-unit position. ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    const buyDialog = page.getByRole("dialog")
    await buyDialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await buyDialog.getByLabel("Instrument name").fill(fundName)
    await buyDialog.getByLabel("Quantity").fill("10")
    await buyDialog.getByLabel(/Unit price/i).fill("10000")
    await buyDialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundName).first()).toBeVisible()

    // --- 1. Oversell is refused by the dialog itself. ---
    await page.getByRole("button", { name: "Sell" }).first().click()
    const sellDialog = page.getByRole("dialog")
    await expect(sellDialog.getByText(/10\.00000000 units held/)).toBeVisible()
    await sellDialog.getByLabel("Quantity").fill("20")
    await sellDialog.getByLabel(/Unit price/i).fill("12000")
    await expect(
      sellDialog.getByText(/you cannot sell more than that/)
    ).toBeVisible()
    await expect(
      sellDialog.getByRole("button", { name: "Record sell" })
    ).toBeDisabled()

    // Within the held quantity it becomes submittable again.
    await sellDialog.getByLabel("Quantity").fill("4")
    await expect(
      sellDialog.getByRole("button", { name: "Record sell" })
    ).toBeEnabled()
    await sellDialog.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- 2. "New instrument…" on Buy, then flip to Sell: the dialog falls back
    // to the real position instead of sending the `__new__` sentinel. ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    const flipDialog = page.getByRole("dialog")
    await flipDialog.getByRole("combobox", { name: "Instrument" }).click()
    await page.getByRole("option", { name: "New instrument…" }).click()
    // Side is a segmented toggle (Radix ToggleGroup type="single" → radios),
    // not a dropdown.
    await flipDialog.getByRole("radio", { name: "Sell" }).click()
    await expect(
      flipDialog.getByRole("combobox", { name: "Instrument" })
    ).toContainText(fundName)

    await flipDialog
      .getByRole("combobox", { name: "Destination account" })
      .click()
    await page.getByRole("option", { name: walletName }).click()
    await flipDialog.getByLabel("Quantity").fill("2")
    await flipDialog.getByLabel(/Unit price/i).fill("12000")
    await flipDialog.getByRole("button", { name: "Record sell" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    // 10 − 2 units left, so the position survives the sell.
    await expect(page.getByText(fundName).first()).toBeVisible()
  })
})
