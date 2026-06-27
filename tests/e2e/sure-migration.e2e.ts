import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"
import { buildSureBundleV2Complete } from "../integration/support/sure-fixtures"

// PER-171 / ADR-0041 §11 — the guided Sure importer drives the real browser →
// runSureMigrationFn → staging → promotion path against the SAME synthetic v2
// bundle the integration suite (PER-170) promotes headlessly. It proves the
// preview surfaces created vs held HONESTLY, the confirm promotes the standard
// rows into the canonical ledger, and re-running the identical bundle is
// idempotent (replayed, zero duplicates) rather than an error.

const bundle = buildSureBundleV2Complete()

test.describe("Sure guided migration", () => {
  test("upload → honest preview → promote → idempotent re-run", async ({
    page,
  }) => {
    await onboard(page)

    // 1. The CSV import page links to the guided Sure importer (entry point).
    await page.goto("/import")
    await waitForHydration(page)
    await page.getByRole("link", { name: /Coming from Sure/ }).click()
    await expect(page).toHaveURL(/\/import\/sure$/)

    // 2. Upload the synthetic all.ndjson on a fresh load so the file-input change
    // handler is wired before Playwright sets files programmatically.
    await page.goto("/import/sure")
    await waitForHydration(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: "all.ndjson",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(bundle.ndjson),
    })

    // 3. Preview honestly splits crossing-now from held, with the gap note.
    await expect(page.getByText("Crossing into your ledger")).toBeVisible()
    await expect(page.getByText("Held for a later step")).toBeVisible()
    await expect(page.getByText("Transfers", { exact: true })).toBeVisible()
    await expect(page.getByText(/A few balances won't match yet/)).toBeVisible()

    // 4. Confirm: only the 2 promotable standard rows import.
    await page.getByRole("button", { name: /Import 2 transactions/ }).click()

    // 5. Done screen reports the authoritative result and a manual navigate.
    await expect(page.getByText("Migration complete")).toBeVisible()
    await page.getByRole("button", { name: /View transactions/ }).click()

    await expect(page).toHaveURL(/\/transactions(?:\?.*)?$/)
    await waitForHydration(page)
    await expect(page.getByText("Lumpia beef")).toBeVisible()
    await expect(page.getByText("June salary")).toBeVisible()

    // 6. Re-run the identical bundle — idempotent, nothing duplicated.
    await page.goto("/import/sure")
    await waitForHydration(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: "all.ndjson",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(bundle.ndjson),
    })
    await page.getByRole("button", { name: /Import 2 transactions/ }).click()
    await expect(page.getByText("Already imported")).toBeVisible()

    // The ledger still holds exactly one of each promoted row (no duplicate).
    await page.goto("/transactions")
    await waitForHydration(page)
    await expect(page.getByText("Lumpia beef")).toHaveCount(1)
  })
})
