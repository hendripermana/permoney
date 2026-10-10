import { randomUUID } from "node:crypto"
import type { App, Screen } from "e2e"
import { expect } from "e2e"
import type { Browser } from "@e2e-dev/web"

// Army lane (tester-army e2e runner) onboarding helpers — the deterministic
// port of tests/e2e/support/onboarding.ts (Playwright). Same flows, same
// locators; only the harness surface differs: `app`/`screen`/`browser`
// fixtures instead of `Page`, and exact-by-default text matching (every
// locator below is pinned to a source-verified label or carries `exact:
// false` to inherit the Playwright suite's proven substring semantics).

export interface ArmyFixtures {
  app: App
  screen: Screen
  browser: Browser
}

export interface Identity {
  email: string
  fullName: string
  password: string
  username: string
}

export function createIdentity(): Identity {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const password = randomUUID().replaceAll("-", "")
  return {
    email: `e2e-${suffix}@permoney.test`,
    fullName: `E2E User ${suffix}`,
    password: `${password.slice(0, 12)}A1a`,
    username: `e2e_${suffix}`,
  }
}

/**
 * Wait for client hydration. `__root.tsx` sets
 * `<html data-permoney-hydrated="true">` once the root mounts (and deletes it
 * on unmount). Clicks before hydration land on a server-rendered page with no
 * handlers attached, so every navigation that ends an SSR document needs this.
 * A document-level attribute has no accessible role — a CSS selector is the
 * honest tool here, the same fact Playwright specs read via waitForFunction.
 */
export async function waitForHydration(browser: Browser): Promise<void> {
  await browser
    .locator('html[data-permoney-hydrated="true"]')
    .waitFor({ state: "attached" })
}

/**
 * Sign up a fresh user and complete onboarding, ending on /dashboard.
 * Every test gets its own family (random identity → empty ledger), which is
 * what lets the six fee cases run serially against one shared dev server
 * without ever colliding.
 */
export async function onboard(fixtures: ArmyFixtures): Promise<Identity> {
  const { app, screen, browser } = fixtures
  const identity = createIdentity()

  await app.open("/signup")
  await waitForHydration(browser)
  await screen.getByLabel("Full Name").fill(identity.fullName)
  await screen.getByLabel("Username").fill(identity.username)
  await screen.getByLabel("Email").fill(identity.email)
  await screen.getByLabel("Password").fill(identity.password)
  await screen.getByRole("button", "Create Account").click()
  await expect(browser).toHaveURL(/\/onboarding(?:\?.*)?$/)

  await waitForHydration(browser)
  // F1 audit B2: confirm the one-way base-currency door before Get Started —
  // a hidden checkbox would silently skip it, so the click doubles as proof.
  await screen
    .getByRole("checkbox", { name: /reports will always be in/i })
    .click()
  await screen.getByRole("button", "Get Started").click()
  await expect(browser).toHaveURL(/\/dashboard(?:\?.*)?$/)

  await waitForHydration(browser)
  return identity
}
