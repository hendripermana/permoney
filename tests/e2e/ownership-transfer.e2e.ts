import { expect, test } from "./support/fixtures"
import {
  onboard,
  signUpWithoutOnboarding,
  waitForHydration,
} from "./support/onboarding"
import { createServerFunctionMatcher } from "./support/server-fn-recorder"

// PER-271 — transferOwnershipFn (ADR-0036 §6) was fully implemented server
// side but no UI ever called it, and the owner role is deliberately excluded
// from the ordinary role Select specifically because ownership is supposed to
// move only through this dedicated flow. These specs drive the real UI end to
// end and prove the authorization boundary holds independently of it.

const transferOwnershipFnMatcher = createServerFunctionMatcher({
  exportName: "transferOwnershipFn",
  sourcePath: "src/server/family-members.ts",
})

interface CapturedTransferRequest {
  url: string
  method: string
  headers: Record<string, string>
  postData: string | null
}

test.describe("ownership transfer (PER-271)", () => {
  test("only the owner sees Transfer ownership, and a real transfer flips both roles in the UI", async ({
    page,
    browser,
  }) => {
    const owner = await onboard(page)

    // Sign the heir up in a SEPARATE browser context — signing up on the
    // owner's own `page` would replace the owner's session with the new
    // account's. The heir's own page is not needed again after this: the
    // owner performs every remaining action (add member, confirm transfer)
    // from their own, untouched `page`.
    const heirContext = await browser.newContext()
    const heir = await signUpWithoutOnboarding(await heirContext.newPage())
    await heirContext.close()

    // Add the second identity as a plain member of the owner's family.
    await page.goto("/settings/members")
    await waitForHydration(page)
    await page.getByLabel("Email").fill(heir.email)
    await page.getByRole("button", { name: "Add member" }).click()
    await expect(page.getByRole("table").getByText(heir.email)).toBeVisible()

    // Owner-only action is visible.
    const transferButton = page.getByRole("button", {
      name: "Transfer ownership",
    })
    await expect(transferButton).toBeVisible()
    await transferButton.click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toContainText(heir.fullName)
    await expect(dialog).toContainText(heir.email)
    await dialog.getByRole("button", { name: "Transfer ownership" }).click()

    // The list now shows the heir as owner and the original owner as admin
    // (a Select, not the owner Badge).
    await expect(
      page
        .getByRole("row", { name: new RegExp(heir.email) })
        .getByText("owner", { exact: true })
    ).toBeVisible()

    const ownerRow = page.getByRole("row", { name: new RegExp(owner.email) })
    await expect(ownerRow.getByText("owner", { exact: true })).toHaveCount(0)

    // The ex-owner (now admin) no longer sees the Transfer ownership action.
    await expect(
      page.getByRole("button", { name: "Transfer ownership" })
    ).toHaveCount(0)
  })

  test("a non-owner cannot transfer ownership via a direct server-fn call, bypassing the UI", async ({
    page,
    browser,
  }) => {
    const owner = await onboard(page)

    // A second, genuinely distinct authenticated session (its own cookie
    // jar) — the "attacker" who will attempt the direct call.
    const attackerContext = await browser.newContext()
    const attackerPage = await attackerContext.newPage()
    const attacker = await signUpWithoutOnboarding(attackerPage)

    // Owner adds the attacker as an admin — a fairly privileged non-owner
    // role, to prove even `member:manage` doesn't imply `ownership:transfer`.
    await page.goto("/settings/members")
    await waitForHydration(page)
    await page.getByLabel("Email").fill(attacker.email)
    await page.getByRole("combobox", { name: "Role" }).click()
    await page.getByRole("option", { name: "admin", exact: true }).click()
    await page.getByRole("button", { name: "Add member" }).click()
    await expect(
      page.getByRole("table").getByText(attacker.email)
    ).toBeVisible()

    // Capture the EXACT request the app itself sends for transferOwnershipFn
    // when the real owner uses the real UI, then abort it before it reaches
    // the server — this proves the replayed payload/shape below is genuine
    // (not a hand-guessed reconstruction of TanStack Start's RPC wire
    // format) while leaving the owner's family state untouched.
    const capturedRef: { current: CapturedTransferRequest | null } = {
      current: null,
    }
    await page.route(
      (url) => transferOwnershipFnMatcher.paths.has(url.pathname),
      async (route) => {
        const rawRequest = route.request()
        capturedRef.current = {
          url: rawRequest.url(),
          method: rawRequest.method(),
          headers: rawRequest.headers(),
          postData: rawRequest.postData(),
        }
        await route.abort()
      }
    )

    await page
      .getByRole("button", { name: "Transfer ownership" })
      .first()
      .click()
    const dialog = page.getByRole("alertdialog")
    await dialog.getByRole("button", { name: "Transfer ownership" }).click()

    await expect.poll(() => capturedRef.current).not.toBeNull()
    await page.unrouteAll()
    const request = capturedRef.current
    if (!request) throw new Error("expected a captured request")

    // Replay the SAME request, verbatim, from the attacker's own
    // authenticated (but non-owner) session. Only safe, non-forbidden
    // headers survive the round trip — `fetch` refuses to let script set
    // Cookie/Host/Content-Length itself, and the attacker's browser attaches
    // its own session cookie automatically for this same-origin call.
    const safeHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(([key]) =>
        ["content-type", "accept"].includes(key.toLowerCase())
      )
    )
    await attackerPage.goto("/dashboard")
    await waitForHydration(attackerPage)
    const replay = await attackerPage.evaluate(
      async ([url, method, headers, body]) => {
        const response = await fetch(url as string, {
          method: method as string,
          headers: headers as Record<string, string>,
          body: body as string | null,
          credentials: "same-origin",
        })
        return { status: response.status, ok: response.ok }
      },
      [request.url, request.method, safeHeaders, request.postData] as const
    )

    // The server rejects it independently of the UI hiding the button.
    expect(replay.ok).toBe(false)
    expect(replay.status).toBeGreaterThanOrEqual(400)

    // And nothing actually moved: reloading the roster shows the owner is
    // still the owner and the attacker is still merely an admin.
    await page.reload()
    await waitForHydration(page)
    const ownerRow = page.getByRole("row", { name: new RegExp(owner.email) })
    await expect(ownerRow.getByText("owner", { exact: true })).toBeVisible()
    const attackerRow = page.getByRole("row", {
      name: new RegExp(attacker.email),
    })
    await expect(attackerRow.getByText("owner", { exact: true })).toHaveCount(0)
  })
})
