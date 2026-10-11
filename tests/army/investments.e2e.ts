import { test } from "@e2e-dev/web"
import { expect } from "e2e"
import {
  onboard,
  waitForHydration,
  type ArmyFixtures,
} from "./support/onboarding"
import { seedSellablePosition } from "./support/trade-fee-scenario"

// PER-230 — the Investments report route (/investments) in a real browser.
// src/lib/portfolio.test.ts owns the aggregation math and
// src/routes/_protected/-investments-ui.test.tsx owns the render contract;
// this file is only the routing + wiring proof that a component test cannot
// give: the sidebar entry resolves, the ssr:false route hydrates, the loader
// preloads the collections, and the page flips from the honest empty state to
// a populated report once an investment account exists.

test("a fresh household gets the honest empty state", async ({
  app,
  screen,
  browser,
}) => {
  const fx: ArmyFixtures = { app, screen, browser }
  await onboard(fx)

  await app.open("/investments")
  await waitForHydration(browser)

  await expect(screen.getByText("No investments yet")).toBeVisible()
  await expect(
    screen.getByRole("link", { name: /Add an investment account/ })
  ).toBeVisible()
  // No KPI can exist without an account.
  await expect(screen.getByText("Total market value")).toHaveCount(0)
})

test("the report populates once a tracked position exists", async ({
  app,
  screen,
  browser,
}) => {
  const fx: ArmyFixtures = { app, screen, browser }
  await onboard(fx)
  const names = await seedSellablePosition(fx, {
    suffix: Date.now().toString(36),
  })

  await browser.goto("/investments")
  await waitForHydration(browser)

  await expect(screen.getByText("No investments yet")).toHaveCount(0)
  // The seeded Tracked Asset shows up in the per-account table…
  await expect(screen.getByText("Per-account performance")).toBeVisible()
  await expect(
    screen.getByText(names.portfolioName, { exact: false }).first()
  ).toBeVisible()
  // …and the KPI row reports a real, base-currency market value.
  await expect(screen.getByText(/Total market value/).first()).toBeVisible()
  await expect(screen.getByText(/Rp\s[\d,.]+\.00/).first()).toBeVisible()
})
