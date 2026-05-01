#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-no-use-effect.mjs — pre-commit / CI guard for the `no-use-effect`
 * convention (see `.agents/skills/no-use-effect/SKILL.md` and ADR-0002).
 *
 * This file is a thin **CLI shim**: it walks `src/`, reads each interesting
 * file, hands the contents to the pure detector in
 * `./check-no-use-effect.detector.mjs`, and aggregates results. All the
 * actual policy lives in the detector module so it can be unit-tested
 * (see `./check-no-use-effect.test.mjs`).
 *
 * USAGE
 *   node scripts/check-no-use-effect.mjs           # exit non-zero on violation
 *   node scripts/check-no-use-effect.mjs --quiet   # only print on failure
 *
 * Wired in:
 *   - `vite.config.ts` `staged` hook (via `scripts/staged-check.mjs`).
 *   - `package.json` script `lint:no-use-effect` (CI / ad-hoc).
 *   - `package.json` script `check` (combined fmt+lint+typecheck+guard).
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { scanText } from "./check-no-use-effect.detector.mjs"

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const SCAN_ROOTS = ["src"]
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const SKIP_DIRS = new Set(["node_modules", "dist", ".output", ".vinxi"])
const ALLOWLIST_PATHS = new Set([
  // The escape-hatch wrapper itself is the only place the raw call is allowed
  // without a sentinel comment. It exists *to* call `React.useEffect`.
  "src/hooks/use-mount-effect.ts",
])
// ──────────────────────────────────────────────────────────────────────────

const QUIET = process.argv.includes("--quiet")

/** Recursively yield every file under `dir` whose extension is interesting. */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      yield* walk(full)
    } else if (stat.isFile()) {
      const dot = entry.lastIndexOf(".")
      if (dot > -1 && SCAN_EXTS.has(entry.slice(dot))) yield full
    }
  }
}

/** Scan one file → array of `{ file, line, snippet, kind }` violations. */
function scanFile(absPath) {
  const rel = relative(REPO_ROOT, absPath).replaceAll("\\", "/")
  const isAllowlisted = ALLOWLIST_PATHS.has(rel)
  const src = readFileSync(absPath, "utf8")
  const violations = scanText(src, { isAllowlisted })
  return violations.map((v) => ({ file: rel, ...v }))
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
const allViolations = []
for (const root of SCAN_ROOTS) {
  const abs = join(REPO_ROOT, root)
  for (const file of walk(abs)) {
    allViolations.push(...scanFile(file))
  }
}

if (allViolations.length === 0) {
  if (!QUIET) {
    console.log(
      `\u001b[32m✓ no-use-effect: 0 violations in src/ (named imports + unjustified call sites)\u001b[0m`
    )
  }
  process.exit(0)
}

const namedCount = allViolations.filter((v) => v.kind === "named-import").length
const callCount = allViolations.filter((v) => v.kind === "call-site").length
console.error(
  `\u001b[31m✗ no-use-effect: found ${allViolations.length} violation(s) ` +
    `(${namedCount} banned named import(s), ${callCount} unjustified call site(s)):\u001b[0m\n`
)
for (const v of allViolations) {
  const label = v.kind === "named-import" ? "named-import" : "call-site"
  console.error(`  [${label}] ${v.file}:${v.line}`)
  console.error(`      ${v.snippet}`)
}
console.error(
  [
    ``,
    `Remediation:`,
    `  • For named-import violations: switch to the namespace style`,
    `      \`import * as React from "react"\` and use the API as`,
    `      \`React.useEffect(...)\` (then apply the rules below).`,
    `  • For call-site violations: refactor per`,
    `      .agents/skills/no-use-effect/SKILL.md (derived state ·`,
    `      data-fetching lib · event handler · useMountEffect · key prop).`,
    `  • If genuinely outside the five rules, prepend a comment block`,
    `    containing the sentinel "no-use-effect skill exemption"`,
    `    IMMEDIATELY above the call site (contiguous comment lines,`,
    `    blank lines OK), explaining why none of the five rules apply.`,
    ``,
    `See ADR-0002 (docs/adr/0002-lint-enforcement-no-use-effect.md) for`,
    `the full enforcement contract and threat model.`,
  ].join("\n")
)
process.exit(1)
