import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-205 — the split-allocation state must NOT survive a submit.
//
// The "New Transaction" modal is a persistently-mounted singleton, so its
// split state (isSplit toggle + the Category Allocation rows) lives in React
// state OUTSIDE TanStack Form. TanStack Form resets on submit, but the split
// state did not, so after submitting a split transaction and reopening the
// form, the previous allocation rows persisted as ACTIVE — showing a stale
// "Over allocated" banner on a brand-new entry.
//
// This spec drives the real browser: creates an account, records a split
// transaction, submits it, reopens the New Transaction form, and asserts the
// split allocation is gone (toggle off, no Category Allocation panel).

test.describe("split-transaction form state resets after submit", () => {
  test("reopening New Transaction shows a clean, inactive split allocation", async ({
    page,
  }) => {
    await onboard(page)

    // PER-183: onboarding no longer seeds a starter account — create one so
    // the transaction form's account dropdown has something to select.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Split Reset Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)

    const uniqueSuffix = Date.now().toString(36)
    const description = `E2E split reset ${uniqueSuffix}`

    // --- Record a SPLIT transaction ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("100000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    // Activate split mode; the Category Allocation panel appears with 2 rows.
    await page.locator("#split-mode-toggle").click()
    await expect(page.getByText("Category Allocation")).toBeVisible()

    // Balance the two default rows so the total matches the parent amount
    // (Save is disabled while the split is unbalanced).
    const splitDescriptions = page.getByLabel("Description for split entry")
    const splitAmounts = page.getByLabel("Amount for split entry")
    await splitDescriptions.nth(0).fill("Groceries part")
    await splitAmounts.nth(0).fill("60000")
    await splitDescriptions.nth(1).fill("Household part")
    await splitAmounts.nth(1).fill("40000")

    // "Over allocated" must be gone once the split is balanced.
    await expect(page.getByText("Perfect! All funds allocated")).toBeVisible()

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(description)).toBeVisible()

    // --- Reopen the New Transaction form ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // The split toggle must be OFF and the allocation panel gone — no stale
    // rows, no phantom "Over allocated" banner on a fresh entry.
    await expect(page.locator("#split-mode-toggle")).not.toBeChecked()
    await expect(page.getByText("Category Allocation")).toHaveCount(0)
    await expect(page.getByText(/Over allocated/)).toHaveCount(0)
  })
})
