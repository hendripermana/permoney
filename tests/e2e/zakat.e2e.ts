import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-263 / ADR-0056 — Zakat Maal golden path in a real browser. The feature is
// opt-in and off by default; enabling it and anchoring the Hawl clock produces a
// computed result (or the honest "price not available" state), and a household
// payer can be added alongside the implicit "Saya" payer.

test.describe("zakat golden path", () => {
  test("is off by default, then computes after enabling with a Hawl start date and a payer", async ({
    page,
  }) => {
    await onboard(page)

    // 1. Opt-in default: the calculator explains the state instead of guessing.
    await page.goto("/zakat")
    await waitForHydration(page)
    await expect(
      page.getByRole("heading", { name: "Zakat Maal" })
    ).toBeVisible()
    await expect(page.getByText("Zakat is turned off")).toBeVisible()

    // 2. Enable it in settings, anchor the Hawl clock, add a second payer.
    await page.goto("/settings/zakat")
    await waitForHydration(page)
    await page.getByRole("switch", { name: "Enable Zakat calculator" }).click()
    await page
      .getByRole("button", { name: "Not sure? Start counting from today" })
      .click()
    await expect(page.locator("#hawl-start-date")).not.toHaveValue("")

    await page
      .getByLabel(/Or add someone who isn't on Permoney yet/)
      .fill("Istri")
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await expect(page.getByText("Istri").first()).toBeVisible()

    await page.getByRole("button", { name: "Save settings" }).click()
    await expect(page.getByText("Zakat settings saved.")).toBeVisible()

    // 3. The calculator now either computes or says why it cannot yet — it never
    //    falls back to the disabled prompt, and the Hawl anchor survived the save.
    await page.goto("/zakat")
    await waitForHydration(page)
    await expect(page.getByText("Zakat is turned off")).toHaveCount(0)
    await expect(page.getByText("Set a Hawl start date first")).toHaveCount(0)
    await expect(
      page
        .getByText(/Using: (gold|silver) nisab/)
        .or(page.getByText("Price not available yet"))
    ).toBeVisible()
  })
})
