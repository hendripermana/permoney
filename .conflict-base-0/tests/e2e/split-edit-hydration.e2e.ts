import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-209 — editing a SPLIT transaction must hydrate its allocation.
//
// The edit modal is opened from transactions.tsx with an `editData` object that
// (before the fix) was rebuilt field-by-field and OMITTED `isSplit` +
// `splitEntries`. The modal already hydrates its split state from those two
// fields in its useState initializers, so dropping them made an edited split
// fall back to a blank [blank, blank] allocation with the toggle OFF — the
// Category Allocation panel vanished and the categories/amounts were lost.
//
// This spec drives the real browser: it quick-creates two categories, records a
// balanced 2-row split expense, submits it, then reopens that transaction for
// EDIT and asserts the allocation is fully hydrated (toggle ON, both rows with
// their categories selected and amounts populated, frame reports "balanced").

test.describe("editing a split transaction hydrates its allocation", () => {
  test("reopening a split for edit restores toggle, categories, and amounts", async ({
    page,
  }) => {
    await onboard(page)

    // PER-183: onboarding no longer seeds a starter account — create one so the
    // transaction form's account dropdown has something to select.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Split Edit Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)

    const uniqueSuffix = Date.now().toString(36)
    const description = `E2E split edit ${uniqueSuffix}`
    const categoryA = `E2E Split Cat A ${uniqueSuffix}`
    const categoryB = `E2E Split Cat B ${uniqueSuffix}`

    // --- Record a balanced 2-row SPLIT expense ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("100000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    // Quick-create two categories via the parent Category field so the split
    // rows have real categories to choose from (the ephemeral e2e DB seeds no
    // system categories). Each "Create ..." persists the category family-wide,
    // so both remain available to the split-row selects after toggling split on.
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryA)
    await page
      .getByRole("option", { name: `Create category "${categoryA}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryA)

    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryB)
    await page
      .getByRole("option", { name: `Create category "${categoryB}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryB)

    // Activate split mode; the Category Allocation panel appears with 2 rows.
    await page.locator("#split-mode-toggle").click()
    await expect(page.getByText("Category Allocation")).toBeVisible()

    const splitCategories = page.getByLabel("Category for split entry")
    const splitDescriptions = page.getByLabel("Description for split entry")
    const splitAmounts = page.getByLabel("Amount for split entry")

    await splitCategories.nth(0).selectOption({ label: categoryA })
    await splitDescriptions.nth(0).fill("Groceries part")
    await splitAmounts.nth(0).fill("60000")

    await splitCategories.nth(1).selectOption({ label: categoryB })
    await splitDescriptions.nth(1).fill("Household part")
    await splitAmounts.nth(1).fill("40000")

    // Balanced allocation → status line confirms all funds allocated.
    await expect(page.getByText("Perfect! All funds allocated")).toBeVisible()

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(description)).toBeVisible()

    // --- Reopen that transaction for EDIT ---
    await page.getByRole("button", { name: "Edit Transaction" }).first().click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // The split toggle must be ON and the allocation panel present (this is the
    // exact regression PER-209 fixes — previously both were lost on edit).
    await expect(page.locator("#split-mode-toggle")).toBeChecked()
    await expect(page.getByText("Category Allocation")).toBeVisible()

    // Both rows are hydrated: two category selects, both with a real (non-empty)
    // category value selected, and their amounts populated.
    const editCategories = page.getByLabel("Category for split entry")
    const editDescriptions = page.getByLabel("Description for split entry")
    const editAmounts = page.getByLabel("Amount for split entry")

    await expect(editCategories).toHaveCount(2)
    // A non-empty value proves a real categoryId is selected (the placeholder
    // "-- Select --" option has value ""), which only round-trips if the
    // allocation's categoryId was hydrated from editData.splitEntries.
    await expect(editCategories.nth(0)).toHaveValue(/.+/)
    await expect(editCategories.nth(1)).toHaveValue(/.+/)

    await expect(editDescriptions.nth(0)).toHaveValue("Groceries part")
    await expect(editDescriptions.nth(1)).toHaveValue("Household part")

    await expect(editAmounts.nth(0)).toHaveValue("60000")
    await expect(editAmounts.nth(1)).toHaveValue("40000")

    // Bundled polish: a fully balanced allocation still reports success on edit.
    await expect(page.getByText("Perfect! All funds allocated")).toBeVisible()
  })
})
