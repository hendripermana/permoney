import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 / ADR-0054 — the global ledger's Transfer tab used to offer EVERY
// account, holdings-tracked ones included. A user could fill in a whole
// transfer against such an account and only learn on submit, from a raw
// `HoldingsAccountLedgerError`, that it moves money through trades only. The
// per-account page already hides that path; this proves the global entry point
// now teaches the same rule BEFORE the user commits, and hands them the real
// Buy/Sell dialog with the cash account they already picked carried over.

test.describe("transfer → trade redirect for holdings accounts", () => {
  test("picking a holdings account in the Transfer tab explains why and opens the trade dialog", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `Fund R ${suffix}`

    // --- A cash account and a tracked-asset account. ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("5000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Give it a position, so it actually carries holdings. ---
    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await page.getByRole("button", { name: "Buy" }).first().click()
    const seedDialog = page.getByRole("dialog")
    await seedDialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await seedDialog.getByLabel("Instrument name").fill(fundName)
    await seedDialog.getByLabel("Quantity").fill("10")
    await seedDialog.getByLabel(/Unit price/i).fill("100000")
    await seedDialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundName).first()).toBeVisible()

    // --- Now try to move money into it from the GLOBAL ledger's Transfer tab. ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("tab", { name: "Transfer" }).click()

    // The option itself is marked, before anything is even selected.
    await expect(page.locator('select[name="toAccountId"]')).toContainText(
      `${portfolioName} (IDR) · holdings`
    )

    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${walletName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${portfolioName} (IDR) · holdings` })

    // The inline notice explains it instead of a post-submit server rejection.
    const notice = page.getByTestId("holdings-transfer-notice")
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(portfolioName)
    await expect(notice).toContainText("Buy/Sell trade")

    // --- Hand over to the REAL trade dialog, funding account pre-filled. ---
    await notice.getByRole("button", { name: "Record a buy instead" }).click()

    const tradeDialog = page.getByRole("dialog")
    await expect(
      tradeDialog.getByRole("radio", { name: "Buy" })
    ).toHaveAttribute("data-state", "on")
    await expect(
      tradeDialog.getByRole("combobox", { name: "Funding account" })
    ).toContainText(walletName)

    // And it records a real trade from here, same flow as the account page.
    await tradeDialog.getByRole("combobox", { name: "Instrument" }).click()
    await page.getByRole("option", { name: fundName }).click()
    await tradeDialog.getByLabel("Quantity").fill("5")
    await tradeDialog.getByLabel(/Unit price/i).fill("120000")
    await tradeDialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // 10 + 5 units at the blended cost — the position grew via the trade path.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(page.getByText("15.00000000").first()).toBeVisible()
  })
})
