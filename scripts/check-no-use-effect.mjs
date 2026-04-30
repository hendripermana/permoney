#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-no-use-effect.mjs — pre-commit / CI guard for the `no-use-effect`
 * convention (see `.agents/skills/no-use-effect/SKILL.md` and ADR-0002).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Originally this script was the *second half* of an enforcement pair, the
 * first half being an `oxlint` `no-restricted-imports` rule banning named
 * imports of `useEffect`/`useLayoutEffect` from `"react"`. That oxlint rule
 * was removed because, per the ESLint spec it implements, `importNames`
 * also flags namespace imports (`import * as React from "react"`) on the
 * grounds that the namespace technically grants access to the restricted
 * names. The codebase deliberately uses the namespace style in 38 files —
 * so the rule produced 38 false-positive squiggles in IDEs running an LSP
 * version of oxlint that follows the spec strictly. (Oxlint CLI 1.62.0 did
 * not flag those yet; future versions almost certainly will.) Rather than
 * tolerate creeping IDE noise that would eventually become a CLI break, we
 * consolidated all enforcement into THIS script, which has full access to
 * file context and can correctly distinguish the two import styles.
 *
 * WHAT THIS SCRIPT DETECTS
 * ────────────────────────
 *   (A) Named imports — `import { useEffect [as x], useLayoutEffect } from
 *       "react"` (single- or multi-line). Always a violation. No exemption
 *       sentinel is honored for these — if you genuinely need to bypass,
 *       rewrite as namespace + sentinel-justified `React.useEffect(...)`.
 *
 *   (B) Member-access call sites — `React.useEffect(` and
 *       `React.useLayoutEffect(`. These ARE exemptable via the sentinel
 *       comment described below, because the namespace style is the
 *       project convention and certain integrations (e.g. focus traps,
 *       imperative DOM measurement) genuinely require an effect.
 *
 * EXEMPTION CONTRACT (applies only to (B))
 * ────────────────────────────────────────
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
const CALL_SITE_PATTERNS = [
  /\bReact\.useEffect\s*\(/,
  /\bReact\.useLayoutEffect\s*\(/,
]
// Named-import detector. We first stitch a multi-line `import { ... } from
// "react"` block into a single string, THEN run this regex over it. The
// regex is anchored on the closing `} from "react"` (also accepts single
// quotes / `react/...` subpath like `react/jsx-runtime`, defensive). It is
// case-sensitive and tolerates whitespace, line breaks, type-only imports,
// trailing commas, and `as` aliases. Type-only imports are still banned —
// `useEffect` is not a type, so a `import type { useEffect }` is a code
// smell that should never appear; no point exempting it.
const NAMED_IMPORT_PATTERN =
  /import\s+(?:type\s+)?\{[\s\S]*?\b(useEffect|useLayoutEffect)\b[\s\S]*?\}\s*from\s*["']react(?:\/[^"']*)?["']/
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

/**
 * Find banned named-import statements. Iterates lines, and whenever a line
 * starts an `import { ...` block destined for `"react"`, walks forward to
 * the closing `}` (or end of file) and tests the joined block against
 * NAMED_IMPORT_PATTERN. Returns 0 or more `{ line, snippet, kind }` records
 * with `line` pointing at the FIRST line of the offending import statement.
 */
function findNamedImportViolations(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Cheap pre-filter: does this line begin an `import { ...` (possibly
    // `import type { ...`)? If not, skip — avoids quadratic behavior on
    // files with thousands of non-import lines.
    if (!/^\s*import\s+(?:type\s+)?\{/.test(line)) continue

    // Walk forward up to MAX_WALK lines collecting until we see a `}`.
    // We don't try to handle nested braces because TS import specifiers
    // forbid them — `{` then `}` is always the spec list.
    const buf = [line]
    let j = i
    while (j < lines.length - 1 && !/\}/.test(lines[j])) {
      j++
      buf.push(lines[j])
      if (j - i > MAX_WALK) break
    }
    const block = buf.join("\n")
    if (NAMED_IMPORT_PATTERN.test(block)) {
      out.push({
        line: i + 1,
        snippet: block.replace(/\s+/g, " ").slice(0, 200),
        kind: "named-import",
      })
    }
    // Skip past the import we just consumed so we don't double-scan its
    // continuation lines.
    i = j
  }
  return out
}

/** Scan one file; return array of `{ line, snippet, kind }` for unjustified hits. */
function scanFile(absPath) {
  const rel = relative(REPO_ROOT, absPath).replaceAll("\\", "/")
  if (ALLOWLIST_PATHS.has(rel)) return []

  const src = readFileSync(absPath, "utf8")
  const lines = src.split(/\r?\n/)
  const violations = []

  // (A) Named-import violations — never exemptable.
  for (const v of findNamedImportViolations(lines)) {
    violations.push(v)
  }

  // (B) Call-site violations — exemptable via sentinel.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const matched = CALL_SITE_PATTERNS.some((re) => re.test(line))
    if (!matched) continue

    const block = precedingCommentBlock(lines, i)
    if (block.includes(SENTINEL)) continue

    violations.push({ line: i + 1, snippet: line.trim(), kind: "call-site" })
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
    `    containing the sentinel "${SENTINEL}"`,
    `    IMMEDIATELY above the call site (contiguous comment lines,`,
    `    blank lines OK), explaining why none of the five rules apply.`,
    ``,
    `See ADR-0002 (docs/adr/0002-lint-enforcement-no-use-effect.md) for`,
    `the full enforcement contract.`,
  ].join("\n")
)
process.exit(1)
