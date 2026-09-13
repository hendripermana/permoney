import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-200 repro — a NORMAL transfer between two transaction_flow accounts
// (bank -> e-wallet, the creator's "top up e-wallet" scenario). No tracked
// asset involved, so the adaptive valuation field never shows and
// newValuationValue is null. This is the coverage gap: only valuation-linked
// and imported transfers were e2e-tested, never a plain cash->cash transfer
// created through the form. If the creator's "appears then disappears" report
// is a real bug in the normal-transfer form path, this reproduces it.

test.describe("normal transfer (PER-200 repro)", () => {
  test("bank -> e-wallet transfer via the form: transaction persists and balances update", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const bankName = `E2E Bank ${suffix}`
    const ewalletName = `E2E Dana ${suffix}`

    // --- Create the bank account (default cash-like type) ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(bankName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Create the second account (default cash-like type, same as the
    // valuation test's cash account — no subtype needed) ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(ewalletName)
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Record the top-up: bank -> e-wallet ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(`Top up ${suffix}`)
    await page.getByLabel("Amount *").fill("150000")
    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${bankName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${ewalletName} (IDR)` })

    // No adaptive valuation field for a normal transfer.
    await expect(page.getByLabel(`New value of ${ewalletName}`)).toHaveCount(0)

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // THE BUG CHECK: the transfer must remain in the ledger, not vanish.
    await expect(page.getByText(`Top up ${suffix}`)).toBeVisible()

    // --- Balances: bank 2,000,000 - 150,000 = 1,850,000 ; e-wallet = 150,000 ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText("Rp 1,850,000.00")).toBeVisible()
    await expect(page.getByText("Rp 150,000.00")).toBeVisible()
  })
})
