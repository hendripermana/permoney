#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-no-use-effect.mjs — pre-commit / CI guard for the `no-use-effect`
 * convention (see `.agents/skills/no-use-effect/SKILL.md` and ADR-0002).
 *
 * WHY THIS EXISTS
 * ───────────────
 * `oxlint` ships `no-restricted-imports`, which we enable in `.oxlintrc.json`
 * to ban *named* imports of `useEffect` / `useLayoutEffect` from `"react"`.
 * That covers the `import { useEffect } from "react"` style.
 *
 * The codebase uses the **namespace** style (`import * as React from "react"`
 * + `React.useEffect(...)`), which `no-restricted-imports` cannot detect:
 * the rule operates on import specifiers, not member-access expressions.
 * So this script is the second half of the enforcement pair — it scans for
 * `React.useEffect(` and `React.useLayoutEffect(` and fails commits/CI when
 * unjustified call sites appear.
 *
 * CONTRACT
 * ────────
 * A call site is **justified** (i.e. allowed) iff one of the following is
 * true:
 *
 *   1. The contiguous comment block IMMEDIATELY preceding the call site
 *      contains the literal sentinel `no-use-effect skill exemption`.
 *      "Contiguous" means: starting from the line just above the call, we
 *      walk upward through comment lines (`//` or `/* ... *\u200b/`) and
 *      blank lines, and stop the moment we hit a line of real code. The
 *      sentinel must appear somewhere inside that walked block. This is
 *      the canonical phrasing used by the annotated sites today
 *      (`src/components/ui/calendar.tsx`, `src/routes/__root.tsx`,
 *      `src/routes/transactions.tsx`).
 *
 *   2. Or the call site lives inside `src/hooks/use-mount-effect.ts`
 *      itself — that file is the ONLY place `React.useEffect` is meant to
 *      be used directly, since it is the blessed escape hatch wrapper.
 *
 * Anything else is a violation; the script exits with code 1 and prints
 * file:line for each offender, plus a remediation hint.
 *
 * USAGE
 * ─────
 *   node scripts/check-no-use-effect.mjs           # scan src/, exit non-zero on violation
 *   node scripts/check-no-use-effect.mjs --quiet   # only print on failure
 *
 * Wired in two places:
 *   - `vite.config.ts` `staged` hook → runs on `git commit`.
 *   - `package.json` script `lint:no-use-effect` → runs in CI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const SCAN_ROOTS = ["src"]
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const ALLOWLIST_PATHS = new Set([
  // The escape-hatch wrapper itself is the only place the raw call is allowed
  // without a sentinel comment. It exists *to* call `React.useEffect`.
  "src/hooks/use-mount-effect.ts",
])
const SENTINEL = "no-use-effect skill exemption"
// Hard upper bound on how far we'll walk upward looking for a comment block.
// In practice the contiguous-comment walker stops at the first non-comment
// line, but this guards against pathological files (e.g. a single 5000-line
// banner comment) that would otherwise scan forever.
const MAX_WALK = 200
// Patterns we hunt for. We deliberately match `React.useEffect(` (note the
// open paren) so trivial mentions in strings/identifiers don't false-positive.
const VIOLATION_PATTERNS = [
  /\bReact\.useEffect\s*\(/,
  /\bReact\.useLayoutEffect\s*\(/,
]
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
      // Skip generated / vendored trees.
      if (entry === "node_modules" || entry === "dist" || entry === ".output")
        continue
      yield* walk(full)
    } else if (stat.isFile()) {
      const dot = entry.lastIndexOf(".")
      if (dot > -1 && SCAN_EXTS.has(entry.slice(dot))) yield full
    }
  }
}

/**
 * Decide whether a given line, viewed in isolation, is part of a "comment
 * block" — i.e. either blank or starts with `//` / `/*` / `*` (the third
 * is the body of a JSDoc-style block-comment continuation). We deliberately
 * accept blank lines so a justification block can be visually separated
 * from the call site by an empty line and still count as "immediately
 * preceding" it.
 */
function isCommentOrBlank(line) {
  const trimmed = line.trim()
  if (trimmed === "") return true
  if (trimmed.startsWith("//")) return true
  if (trimmed.startsWith("/*")) return true
  if (trimmed.startsWith("*")) return true
  if (trimmed.endsWith("*/")) return true
  return false
}

/**
 * Walk upward from `callLine` (exclusive) collecting the contiguous run of
 * comment-or-blank lines that immediately precedes it. Stops at the first
 * line of real code, or after MAX_WALK lines. Returns the joined text so
 * the caller can search it for the sentinel.
 */
function precedingCommentBlock(lines, callLine) {
  const collected = []
  let i = callLine - 1
  let walked = 0
  while (i >= 0 && walked < MAX_WALK) {
    if (!isCommentOrBlank(lines[i])) break
    collected.push(lines[i])
    i--
    walked++
  }
  return collected.join("\n")
}

/** Scan one file; return array of `{ line, snippet }` for unjustified hits. */
function scanFile(absPath) {
  const rel = relative(REPO_ROOT, absPath).replaceAll("\\", "/")
  if (ALLOWLIST_PATHS.has(rel)) return []

  const src = readFileSync(absPath, "utf8")
  const lines = src.split(/\r?\n/)
  const violations = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const matched = VIOLATION_PATTERNS.some((re) => re.test(line))
    if (!matched) continue

    const block = precedingCommentBlock(lines, i)
    if (block.includes(SENTINEL)) continue

    violations.push({ line: i + 1, snippet: line.trim() })
  }

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
      `\u001b[32m✓ no-use-effect: 0 unjustified \`React.useEffect\` sites in src/\u001b[0m`
    )
  }
  process.exit(0)
}

console.error(
  `\u001b[31m✗ no-use-effect: found ${allViolations.length} unjustified ` +
    `\`React.useEffect\` / \`React.useLayoutEffect\` site(s):\u001b[0m\n`
)
for (const v of allViolations) {
  console.error(`  ${v.file}:${v.line}`)
  console.error(`      ${v.snippet}`)
}
console.error(
  [
    ``,
    `Remediation (pick ONE):`,
    `  • Refactor per .agents/skills/no-use-effect/SKILL.md`,
    `      (derived state · data-fetching lib · event handler ·`,
    `       useMountEffect · key prop)`,
    `  • If genuinely outside the five rules, prepend a comment block`,
    `    containing the sentinel "${SENTINEL}"`,
    `    IMMEDIATELY above the call site (contiguous comment lines,`,
    `    blank lines OK), explaining why none of the five rules apply.`,
    ``,
    `See ADR-0002 (docs/adr/0002-lint-enforcement-no-use-effect.md) for`,
    `the full enforcement contract.`,
  ].join("\n")
)
process.exit(1)
