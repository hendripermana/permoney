import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-189 — quick-create Merchant & Category inline in the transaction form.
// Drives the real browser -> server-fn -> Postgres path: opens Add
// Transaction, creates a brand-new merchant and a brand-new category via the
// combobox's "Create ..." affordance, submits, and asserts the persisted
// transaction row reflects both freshly created entities (proof they were
// actually written, not just selected client-side).

test.describe("quick-create merchant & category from the transaction form", () => {
  test("adds a transaction with a brand-new merchant and category", async ({
    page,
  }) => {
    await onboard(page)

    // PER-183: onboarding no longer seeds a starter account — create one so
    // the transaction form's account dropdown has something to select.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Quick-Create Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)

    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    const uniqueSuffix = Date.now().toString(36)
    const description = `E2E quick-create ${uniqueSuffix}`
    const merchantName = `E2E Coffee Shop ${uniqueSuffix}`
    const categoryName = `E2E Coffee ${uniqueSuffix}`

    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("45000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    // --- Quick-create Merchant ---
    await page.getByLabel("Merchant (Optional)").click()
    await page.getByPlaceholder("Search merchants...").fill(merchantName)
    await page
      .getByRole("option", { name: `Create merchant "${merchantName}"` })
      .click()
    await expect(page.getByLabel("Merchant (Optional)")).toContainText(
      merchantName
    )

    // --- Quick-create Category ---
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryName)

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The persisted row shows the freshly created merchant + category names
    // — this only renders once the ledger read joins to real Merchant/
    // Category rows, so it proves the quick-created entities round-tripped
    // through the canonical server fns rather than staying client-only.
    await expect(page.getByText(description)).toBeVisible()
    await expect(page.getByText(merchantName)).toBeVisible()
    await expect(page.getByText(categoryName)).toBeVisible()
  })
})
