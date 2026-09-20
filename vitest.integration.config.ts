import { defineConfig } from "vite-plus"

// F1 audit S8.4 — this config is only ever loaded by a test run, so pin
// NODE_ENV unconditionally: integration tests must not inherit a caller's
// `NODE_ENV=production` (it changes module resolution and makes failures look
// like real defects). See the same guard in `vite.config.ts`.
if (process.env.NODE_ENV !== "test") {
  process.env.NODE_ENV = "test"
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["tests/integration/**/*.integration.ts"],
    pool: "forks",
    testTimeout: 120_000,
  },
})
