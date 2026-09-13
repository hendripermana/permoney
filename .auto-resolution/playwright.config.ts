import { defineConfig, devices } from "@playwright/test"

const e2ePort = Number(process.env.PERMONEY_E2E_PORT ?? 3010)
const configuredBaseUrl = process.env.PERMONEY_E2E_BASE_URL
const baseURL = configuredBaseUrl ?? `http://127.0.0.1:${e2ePort}`

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "on-first-retry",
  },
  ...(configuredBaseUrl
    ? {}
    : {
        webServer: {
          command: `PERMONEY_E2E_PORT=${e2ePort} vp exec tsx tests/e2e/support/start-e2e-server.ts`,
          url: `${baseURL}/login`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
})
