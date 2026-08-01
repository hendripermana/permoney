import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-212 / ADR-0049 — person-to-person debt (Utang-Piutang) end-to-end.
// Onboard → create a cash account → record a LEND to a brand-new person →
// assert it shows in Utang-Piutang with the right net position AND on the
// net-worth card as the grouped "Personal debts (net)" line (never in the main
// Accounts list) → record the repayment → assert the person is settled (Lunas).

test.describe("person-to-person debt (PER-212)", () => {
  test("lend to a new person, see it in Utang-Piutang + net-worth aggregate, then settle", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const cashName = `E2E Cash ${suffix}`
    const personName = `Budi ${suffix}`

    // --- Create the cash account (default cash-like type) ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(cashName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Record a lend to a brand-new person ---
    await page.goto("/debts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "Record debt" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // Person defaults to "+ New person"; just name them.
    await page.getByLabel("New person name").fill(personName)
    // Action defaults to "Lend (they will owe me)".
    await page.getByRole("combobox", { name: "Cash account" }).click()
    await page.getByRole("option", { name: `${cashName} (IDR)` }).click()
    await page.getByLabel(/^Amount/).fill("500000")
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Utang-Piutang shows the person with the right net position ---
    await expect(page.getByText(personName)).toBeVisible()
    await expect(page.getByText("They owe you")).toBeVisible()
    await expect(page.getByText("Rp 500,000.00")).toBeVisible()

    // --- Net-worth card: the grouped "Personal debts (net)" line appears, the
    //     receivable stays OUT of the main Accounts list, and the TOTAL is
    //     unchanged (2,000,000: 1,500,000 cash + 500,000 receivable). ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText("Personal debts (net)")).toBeVisible()
    await expect(page.getByText("Rp 2,000,000.00")).toBeVisible()
    await expect(page.getByText(`Owed by ${personName}`)).toHaveCount(0)

    // --- Record the repayment (they pay you back in full) ---
    await page.goto("/debts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "Record debt" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByRole("combobox", { name: "Person" }).click()
    await page.getByRole("option", { name: personName }).click()
    await page.getByRole("combobox", { name: "Action" }).click()
    await page
      .getByRole("option", { name: "Repayment received (they pay me back)" })
      .click()
    await page.getByRole("combobox", { name: "Cash account" }).click()
    await page.getByRole("option", { name: `${cashName} (IDR)` }).click()
    await page.getByLabel(/^Amount/).fill("500000")
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- The person is now settled: Lunas badge, net back to zero ---
    await expect(page.getByText("Lunas")).toBeVisible()
    await expect(page.getByText("Settled")).toBeVisible()
  })
})
