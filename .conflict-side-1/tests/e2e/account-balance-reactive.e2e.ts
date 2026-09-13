import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-247 follow-up — the account-detail hero balance must recalculate
// REACTIVELY after adding a transaction from the same page, without a manual
// reload. A transaction mutation applies an atomic signed delta to the account
// balance server-side; the client must resync `accountCollection` (not only
// `transactionCollection`) so the hero + KPIs update in place. This spec drives
// the real browser -> server-fn -> Postgres path and asserts the new balance
// appears WITHOUT page.reload() — it would fail (hero stuck on the old balance)
// before the resync fix.
test.describe("account balance reactivity (PER-247)", () => {
  test("hero balance updates in place after adding a transaction — no reload", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E Balance ${suffix}`

    // Create an account with a distinctive opening balance (no reserve, so the
    // only 2,000,000 on the page is the hero balance).
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Open the detail page and confirm the starting hero balance.
    await page.getByRole("button", { name: `Open ${accountName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(page.getByText("Rp 2,000,000.00").first()).toBeVisible()

    // Add a transaction from the account page itself (in-place modal). The
    // account is pre-filled via defaultAccountId (PER-247 account-aware add).
    const description = `E2E reactive expense ${suffix}`
    const categoryName = `E2E Reactive ${suffix}`
    await page.getByRole("button", { name: "Add transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("250000")
    // Expense requires a category — quick-create one so the spec is
    // self-contained (does not depend on seeded categories).
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    // Wait for the quick-created category to actually register in the form
    // before submitting — otherwise Save can fire before the category id
    // resolves and the insert is rejected (the modal stays open). Mirrors
    // transaction-quick-create.e2e. The heavier per-account render (PER-241
    // virtualized statement) makes this race deterministic without the wait.
    await expect(page.getByLabel("Category *")).toContainText(categoryName)
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // THE ASSERTION: without any reload, the hero balance recalculates to
    // 2,000,000 - 250,000 = 1,750,000. Before the accountCollection resync fix
    // this stayed at 2,000,000 until a manual reload.
    await expect(page.getByText("Rp 1,750,000.00").first()).toBeVisible()
    await expect(page.getByText("Rp 2,000,000.00")).toHaveCount(0)

    // The new transaction also shows in the statement (newest first).
    await expect(page.getByText(description)).toBeVisible()
  })
})
