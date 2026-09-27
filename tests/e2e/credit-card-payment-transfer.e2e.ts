import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

test.describe("credit-card payment transfer", () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test.setTimeout(120_000)

  test("bank payment reduces cash and moves card debt toward zero", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const bankName = `E2E Payment Bank ${suffix}`
    const cardName = `E2E Credit Card ${suffix}`
    const note = `Pay card ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(bankName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(cardName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Credit Card" }).click()
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(note)
    await page.getByLabel("Amount *").fill("400000")
    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${bankName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${cardName} (IDR)` })
    await page.getByRole("button", { name: "Save Transaction" }).click()

    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(note)).toHaveCount(1)
    await expect(page.getByText("Pay credit card")).toBeVisible()
    await expect(page.getByText(bankName)).toBeVisible()
    await expect(page.getByText(cardName)).toBeVisible()

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${bankName}` }).click()
    await expect(page.getByText("Rp 1,600,000.00").first()).toBeVisible()

    await page.getByRole("link", { name: "Back to accounts" }).click()
    await page.getByRole("button", { name: `Open ${cardName}` }).click()
    await expect(page.getByText("Rp 600,000.00").first()).toBeVisible()
    await expect(page.getByText(/Needs reconcile|Balance drift/)).toHaveCount(0)
  })

  test("overpayment is rejected without silently closing the form", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const bankName = `E2E Overpay Bank ${suffix}`
    const cardName = `E2E Zero Card ${suffix}`
    const note = `Rejected overpayment ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(bankName)
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(cardName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Credit Card" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(note)
    await page.getByLabel("Amount *").fill("400000")
    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${bankName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${cardName} (IDR)` })
    await page.getByRole("button", { name: "Save Transaction" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/Could not save transaction:/)).toBeVisible()
    await expect(dialog.getByText(/balance positive/)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${bankName}` }).click()
    await expect(page.getByText("Rp 1,000,000.00").first()).toBeVisible()
    await page.getByRole("link", { name: "Back to accounts" }).click()
    await page.getByRole("button", { name: `Open ${cardName}` }).click()
    await expect(page.getByText("Rp 0.00").first()).toBeVisible()
  })
})
