import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-196 / ADR-0048 — real-browser proof of the valuation-linked transfer
// flow: the original bug repro was "record a redemption from a mutual-fund
// account to a bank account" producing a hidden transaction + a balance-drift
// badge. This drives the actual adaptive Transfer form end to end: create a
// cash account and a Tracked Asset account, submit a redemption transfer,
// and assert the cash Transaction is visible, the tracked account's balance
// is correct, and no drift badge appears — then delete it and assert the
// symmetric reversal.

test.describe("valuation-linked transfer (PER-196 / ADR-0048)", () => {
  test("redemption via the adaptive transfer form: visible transaction, correct balances, zero drift, then delete reverses it", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const cashName = `E2E Bank ${suffix}`
    const trackedName = `E2E Reksadana ${suffix}`

    // --- Create the cash account ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(cashName)
    await page.getByLabel("Opening balance").fill("5000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Create the Tracked Asset (valuation-tracked) account ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(trackedName)
    await page.getByRole("dialog").getByRole("combobox").first().click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // No drift on a freshly created tracked account.
    await expect(page.getByText("Balance drift")).toHaveCount(0)

    // --- Record the redemption: tracked -> cash ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(`Pencairan ${suffix}`)
    await page.getByLabel("Amount *").fill("400000")
    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${trackedName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${cashName} (IDR)` })

    // The adaptive field: prefilled latest (1,000,000) - amount (400,000).
    const newValueField = page.getByLabel(`New value of ${trackedName}`)
    await expect(newValueField).toBeVisible()
    await expect(newValueField).toHaveValue("600000")

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The cash-side Transaction is visible in the ledger — not hidden, the
    // original bug's other symptom.
    await expect(page.getByText(`Pencairan ${suffix}`)).toBeVisible()

    // --- Verify balances + zero drift on the accounts page ---
    // Fresh onboarded user with exactly these two accounts — a global text
    // check unambiguously proves the correct figure rendered somewhere.
    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText("Balance drift")).toHaveCount(0)
    await expect(page.getByText("Rp 600,000.00")).toBeVisible()
    await expect(page.getByText("Rp 5,400,000.00")).toBeVisible()

    // --- Delete it and verify symmetric reversal ---
    await page.goto("/transactions")
    await waitForHydration(page)
    // Only transaction on this fresh user's ledger — no scoping needed.
    // The inline delete button confirms via a native window.confirm().
    page.once("dialog", (dialog) => void dialog.accept())
    await page.getByRole("button", { name: "Delete Transaction" }).click()
    await expect(page.getByText(`Pencairan ${suffix}`)).toHaveCount(0)

    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText("Rp 1,000,000.00")).toBeVisible()
    await expect(page.getByText("Rp 5,000,000.00")).toBeVisible()
    await expect(page.getByText("Balance drift")).toHaveCount(0)
  })
})
