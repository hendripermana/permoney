import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-227 — the in-app insights digest (/digest). Drives the real path
// (browser -> server-fn -> react-query -> render) for a freshly onboarded
// family: the engine has no recorded history to fold, so EVERY derivation
// deliberately skips — the digest must show those reasons instead of a blank
// page (ADR-0059: "tell 'nothing to say' from 'failed'"), and the month
// header must render the month the SERVER resolved (family-tz current month),
// never a client-side guess.

test.describe("digest route", () => {
  test("an onboarded family sees the month header and the engine's honest skip reasons", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/digest")
    await waitForHydration(page)

    // The month picker shows a concrete YYYY-MM — the server-resolved month
    // the figures on screen describe (URL had no ?month=). `exact` so the
    // "Previous/Next month" nav buttons' aria-labels don't collide.
    const monthInput = page.getByLabel("Month", { exact: true })
    await expect(monthInput).toBeVisible()
    await expect(monthInput).toHaveValue(/^\d{4}-\d{2}$/)

    // A fresh family: every derivation skips with its own reason, and the
    // digest renders them — never a blank page, never a failure indicator.
    await expect(page.getByTestId("digest-skipped-section")).toBeVisible()
    await expect(page.getByText("savings flow")).toBeVisible()
    await expect(page.getByText("no transfers in the window")).toBeVisible()
    await expect(page.getByTestId("digest-failed")).toHaveCount(0)

    // Prev is URL-driven state: it writes ?month= into the URL (shareable),
    // and the Next button stays enabled one month before the current month.
    await page.getByRole("button", { name: "Previous month" }).click()
    await expect(page).toHaveURL(/month=\d{4}-\d{2}/)
    await expect(monthInput).toHaveValue(/^\d{4}-\d{2}$/)

    // Not stuck loading / not errored.
    await expect(page.getByText(/Couldn't load/)).toHaveCount(0)
  })
})
