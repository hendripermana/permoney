import { defineConfig } from "vite-plus"

export default defineConfig({
  test: {
    hookTimeout: 120_000,
    include: ["tests/e2e/**/*.e2e.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
  },
})
