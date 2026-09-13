import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-210 — a split transaction must KEEP its single merchant.
//
// Domain semantic (Model 1): merchant = WHERE a purchase happened (one
// receipt/store); category = WHAT each line item is. Splitting a purchase
// across categories does not change that it is one receipt at one merchant, so
// the split PARENT retains its single merchantId (only categoryId is nulled on
// the parent — categories live on the children).
//
// Before the fix the server (and the client submit payload) nulled the parent
// merchant on split, and a DB CHECK enforced it, so the ledger row showed "-".
//
// This spec drives the real browser: it quick-creates a merchant + two
// categories, records a balanced 2-row split expense WITH the merchant
// selected, submits, asserts the ledger row shows the merchant (not "-"), then
// reopens the transaction for EDIT and asserts the merchant field is hydrated.

test.describe("a split transaction keeps its merchant", () => {
  test("records a split with a merchant, shows it in the ledger, and hydrates it on edit", async ({
    page,
  }) => {
    await onboard(page)

    // PER-183: onboarding no longer seeds a starter account — create one so the
    // transaction form's account dropdown has something to select.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Split Merchant Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)

    const uniqueSuffix = Date.now().toString(36)
    const description = `E2E split merchant ${uniqueSuffix}`
    const merchantName = `Indomaret ${uniqueSuffix}`
    const categoryA = `E2E SM Cat A ${uniqueSuffix}`
    const categoryB = `E2E SM Cat B ${uniqueSuffix}`

    // --- Record a balanced 2-row SPLIT expense WITH a merchant ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("100000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    // Quick-create a merchant via the parent Merchant field. It persists the
    // merchant family-wide and selects it on the parent.
    await page.getByLabel("Merchant (Optional)").click()
    await page.getByPlaceholder("Search merchants...").fill(merchantName)
    await page
      .getByRole("option", { name: `Create merchant "${merchantName}"` })
      .click()
    await expect(page.getByLabel("Merchant (Optional)")).toContainText(
      merchantName
    )

    // Quick-create two categories via the parent Category field so the split
    // rows have real categories to choose from (the ephemeral e2e DB seeds no
    // system categories).
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

    // The ledger row shows the merchant (previously "-" because the merchant
    // was silently dropped on split). The merchant column is md+ only, which the
    // default Playwright viewport (1280px) satisfies.
    await expect(page.getByText(merchantName).first()).toBeVisible()

    // --- Reopen that transaction for EDIT ---
    await page.getByRole("button", { name: "Edit Transaction" }).first().click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // The split toggle must be ON and the merchant field hydrated with the saved
    // merchant (PER-209 passes merchantId in editData; PER-210 persists it).
    await expect(page.locator("#split-mode-toggle")).toBeChecked()
    await expect(page.getByLabel("Merchant (Optional)")).toContainText(
      merchantName
    )
  })
})
