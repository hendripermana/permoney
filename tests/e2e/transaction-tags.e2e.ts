import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-145 — free-form Tags on a transaction. Tagging is EDIT-MODE ONLY (a
// brand-new transaction's id is a client-generated optimistic id the server
// hasn't created yet, so it can't be tagged until it round-trips) — this
// drives the real flow: create a transaction untagged, reopen it in edit
// mode, quick-create a brand-new tag via the picker, save, and assert the
// chip renders on the list row (proof the tag actually persisted through the
// real server fn -> Postgres path, not just client-side state).

test.describe("free-form tags on a transaction (PER-145)", () => {
  test("quick-creates a tag on an existing transaction and shows it on the row", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Tags Fixture")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/transactions")
    await waitForHydration(page)

    const uniqueSuffix = Date.now().toString(36)
    const description = `E2E tag target ${uniqueSuffix}`
    const categoryName = `E2E Tag Category ${uniqueSuffix}`
    const tagName = `E2E Trip ${uniqueSuffix}`

    // --- Create the transaction untagged (tagging isn't offered at create time) ---
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByLabel("Tags (Optional)")).toHaveCount(0)
    await page.getByLabel("Description *").fill(description)
    await page.getByLabel("Amount *").fill("25000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    await expect(page.getByLabel("Category *")).toContainText(categoryName)
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(description)).toBeVisible()

    // --- Reopen it in edit mode: the tag picker is now offered ---
    await page.getByRole("button", { name: "Edit Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByLabel("Tags (Optional)")).toBeVisible()

    await page.getByLabel("Tags (Optional)").click()
    await page.getByPlaceholder("Search or create a tag...").fill(tagName)
    await page.getByRole("option", { name: `Create "${tagName}"` }).click()
    // Close the popover (Escape) before asserting — while it's open, the
    // newly created tag's text is visible TWICE (the trigger's chip AND the
    // still-open option list showing it checked), which is a strict-mode
    // violation for an exact-text locator.
    await page.keyboard.press("Escape")
    // The chip renders in the picker's trigger area immediately (optimistic).
    await expect(
      page.getByRole("dialog").getByText(tagName, { exact: true })
    ).toBeVisible()

    await page.getByRole("button", { name: "Update Changes" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The persisted list row shows the tag chip — proves it round-tripped
    // through setTransactionTagsFn to real Postgres, not just client state.
    await expect(page.getByText(tagName, { exact: true })).toBeVisible()

    // --- Reopening again shows the tag pre-selected, and it can be removed ---
    await page.getByRole("button", { name: "Edit Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    const tagChipInDialog = page
      .getByRole("dialog")
      .getByText(tagName, { exact: true })
    await expect(tagChipInDialog).toBeVisible()
    await page.getByRole("button", { name: `Remove tag ${tagName}` }).click()
    await expect(tagChipInDialog).toHaveCount(0)
    await page.getByRole("button", { name: "Update Changes" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(tagName, { exact: true })).toHaveCount(0)
  })
})
