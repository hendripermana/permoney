import { test } from "@e2e-dev/web"
import { expect } from "e2e"

// Rig self-check — NOT one of the six contracted fee cases. The army lane's
// cheapest possible proof that the runner boots the harness, starts the dev
// server on :3011, and drives a browser: a red smoke localizes the problem
// to the rig itself, a green smoke points at the fee specs.
test("the army rig serves the app to a real browser", async ({
  app,
  browser,
}) => {
  await app.open("/")
  await expect(browser.locator("body")).toBeVisible()
})
