import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-232 / ADR-0051 — Holdings UI (Slice 1, market-priced).
// Onboard → create a TRACKED_ASSET (valuation-tracked) account → open its
// detail → add a Metal holding (2 gram, avg cost 1,000,000, last price
// 1,200,000). Assert the holding row shows current value Rp 2,400,000, cost
// Rp 2,000,000, and a +Rp 400,000 gain, and that the account hero balance
// re-materializes from the holdings anchor to Rp 2,400,000.
//
// \s (not literal spaces) throughout — formatCurrency uses a non-breaking
// space between the symbol and the number.

test.describe("holdings UI (PER-232)", () => {
  test("add a holding on a tracked account → value/cost/gain + hero update", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const name = `Portfolio ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(name)
    // Tracked Asset ⇒ balanceSource="valuation", the only kind holdings attach to.
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${name}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // Holdings panel renders with its empty state for a fresh tracked account.
    // Scoped to the heading role — plain getByText("Holdings") case-insensitively
    // substring-matches the empty-state copy too ("No holdings yet…"), which is
    // a strict-mode violation once both are on screen together.
    await expect(page.getByRole("heading", { name: "Holdings" })).toBeVisible()
    await expect(page.getByText(/No holdings yet/i)).toBeVisible()

    // --- Add a holding ---
    await page.getByRole("button", { name: "Add holding" }).click()
    const dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Add holding" })
    ).toBeVisible()
    await dialog.getByLabel("Instrument name").fill("Gold")
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Metal" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByLabel(/Last price/i).fill("1200000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Holding row: value = 2 × 1,200,000 = 2,400,000; cost = 2 × 1,000,000
    //     = 2,000,000; gain = +400,000 (+20%). ---
    await expect(page.getByText("Gold").first()).toBeVisible()
    await expect(page.getByText(/Rp\s2,400,000\.00/).first()).toBeVisible()
    await expect(page.getByText(/Rp\s2,000,000\.00/).first()).toBeVisible()
    await expect(page.getByText(/\+Rp\s400,000\.00/).first()).toBeVisible()

    // --- The account hero balance re-materialized from the holdings anchor:
    //     Σ holdings' value = 2,400,000. The value now appears in MORE than the
    //     single holding row (the holding value, the Total, AND the account hero
    //     balance), proving the anchor propagated to the account view — a
    //     `.first()` match would only re-check the holding row. ---
    expect(
      await page.getByText(/Rp\s2,400,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)
  })

  // Real production bug: an Indonesian user typed the Bibit unit count "1.354"
  // (dot = thousands separator) and the strict dot-decimal parser silently
  // stored 1.354 units — 1000x wrong. The quantity field must now refuse to
  // guess: show both readings, block Save, and only submit the chosen one.
  test("ambiguous quantity 1.354 asks which reading, then saves 1,354 units", async ({
    page,
  }) => {
    await onboard(page)

    const name = `Reksadana ${Date.now().toString(36)}`
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(name)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.getByRole("button", { name: `Open ${name}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    await page.getByRole("button", { name: "Add holding" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill("Fund")
    await dialog.getByLabel(/Average unit cost/i).fill("1000")
    await dialog.getByLabel(/Last price/i).fill("1000")

    // Ambiguous: both readings offered, Save blocked.
    await dialog.getByLabel("Quantity").fill("1.354")
    const choices = dialog.getByRole("group", {
      name: "Which reading did you mean",
    })
    await expect(choices).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: "Add holding" })
    ).toBeDisabled()

    // Pick the thousands reading (the Indonesian meaning of "1.354").
    await choices
      .getByRole("button", { name: /one thousand three hundred fifty-four/ })
      .click()
    await expect(dialog.getByText(/Read as: 1,354 units/)).toBeVisible()
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // 1,354 units × Rp 1,000 = Rp 1,354,000 (NOT 1.354 units = Rp 1,354).
    await expect(page.getByText(/Rp\s1,354,000\.00/).first()).toBeVisible()
  })
})
