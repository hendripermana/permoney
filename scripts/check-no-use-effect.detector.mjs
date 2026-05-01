/**
 * check-no-use-effect.detector.mjs — pure, IO-free detector functions for
 * the `no-use-effect` enforcement guard described by ADR-0002.
 *
 * This module is the canonical source of truth for the policy. It exports
 * pure functions that operate on already-read text — no `fs`, no `process`,
 * no console — so the same code runs both inside the CLI shim
 * (`scripts/check-no-use-effect.mjs`) and inside the unit-test suite
 * (`scripts/check-no-use-effect.test.mjs`). That separation is the whole
 * point: by exporting the regexes and walkers, the test file can pin
 * behaviour against ~20 edge cases and any future contributor refactoring
 * the regex gets immediate feedback when something breaks.
 *
 * EXPORTED API
 * ────────────
 *   • SENTINEL                   — the literal exemption string.
 *   • MAX_WALK                   — the upward/downward line ceiling.
 *   • CALL_SITE_PATTERNS         — regexes for `React.useEffect(` etc.
 *   • NAMED_IMPORT_PATTERN       — single regex for the named-import form.
 *   • isCommentOrBlank(line)     — line-level classifier.
 *   • precedingCommentBlock(lines, callLine) — sentinel-block walker.
 *   • findNamedImportViolations(lines)       — locate (A) violations.
 *   • findCallSiteViolations(lines)          — locate unjustified (B) violations.
 *   • scanText(text, { isAllowlisted? })     — convenience wrapper that
 *                                              returns the merged list of
 *                                              `{ line, snippet, kind }`
 *                                              violation records.
 *
 * Two violation kinds are distinguished:
 *
 *   "named-import" — banned `import { useEffect|useLayoutEffect } from
 *                    "react"`. Always a violation. NOT exemptable.
 *
 *   "call-site"    — `React.useEffect(` or `React.useLayoutEffect(` not
 *                    preceded by the sentinel comment. Exemptable.
 */

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** The literal phrase a justification block must contain to allow a call site. */
export const SENTINEL = "no-use-effect skill exemption"

/**
 * Hard upper bound on how far we'll walk when stitching multi-line imports
 * or hunting for the preceding comment block. Pathological files (e.g. a
 * single 5000-line banner comment) would otherwise scan forever; in
 * practice the walk terminates much sooner because real code interrupts it.
 */
export const MAX_WALK = 200

/**
 * Member-access call sites we hunt for. We deliberately match the open
 * paren so trivial mentions in strings/identifiers don't false-positive.
 * The `\b` is required to prevent matching e.g. `MyReact.useEffect(`.
 */
export const CALL_SITE_PATTERNS = [
  /\bReact\.useEffect\s*\(/,
  /\bReact\.useLayoutEffect\s*\(/,
]

/**
 * Single regex applied to a *stitched* multi-line import block. Anchored
 * on the closing `} from "react"` (also accepts single quotes and
 * `react/...` subpath imports such as `react/jsx-runtime`, defensive).
 *
 * Tolerated forms:
 *   - whitespace and line breaks inside the brace list
 *   - `import type { ... } from "react"` (still banned — `useEffect` is
 *     not a type, so a type-only import of it is a code smell)
 *   - trailing commas
 *   - aliases: `useEffect as ue`
 *
 * Rejected forms (correctly):
 *   - `import * as React from "react"` (no brace list)
 *   - `import React from "react"` (default import)
 *   - `import { useEffect } from "./local-react-mock"` (non-react source)
 */
export const NAMED_IMPORT_PATTERN =
  /import\s+(?:type\s+)?\{[\s\S]*?\b(useEffect|useLayoutEffect)\b[\s\S]*?\}\s*from\s*["']react(?:\/[^"']*)?["']/

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a given line, viewed in isolation, is part of a "comment
 * block" — i.e. either blank or starts with `//` / `/*` / `*` (the third
 * is the body of a JSDoc-style block-comment continuation). We deliberately
 * accept blank lines so a justification block can be visually separated
 * from the call site by an empty line and still count as "immediately
 * preceding" it.
 */
export function isCommentOrBlank(line) {
  // Defensive: callers may pass `undefined` when iterating past EOF.
  if (line == null) return false
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
export function precedingCommentBlock(lines, callLine) {
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

// ──────────────────────────────────────────────────────────────────────────
// Detectors
// ──────────────────────────────────────────────────────────────────────────

/**
 * Find banned named-import statements. Iterates lines, and whenever a line
 * starts an `import { ...` block destined for `"react"`, walks forward to
 * the closing `}` (or end of file) and tests the joined block against
 * `NAMED_IMPORT_PATTERN`.
 *
 * Returns 0 or more `{ line, snippet, kind }` records with `line` (1-based)
 * pointing at the FIRST line of the offending import statement.
 *
 * Known limitation (documented in ADR-0002 threat model): if a `}` appears
 * inside a comment or string literal between the opening `{` and the real
 * closing `}`, the walker terminates early and the regex test fails →
 * false negative. Acceptable: such a contrived import would not survive
 * `oxfmt` reformatting, and the team's threat model is honest contributors
 * who type the wrong thing, not adversaries.
 */
export function findNamedImportViolations(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Cheap pre-filter: does this line begin an `import { ...` (possibly
    // `import type { ...`)? If not, skip — avoids quadratic behaviour on
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

/**
 * Find unjustified `React.useEffect(...)` / `React.useLayoutEffect(...)`
 * call sites. A call site is justified iff the contiguous comment block
 * immediately preceding it contains the SENTINEL string.
 *
 * Returns 0 or more `{ line, snippet, kind: "call-site" }` records with
 * `line` (1-based) pointing at the call-site line.
 */
export function findCallSiteViolations(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const matched = CALL_SITE_PATTERNS.some((re) => re.test(line))
    if (!matched) continue

    const block = precedingCommentBlock(lines, i)
    if (block.includes(SENTINEL)) continue

    out.push({ line: i + 1, snippet: line.trim(), kind: "call-site" })
  }
  return out
}

/**
 * Convenience wrapper for tests and ad-hoc invocation. Splits the input
 * text on line boundaries (CRLF-tolerant) and runs both detectors.
 *
 * @param {string} text
 * @param {{ isAllowlisted?: boolean }} [opts] If `isAllowlisted` is true
 *   (e.g. `src/hooks/use-mount-effect.ts`), the call-site detector is
 *   skipped — the named-import detector still runs because the allowlist
 *   only covers the `React.useEffect(` site, never named imports.
 * @returns {Array<{ line: number, snippet: string, kind: "named-import" | "call-site" }>}
 */
export function scanText(text, opts = {}) {
  const lines = text.split(/\r?\n/)
  const violations = []
  for (const v of findNamedImportViolations(lines)) violations.push(v)
  if (!opts.isAllowlisted) {
    for (const v of findCallSiteViolations(lines)) violations.push(v)
  }
  return violations
}
