import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// The "form feels hung after submit → user clicks again → transaction saved
// twice" bug, end to end. The old form minted a fresh idempotency key on every
// submit and left the save button live for the whole round trip, so a second
// click was a second, legitimate-looking mutation (prod corroboration: 13
// duplicate-suspect groups).
//
// This drives the real browser → server-fn → Postgres path and double-clicks
// Save back-to-back — both clicks land in the window before the first submit
// re-renders the button as disabled. Exactly one transaction must come out the
// other side, and a reload must still show one row (the assertion is on the
// persisted state, not just the optimistic overlay).

test.describe("transaction form double-submit", () => {
  test("double-clicking Save persists exactly one transaction", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E Double Submit Bank ${suffix}`
    const categoryName = `E2E Double Submit Cat ${suffix}`
    const description = `Double submit ${suffix}`

    // --- An account for the transaction form's account dropdown (PER-183:
    // onboarding seeds none) ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Record the expense through the form ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("25000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    // Expense rows require a category and fresh families have none, so
    // quick-create one inline — the same affordance a real user has.
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryName)

    // --- The double-click ---
    await page.getByRole("button", { name: "Save Transaction" }).dblclick()

    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(description)).toHaveCount(1)

    // Reload: one row server-side, not an optimistic survivor.
    await page.reload()
    await waitForHydration(page)
    await expect(page.getByText(description)).toHaveCount(1)
  })
})
