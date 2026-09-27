import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

async function createAccount(
  page: Page,
  input: {
    name: string
    openingBalance?: string
    type?: "Credit Card"
  }
) {
  await page.getByRole("button", { name: "New account" }).click()
  await page.getByLabel("Name").fill(input.name)
  if (input.type) {
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: input.type }).click()
  }
  if (input.openingBalance) {
    await page.getByLabel("Opening balance").fill(input.openingBalance)
  }
  await page.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
}

async function createPaymentAccounts(
  page: Page,
  input: {
    bankName: string
    bankBalance: string
    cardName: string
    cardDebt?: string
  }
) {
  await page.goto("/accounts")
  await waitForHydration(page)
  await createAccount(page, {
    name: input.bankName,
    openingBalance: input.bankBalance,
  })
  await createAccount(page, {
    name: input.cardName,
    openingBalance: input.cardDebt,
    type: "Credit Card",
  })
}

async function submitCardPayment(
  page: Page,
  input: {
    amount: string
    bankName: string
    cardName: string
    note: string
  }
) {
  await page.goto("/transactions")
  await waitForHydration(page)
  await page.getByRole("button", { name: "New Transaction" }).click()
  await page.getByRole("tab", { name: "Transfer" }).click()
  await page.getByLabel("Transfer Note *").fill(input.note)
  await page.getByLabel("Amount *").fill(input.amount)
  await page
    .locator('select[name="accountId"]')
    .selectOption({ label: `${input.bankName} (IDR)` })
  await page
    .locator('select[name="toAccountId"]')
    .selectOption({ label: `${input.cardName} (IDR)` })
  await page.getByRole("button", { name: "Save Transaction" }).click()
}

async function openAccount(page: Page, name: string) {
  await page.getByRole("button", { name: `Open ${name}` }).click()
}

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

    await createPaymentAccounts(page, {
      bankName,
      bankBalance: "2000000",
      cardName,
      cardDebt: "1000000",
    })
    await submitCardPayment(page, {
      amount: "400000",
      bankName,
      cardName,
      note,
    })

    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(note)).toHaveCount(1)
    await expect(page.getByText("Pay credit card")).toBeVisible()
    await expect(page.getByText(bankName)).toBeVisible()
    await expect(page.getByText(cardName)).toBeVisible()

    await page.goto("/accounts")
    await waitForHydration(page)
    await openAccount(page, bankName)
    await expect(page.getByText("Rp 1,600,000.00").first()).toBeVisible()
    await page.getByRole("link", { name: "Back to accounts" }).click()
    await openAccount(page, cardName)
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

    await createPaymentAccounts(page, {
      bankName,
      bankBalance: "1000000",
      cardName,
    })
    await submitCardPayment(page, {
      amount: "400000",
      bankName,
      cardName,
      note: `Rejected overpayment ${suffix}`,
    })

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/Could not save transaction:/)).toBeVisible()
    await expect(dialog.getByText(/balance positive/)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    await page.goto("/accounts")
    await waitForHydration(page)
    await openAccount(page, bankName)
    await expect(page.getByText("Rp 1,000,000.00").first()).toBeVisible()
    await page.getByRole("link", { name: "Back to accounts" }).click()
    await openAccount(page, cardName)
    await expect(page.getByText("Rp 0.00").first()).toBeVisible()
  })
})
