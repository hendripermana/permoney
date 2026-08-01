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

    // --- The person is now settled: the "Settled" badge appears and the net is
    //     back to zero. (Both the badge and the net-zero position read
    //     "Settled", so scope to the first match.) ---
    await expect(page.getByText("Settled").first()).toBeVisible()
  })

  test("a person added with no debt still appears in the list as 'No debts yet'", async ({
    page,
  }) => {
    await onboard(page)

    const personName = `Nodebt ${Date.now().toString(36)}`

    await page.goto("/debts")
    await waitForHydration(page)

    // Add a contact WITHOUT recording any debt.
    await page.getByRole("button", { name: "Add person" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByLabel("Name").fill(personName)
    await page.getByRole("button", { name: "Add" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The person still shows, flagged as having no debts (PER-213).
    await expect(page.getByText(personName)).toBeVisible()
    await expect(page.getByText("No debts yet")).toBeVisible()
  })

  test("the repayment dialog only offers directions the person actually owes", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const cashName = `E2E Cash ${suffix}`
    const personName = `Budi ${suffix}`

    // Cash account.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(cashName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Lend to a brand-new person → they owe you (a receivable, no loan).
    await page.goto("/debts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "Record debt" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByLabel("New person name").fill(personName)
    await page.getByRole("combobox", { name: "Cash account" }).click()
    await page.getByRole("option", { name: `${cashName} (IDR)` }).click()
    await page.getByLabel(/^Amount/).fill("500000")
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Re-open, select that person, and inspect the Action options: only the
    // receivable repayment is offered (they owe you, you don't owe them).
    await page.getByRole("button", { name: "Record debt" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("combobox", { name: "Person" }).click()
    await page.getByRole("option", { name: personName }).click()
    await page.getByRole("combobox", { name: "Action" }).click()
    await expect(
      page.getByRole("option", {
        name: "Repayment received (they pay me back)",
      })
    ).toBeVisible()
    await expect(
      page.getByRole("option", { name: "Repayment made (I pay them back)" })
    ).toHaveCount(0)
  })
})
