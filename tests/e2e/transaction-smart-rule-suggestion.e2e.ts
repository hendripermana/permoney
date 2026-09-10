import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-253 (Tier 4) — "Auto-apply Smart Rules on create (rules exist but are
// NOT auto-applied today — real gap)". `applySmartRules` was already wired
// into the CSV/bank-statement import flow (src/server/imports.ts) but never
// consulted from the manual "New Transaction" form — the primary, most-used
// entry point. This drives the real browser -> server-fn -> Postgres path:
// create a Smart Rule via the Settings > Import rules UI, then prove the
// "New Transaction" form pre-fills its category/merchant from a matching
// description, AND that a manual pick before the suggestion lands is never
// overwritten (the "don't fight the user's choice" half of the contract).

test.describe("Smart Rule auto-suggestion on manual transaction create", () => {
  test("pre-fills category & merchant from a matching description, and does not overwrite a manual pick", async ({
    page,
  }) => {
    await onboard(page)

    // An account for the transaction form's account dropdown (PER-183:
    // onboarding no longer seeds one).
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Smart Rule Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    const uniqueSuffix = Date.now().toString(36)
    const keyword = `smartrulekw${uniqueSuffix}`
    const categoryName = `E2E Coffee ${uniqueSuffix}`
    const merchantName = `E2E Coffee Shop ${uniqueSuffix}`
    const otherCategoryName = `E2E Other ${uniqueSuffix}`

    // --- Create the Smart Rule (quick-create category + merchant inline via
    // the transaction form's own comboboxes would work too, but the rules
    // page is the canonical place a real user configures this). ---
    await page.goto("/transactions")
    await waitForHydration(page)

    // Seed a category and a second, unrelated category via the "New
    // Transaction" quick-create affordance so the rules page's <Select>
    // options include both — this also creates `otherCategoryName`, used
    // below to prove a manual pick survives.
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByLabel("Merchant (Optional)").click()
    await page.getByPlaceholder("Search merchants...").fill(merchantName)
    await page
      .getByRole("option", { name: `Create merchant "${merchantName}"` })
      .click()
    // Quick-create refetches `transactionFormData` on success, which briefly
    // disables every EntityCombobox in the form (isLoading) — wait for the
    // merchant creation to fully settle before touching Category, or that
    // click can land mid-refetch and silently no-op.
    await expect(page.getByLabel("Merchant (Optional)")).toContainText(
      merchantName
    )
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryName)
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(otherCategoryName)
    await page
      .getByRole("option", { name: `Create category "${otherCategoryName}"` })
      .click()
    // Quick-create persists via its own server-fn mutation regardless of
    // whether this transaction is ever submitted — cancel out rather than
    // saving a throwaway row.
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/settings/rules")
    await waitForHydration(page)
    await page.getByPlaceholder("e.g. Starbucks, Fore, Spotify").fill(keyword)
    await page.getByRole("combobox").filter({ hasText: "No category" }).click()
    await page.getByRole("option", { name: categoryName }).click()
    await page.getByRole("combobox").filter({ hasText: "No merchant" }).click()
    await page.getByRole("option", { name: merchantName }).click()
    await page.getByRole("button", { name: "Add rule" }).click()
    await expect(page.getByText(`IF “${keyword}”`)).toBeVisible()

    // --- Case 1: typing a matching description pre-fills both fields. ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    const matchingDescription = `Payment at ${keyword} downtown`
    await page.getByLabel("Description *").fill(matchingDescription)
    await page.getByLabel("Amount *").fill("25000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })

    await expect(page.getByLabel("Category *")).toContainText(categoryName)
    await expect(page.getByLabel("Merchant (Optional)")).toContainText(
      merchantName
    )

    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(matchingDescription)).toBeVisible()
    await expect(page.getByText(categoryName).first()).toBeVisible()

    // --- Case 2: a manual category pick BEFORE the suggestion would land is
    // never fought by a later-arriving suggestion. ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(otherCategoryName)
    await page.getByRole("option", { name: otherCategoryName }).click()
    await expect(page.getByLabel("Category *")).toContainText(otherCategoryName)

    const secondMatchingDescription = `Another ${keyword} charge`
    await page.getByLabel("Description *").fill(secondMatchingDescription)
    // Give the debounced suggestion lookup a full window to resolve, then
    // assert the manual pick is still in place — proving the suggestion was
    // suppressed, not just "hasn't arrived yet".
    await page.waitForTimeout(1000)
    await expect(page.getByLabel("Category *")).toContainText(otherCategoryName)
    // Touch-tracking is per-field: only Category was manually picked, so
    // Merchant — never touched this session — still receives the matching
    // rule's suggestion. This is the other half of the contract: "don't
    // fight the user's choice" must not degrade into "stop suggesting
    // anything at all" for fields the user never actually decided on.
    await expect(page.getByLabel("Merchant (Optional)")).toContainText(
      merchantName
    )
  })
})
