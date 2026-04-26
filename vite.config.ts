import { defineConfig } from "vite-plus"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"

const config = defineConfig({
  staged: {
    // Pre-commit dispatcher. Vite+ `staged` values run as a single argv
    // array (no shell), so chaining via `&&` is not possible — flags land
    // on the first command. `scripts/staged-check.mjs` is a 30-line Node
    // script that spawns the two real steps in order:
    //   1. `vp check --fix` — fmt + lint + typecheck (auto-fix where safe).
    //   2. `node scripts/check-no-use-effect.mjs` — enforce ADR-0002:
    //      ban `React.useEffect(...)` without the `no-use-effect skill
    //      exemption` sentinel comment block. `vp lint`'s built-in
    //      `no-restricted-imports` rule already blocks the named-import
    //      style; this guard covers the namespace style (`React.useEffect`)
    //      which the lint rule cannot detect.
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
    tanstackStart(),
    nitro(),
    viteReact(),
    tailwindcss(),
    devtools({ injectSource: { enabled: false } }),
  ],
})

export default config
