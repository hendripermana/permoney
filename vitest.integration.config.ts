import { defineConfig } from "vite-plus"

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
