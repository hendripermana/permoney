#!/usr/bin/env node
/**
 * Migration guard (F1 audit S8.1) — fails when a *changed* migration contains
 * destructive DDL (`DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE`,
 * `SET NOT NULL`) without an explicit `-- @destructive: <reason>` marker.
 *
 * Scope, deliberately:
 *   - ADDED migration files are scanned in full;
 *   - MODIFIED migration files are scanned on the added lines only, so a PR is
 *     never blocked by destructive DDL that already shipped in that file —
 *     only by what the PR itself introduces.
 * The pattern work lives in `check-migrations-additive.detector.mjs` (IO-free,
 * unit-tested in `check-migrations-additive.test.mjs`).
 *
 * Base ref: `--base <ref>` or `MIGRATION_CHECK_BASE` (CI passes the PR base
 * sha). Otherwise the first resolvable of `origin/main`, `main`,
 * `origin/master`. With `--require-base` (CI) an unresolvable base is a
 * failure; without it (local runs, shallow clones) the guard reports that it
 * could not compare and exits 0, so it can never block unrelated work.
 *
 * Usage:
 *   node scripts/check-migrations-additive.mjs [--base <ref>] [--require-base]
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import {
  extractAddedLines,
  formatScanReport,
  scanMigration,
} from "./check-migrations-additive.detector.mjs"

const MIGRATIONS_PATHSPEC = "prisma/migrations/*/migration.sql"
const FALLBACK_BASES = ["origin/main", "main", "origin/master"]

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const requireBase = process.argv.includes("--require-base")
const requestedBase = (
  readFlagValue("--base") ??
  process.env.MIGRATION_CHECK_BASE ??
  ""
).trim()

let base = null
if (requestedBase !== "") {
  base = refExists(requestedBase) ? requestedBase : null
} else {
  base = FALLBACK_BASES.find(refExists) ?? null
}
const requestedButMissing = requestedBase !== "" && base === null

if (base === null) {
  const detail = requestedButMissing
    ? `base ref "${requestedBase}" was requested (MIGRATION_CHECK_BASE/--base) but does not exist in this checkout`
    : `none of ${FALLBACK_BASES.join(", ")} could be resolved`
  if (requireBase) {
    console.error(`❌ MIGRATION GUARD ERROR: ${detail}.`)
    console.error(
      "Pass an explicit --base, or fetch the base branch (CI uses fetch-depth: 0)."
    )
    process.exit(1)
  }
  console.warn(`⚠️  MIGRATION GUARD SKIPPED: ${detail}.`)
  console.warn("Nothing to compare against, so no migration was scanned.")
  process.exit(0)
}

const diffRange = `${base}...HEAD`

function changedMigrations(filter) {
  const output = git([
    "diff",
    "--name-only",
    `--diff-filter=${filter}`,
    diffRange,
    "--",
    MIGRATIONS_PATHSPEC,
  ])
  return output.split("\n").filter((line) => line.trim() !== "")
}

const results = []

for (const path of changedMigrations("A")) {
  results.push(
    scanMigration({
      path,
      sql: readFileSync(path, "utf8"),
      addedLines: null,
    })
  )
}

for (const path of changedMigrations("M")) {
  const diffText = git(["diff", "--unified=0", diffRange, "--", path])
  const addedLines = extractAddedLines(diffText)
  if (addedLines.size === 0) {
    continue
  }
  results.push(
    scanMigration({
      path,
      sql: readFileSync(path, "utf8"),
      addedLines: new Set(addedLines.keys()),
    })
  )
}

const scannedCount = results.length
const report = formatScanReport(results, { base })

console.log(report)

const failed = results.some((result) => result.violations.length > 0)
if (failed) {
  process.exit(1)
}

if (scannedCount === 0) {
  console.log(
    `(no changed migration files between ${base} and HEAD — nothing to scan)`
  )
}
process.exit(0)
