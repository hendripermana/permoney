import { defineConfig } from "vite-plus"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"

const isTestRuntime =
  process.env.VITEST === "true" || process.env.NODE_ENV === "test"

const tanstackHeadScriptsShim = {
  name: "tanstack-start-injected-head-scripts-shim",
  sharedDuringBuild: true,
  resolveId: {
    filter: {
      id: /^tanstack-start-injected-head-scripts:v$/,
    },
    handler(id: string) {
      return `\0${id}`
    },
  },
  load: {
    filter: {
      // eslint-disable-next-line no-control-regex -- \0 is Vite virtual module convention
      id: /^\0tanstack-start-injected-head-scripts:v$/,
    },
    handler(_id: string) {
      return "export const injectedHeadScripts = undefined"
    },
  },
}

const config = defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      ".agents/**",
      ".claude/**",
      ".factory/**",
      ".forge/**",
      ".junie/**",
      ".kilo/**",
      ".kilocode/**",
      ".kiro/**",
      ".trae/**",
      ".windsurf/**",
      "tests/e2e/**",
      "tests/integration/**",
    ],
    include: ["scripts/**/*.test.mjs", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },

  staged: {
    // Pre-commit dispatcher. Vite+ `staged` values run as a single argv
    // array (no shell), so chaining via `&&` is not possible — flags land
    // on the first command. `scripts/staged-check.mjs` is a 30-line Node
    // script that spawns the two real steps in order:
    //   1. `vp check --fix` — fmt + lint + typecheck (auto-fix where safe).
    //   2. `node scripts/check-no-use-effect.mjs` — enforce ADR-0002.
    //      As of the 2026-04-30 amendment, this single guard catches BOTH
    //      forms: banned named imports (`import { useEffect } from
    //      "react"`) AND unjustified `React.useEffect(...)` call sites.
    //      The `oxlint` `no-restricted-imports` rule that previously
    //      handled the named-import case was removed because its
    //      spec-strict LSP build also flagged the project's namespace
    //      style; see ADR-0002 amendment for the full rationale. The
    //      detector lives in `scripts/check-no-use-effect.detector.mjs`
    //      (pure functions, unit-tested by `…detector.test.mjs`) and is
    //      invoked by this thin CLI shim.
    "*": "node scripts/staged-check.mjs",
  },

  lint: {
    options: { typeAware: true, typeCheck: true },
    // =========================================================
    // TAMBAHKAN BAGIAN INI
    ignorePatterns: [
      "dist/**",
      "src/routeTree.gen.ts", // <-- Ini dia penjaga perdamaiannya
      // One-shot data-conversion script (.mjs, no TS types) — lint type
      // inference produces false positives on Object.entries destructures.
      // Script is idempotent and not part of the runtime bundle.
      "scripts/**",
    ],
    // =========================================================
  },

  fmt: {
    endOfLine: "lf",
    semi: false,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "es5",
    printWidth: 80,
    sortTailwindcss: {
      stylesheet: "src/styles.css",
      functions: ["cn", "cva"],
    },
    sortPackageJson: false,
    ignorePatterns: [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "src/routeTree.gen.ts",
    ],
  },
  resolve: {
    tsconfigPaths: true, // Ini adalah fitur bawaan Vite+ yang baru
  },

  // =========================================================
  // NOTE on `devtools({ injectSource: { enabled: false } })`:
  //   The TanStack devtools-vite plugin annotates every JSX node with a
  //   `data-tsd-source="/path/to/file.tsx:LINE:COL"` attribute so its
  //   in-page inspector can jump-to-source. In our setup that attribute
  //   leaks into the SSR-cached payload but drifts on every client edit
  //   (because Vite HMR picks up the new line numbers immediately while
  //   the SSR module remains cached for the active request). Result:
  //   React 19's hydration reconciler reports a mismatch on EVERY edited
  //   route until the dev server is restarted. We never use the in-page
  //   inspector, so disabling injection is a free win — devtools UI and
  //   enhanced logs continue to work.
  plugins: [
    ...(!isTestRuntime
      ? [
          tanstackStart({
            importProtection: {
              ignoreImporters: [
                // Server-fn helper files: their .server.* imports live only inside
                // createServerFn/createMiddleware handler bodies which are code-split
                // to the server bundle by TanStack Start. Static analysis would flag
                // them, but at runtime these imports never execute in the client.
                "src/server/middleware/with-family.ts",
                "src/server/middleware/rate-limit.ts",
                "src/server/middleware/session.ts",
                "src/server/transactions.ts",
                "src/server/smart-rules.ts",
                "src/server/auth-fns.ts",
                "src/routes/api/auth/$.ts",
              ],
            },
          }),
          // Shim for tanstack-start-injected-head-scripts:v virtual module.
          // start-plugin-core registers this module only for consumer==="server"
          // environments. When Vite's vite:import-analysis processes router-manifest.js
          // in the client environment it can't resolve the specifier and throws.
          // This fallback plugin catches any environment the server plugin doesn't cover.
          // Uses Vite 6 filter/handler API to match devServerPlugin's pattern.
          tanstackHeadScriptsShim,
          nitro(),
          tailwindcss(),
          devtools({ injectSource: { enabled: false } }),
        ]
      : []),
    viteReact(),
  ],
})

export default config
