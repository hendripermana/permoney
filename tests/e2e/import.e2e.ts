import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-151 — the CSV import wizard drives the real browser → server-fn → staging
// → promotion path that the integration suite (PER-82) exercises headlessly.
// This proves the wizard actually stages a parsed CSV, previews it, and promotes
// confirmed rows into the canonical ledger so they show up on /transactions.

const IMPORT_CSV = [
  "Date,Description,Amount",
  "2026-01-15,E2E CSV Coffee,-15000",
  "2026-01-16,E2E CSV Salary,2500000",
  "",
].join("\n")

test.describe("CSV import wizard", () => {
  test("enable imports on an account, then upload → preview → promote", async ({
    page,
  }) => {
    await onboard(page)

    // 1. Mark the starter account importable (the promotion gate, ADR-0039 §6).
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "Edit account" }).first().click()
    await page.getByLabel("Allow imports").click()
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // 2. Open the wizard and upload a generic CSV (preset defaults match it).
    await page.goto("/import")
    await waitForHydration(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: "statement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(IMPORT_CSV),
    })

    // 3. Map step: choose the target account; the client preview should resolve.
    await page
      .getByRole("combobox")
      .filter({ hasText: "Select account" })
      .click()
    await page.getByRole("option", { name: /Everyday Cash/ }).click()
    await expect(page.getByText("2 ready", { exact: false })).toBeVisible()

    await page.getByRole("button", { name: /Stage & preview/ }).click()

    // 4. Preview step: both rows confirmed by default → promote.
    await expect(page.getByText("Review & promote")).toBeVisible()
    await page.getByRole("button", { name: /Promote 2 confirmed/ }).click()

    // 5. Promotion lands the rows in the canonical ledger.
    await expect(page).toHaveURL(/\/transactions(?:\?.*)?$/)
    await waitForHydration(page)
    await expect(page.getByText("E2E CSV Coffee")).toBeVisible()
    await expect(page.getByText("E2E CSV Salary")).toBeVisible()
  })
})
