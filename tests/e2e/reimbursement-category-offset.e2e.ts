import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-260 / ADR-0055 — the reimbursement/refund category-offset toggle, driven
// through the real browser: record an ordinary expense, then record a
// reimbursement (Income tab, "This is a refund/reimbursement" toggle ON,
// category picker swapped to the SAME expense category), and verify the net
// figure shows up in two independent read paths that must never disagree —
// the Budget progress "Spent" figure for that category, and the dashboard's
// Cash flow report totals for the period.

test.describe("reimbursement/refund category offset", () => {
  test("toggling the switch nets the reimbursement against its expense category everywhere", async ({
    page,
  }) => {
    // The onboarding form defaults the family's base reporting currency to
    // USD, but new accounts default to IDR (account-form-dialog.tsx) and no
    // e2e spec seeds an FX rate snapshot. This test's assertions read
    // BASE-CURRENCY-derived figures (cash-flow totals, budget "spent"), so
    // family base currency must match the IDR accounts/transactions created
    // below — otherwise every row is FX-pending and nets to zero everywhere.
    await onboard(page, { currency: "IDR" })

    // PER-183: onboarding no longer seeds a starter account.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Reimbursement Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)

    const uniqueSuffix = Date.now().toString(36)
    const categoryName = `E2E Reimb Food ${uniqueSuffix}`
    const expenseDescription = `E2E dinner ${uniqueSuffix}`
    const reimbursementDescription = `E2E family covered dinner ${uniqueSuffix}`

    // --- Step 1: record the ordinary expense, quick-creating the category ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByLabel("Description *").fill(expenseDescription)
    await page.getByLabel("Amount *").fill("180500")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryName)

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(expenseDescription)).toBeVisible()

    // --- Step 2: record the reimbursement on the Income tab ---
    // The singleton "New Transaction" modal resets its form on a successful
    // submit (PER-205), so the account selected in Step 1 does not carry
    // over — it must be reselected here too.
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    await page.getByRole("tab", { name: "Income" }).click()

    // Toggle OFF (default): the category picker is still income-type-only —
    // the just-created EXPENSE category must NOT appear as a selectable
    // existing option (an exact-name match, as opposed to the unavoidable
    // "Create category "..."" quick-create prompt, which always contains the
    // typed name as a substring).
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await expect(
      page.getByRole("option", { name: categoryName, exact: true })
    ).toHaveCount(0)
    await page.keyboard.press("Escape")

    // Toggle ON: the picker swaps to EXPENSE categories, marked with `↩`.
    await page.locator("#reimbursement-toggle").click()
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: new RegExp(`↩.*${categoryName}`) })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryName)

    await page.getByLabel("Description *").fill(reimbursementDescription)
    await page.getByLabel("Amount *").fill("180000")

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(reimbursementDescription)).toBeVisible()

    // --- Step 3: Budget progress must show the NET spend for the category ---
    await page.goto("/budgets")
    await waitForHydration(page)

    await page.getByLabel(categoryName).fill("200000")
    await page.getByRole("button", { name: "Save budget" }).click()
    await expect(page.getByText("Saving…")).toHaveCount(0)

    const categoryRow = page.locator("tr", { hasText: categoryName })
    // Budgeted = the Rp 200,000 allocation just set. Spent must be the NET
    // real burden — Rp 180,500 expense minus Rp 180,000 reimbursement =
    // Rp 500 — never the un-netted Rp 180,500 that would mean the Spending
    // report and Budget progress disagree about the same transactions.
    await expect(categoryRow).toContainText(/Rp\s200,000\.00/)
    await expect(categoryRow).toContainText(/Rp\s?500\.00/)
    await expect(categoryRow).not.toContainText(/180,500/)

    // --- Step 4: the dashboard's Cash flow report reflects both legs ------
    await page.goto("/dashboard")
    await waitForHydration(page)

    await expect(page.getByText(/Rp\s180,500\.00/).first()).toBeVisible()
    await expect(page.getByText(/Rp\s180,000\.00/).first()).toBeVisible()
  })
})
