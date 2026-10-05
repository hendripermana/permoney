import type { E2EConfig } from "e2e"
import { web } from "@e2e-dev/web"

// tester-army e2e lane — the deterministic second test lane beside the
// Playwright suite (tests/e2e, port 3010). Contract for this lane:
//
//   - tests live ONLY under tests/army/ via a dedicated glob: this runner
//     must never select tests/e2e/** — those are Playwright specs with a
//     different API (a second engine's loader would fail them as syntax it
//     does not own).
//   - app served on port 3011, started by the SAME harness the Playwright
//     lane uses (tests/e2e/support/start-e2e-server.ts): each run creates a
//     fresh test_* Postgres database, so this lane never shares state with
//     the Playwright lane's database. Do NOT run both lanes at the same time
//     on one machine — both servers write .playwright/permoney-e2e-state.json
//     (the shared harness state file). CI jobs run on separate VMs, so
//     parallel lanes there are safe.
//   - deterministic only: no `agents` block, no model keys, no `agent.*`
//     steps. The Playwright CI lane stays untouched as the backbone.
//
// The runner child process inherits ONLY PATH/HOME/temp variables plus
// `command.env`, so every variable the harness needs must be forwarded here
// explicitly (never DATABASE_URL/NODE_ENV — the harness sets its own).

const ARMY_PORT = 3011

export default {
  tests: ["tests/army/**/*.e2e.ts"],
  // One worker in every environment: the app under test is a single dev
  // server with one shared connection pool, and matching CI's worker count
  // locally keeps runs reproducible (the Playwright lane runs serial too).
  workers: 1,
  targets: [
    {
      name: "army",
      engine: web({
        // Mirrors playwright.config.ts: money/date rendering must not drift
        // between lanes.
        locale: "en-US",
        timezoneId: "UTC",
      }),
      app: {
        url: `http://127.0.0.1:${ARMY_PORT}`,
        command: {
          executable: "vp",
          args: ["exec", "tsx", "tests/e2e/support/start-e2e-server.ts"],
          env: {
            PERMONEY_E2E_PORT: String(ARMY_PORT),
            PERMONEY_TEST_ADMIN_DATABASE_URL:
              process.env.PERMONEY_TEST_ADMIN_DATABASE_URL ??
              "postgres://permoney@localhost:5433/postgres",
            PERMONEY_TEST_ADMIN_PASSWORD:
              process.env.PERMONEY_TEST_ADMIN_PASSWORD ?? "",
          },
          // Harness (test DB + migrations) + cold Vite dev boot can exceed
          // the 60s default on first run; matches the Playwright lane's
          // 120s webServer timeout.
          startupTimeout: 120_000,
          log: ".e2e/logs/army-server.log",
        },
      },
    },
  ],
} satisfies E2EConfig
