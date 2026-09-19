import { expect, test } from "./support/fixtures"
import { createIdentity, onboard, waitForHydration } from "./support/onboarding"
import { seedFamilyInvite } from "./support/seed-invite"

// ADR-0057 — the invitee's whole journey through the real UI: open the emailed
// link, create an account through it (email locked to the invited address),
// and land inside the inviter's family without ever seeing "create your own
// family" onboarding. The emailed token is unreadable from a spec, so the
// invite row is seeded straight into the e2e database (see seed-invite.ts).

test.describe("family invitation (ADR-0057)", () => {
  test("a new person accepts by signing up through the invite link and lands in the family", async ({
    page,
    browser,
  }) => {
    const owner = await onboard(page)
    const invitee = createIdentity()
    const token = await seedFamilyInvite({
      inviterEmail: owner.email,
      inviteeEmail: invitee.email,
      role: "viewer",
    })

    const inviteeContext = await browser.newContext()
    const inviteePage = await inviteeContext.newPage()

    // Signed-out visitor is offered both paths (no account-existence oracle).
    await inviteePage.goto(`/invite/accept?token=${token}`)
    await waitForHydration(inviteePage)
    await expect(
      inviteePage.getByRole("link", { name: "Create your account" })
    ).toBeVisible()
    await expect(
      inviteePage.getByRole("link", { name: /I already have an account/ })
    ).toBeVisible()

    await inviteePage.getByRole("link", { name: "Create your account" }).click()
    await expect(inviteePage).toHaveURL(/\/signup\?inviteToken=/)
    await waitForHydration(inviteePage)

    // The invited address is prefilled and cannot be changed.
    const emailInput = inviteePage.getByLabel("Email")
    await expect(emailInput).toHaveValue(invitee.email)
    await expect(emailInput).toHaveAttribute("readonly", "")

    await inviteePage.getByLabel("Full Name").fill(invitee.fullName)
    await inviteePage.getByLabel("Username").fill(invitee.username)
    await inviteePage.getByLabel("Password").fill(invitee.password)
    await inviteePage.getByRole("button", { name: "Create Account" }).click()

    // Straight to the dashboard — the invite replaced "create your own family".
    await expect(inviteePage).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await inviteeContext.close()

    // The owner sees the new member, with the invited role, in their list.
    await page.goto("/settings/members")
    await waitForHydration(page)
    const row = page.getByRole("row", { name: new RegExp(invitee.email) })
    await expect(row).toBeVisible()
    await expect(row.getByRole("combobox")).toContainText("viewer")
  })

  test("an already-used invite link is reported as such", async ({
    page,
    browser,
  }) => {
    const owner = await onboard(page)
    const invitee = createIdentity()
    const token = await seedFamilyInvite({
      inviterEmail: owner.email,
      inviteeEmail: invitee.email,
    })

    const inviteeContext = await browser.newContext()
    const inviteePage = await inviteeContext.newPage()
    await inviteePage.goto(`/invite/accept?token=${token}`)
    await waitForHydration(inviteePage)
    await inviteePage.getByRole("link", { name: "Create your account" }).click()
    await waitForHydration(inviteePage)
    await inviteePage.getByLabel("Full Name").fill(invitee.fullName)
    await inviteePage.getByLabel("Username").fill(invitee.username)
    await inviteePage.getByLabel("Password").fill(invitee.password)
    await inviteePage.getByRole("button", { name: "Create Account" }).click()
    await expect(inviteePage).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await inviteeContext.close()

    // A brand-new visitor opening the same link now sees it is spent.
    const stranger = await browser.newContext()
    const strangerPage = await stranger.newPage()
    await strangerPage.goto(`/invite/accept?token=${token}`)
    await waitForHydration(strangerPage)
    await expect(
      strangerPage.getByText("This invitation has already been used.")
    ).toBeVisible()
    await stranger.close()
  })
})
