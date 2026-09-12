import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-83 Slice 1 — "Manual reconciliation workflow foundation".
//
// TRANSACTION-LEVEL reconciliation on the per-account statement: create a
// CLEARED and a PENDING transaction, enter reconcile mode, prove the PENDING
// row gets no checkbox at all, tick the CLEARED row, enter the matching
// statement balance, and assert the difference collapses to an unambiguous
// "Matched" state with the row now showing the "Reconciled" badge. This is
// orthogonal to the pre-existing ACCOUNT-level "Reconcile" button (covered by
// account-detail.e2e.ts) — that one writes a ground_truth balance anchor and
// is untouched by this feature.

test.describe("transaction-level reconciliation (PER-83 Slice 1)", () => {
  test("reconcile mode: PENDING row has no checkbox, CLEARED row reconciles to a matched statement", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E Reconcile ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${accountName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    const clearedDescription = `E2E Cleared Row ${suffix}`
    const pendingDescription = `E2E Pending Row ${suffix}`
    const clearedCategory = `E2E Reconcile Category A ${suffix}`
    const pendingCategory = `E2E Reconcile Category B ${suffix}`

    // --- A CLEARED expense (the default status — no click needed) ---
    await page.getByRole("button", { name: "Add transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByLabel("Description *").fill(clearedDescription)
    await page.getByLabel("Amount *").fill("50000")
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(clearedCategory)
    await page
      .getByRole("option", { name: `Create category "${clearedCategory}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(clearedCategory)
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(clearedDescription)).toBeVisible()

    // --- A PENDING expense (explicitly picked in the status row) ---
    await page.getByRole("button", { name: "Add transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByLabel("Description *").fill(pendingDescription)
    await page.getByLabel("Amount *").fill("15000")
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(pendingCategory)
    await page
      .getByRole("option", { name: `Create category "${pendingCategory}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(pendingCategory)
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Pending" })
      .click()
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(pendingDescription)).toBeVisible()
    // The PENDING badge on the ordinary (non-reconcile-mode) row confirms the
    // status actually landed as PENDING, not silently defaulted to CLEARED.
    await expect(page.getByText("Pending", { exact: true })).toBeVisible()

    // --- Enter reconcile mode ---
    await page.getByRole("button", { name: "Reconcile mode" }).click()
    await expect(page.getByText("Enter the statement balance")).toBeVisible()

    // Exactly ONE checkbox renders — the PENDING row gets none at all (not
    // merely a disabled one), so this count alone proves the exclusion.
    const reconcileCheckboxes = page.getByRole("checkbox", {
      name: "Reconcile transaction",
    })
    await expect(reconcileCheckboxes).toHaveCount(1)

    // --- Check the CLEARED row and enter the matching statement balance ---
    await reconcileCheckboxes.click()
    await expect(
      page.getByRole("checkbox", { name: "Unreconcile transaction" })
    ).toBeVisible()
    // The row itself now shows the persisted "Reconciled" badge.
    await expect(page.getByText("Reconciled", { exact: true })).toBeVisible()

    // An expense's signed delta from this account's perspective is negative
    // (money out), so the matching statement balance is the negative of the
    // amount typed above.
    await page.getByLabel("Statement ending balance").fill("-50000")
    await expect(page.getByText("Matched", { exact: true })).toBeVisible()

    // --- Un-reconcile it: the badge and checkbox both revert ---
    await page
      .getByRole("checkbox", { name: "Unreconcile transaction" })
      .click()
    await expect(
      page.getByRole("checkbox", { name: "Reconcile transaction" })
    ).toBeVisible()
    await expect(page.getByText("Reconciled", { exact: true })).toHaveCount(0)
  })
})
