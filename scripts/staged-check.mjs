#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * staged-check.mjs — pre-commit dispatcher.
 *
 * Vite+'s `staged` hook (configured in `vite.config.ts`) parses its value as
 * a single command (argv array, no shell), so a chained string like
 *   `vp check --fix && node scripts/check-no-use-effect.mjs --quiet`
 * cannot be passed directly: every flag would land on `vp check`.
 *
 * This wrapper is the workaround. It runs the two pre-commit steps in
 * sequence as separate child processes, propagating non-zero exit codes
 * so the commit aborts on the first failure.
 *
 * Steps:
 *   1. `vp check --fix` — fmt + lint + typecheck (auto-fix where safe).
 *   2. `node scripts/check-no-use-effect.mjs --quiet` — ADR-0002 guard.
 */

import { spawnSync } from "node:child_process"

/** Run `cmd` with `args`, inherit stdio, exit on non-zero. */
function step(cmd, args, label) {
  const result = spawnSync(cmd, args, { stdio: "inherit" })
  if (result.error) {
    console.error(`\u001b[31m✗ ${label}: ${result.error.message}\u001b[0m`)
    process.exit(1)
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status)
  }
  if (result.signal) {
    console.error(
      `\u001b[31m✗ ${label}: terminated by signal ${result.signal}\u001b[0m`
    )
    process.exit(1)
  }
}

step("vp", ["check", "--fix"], "vp check --fix")
step(
  process.execPath,
  ["scripts/check-no-use-effect.mjs", "--quiet"],
  "no-use-effect guard"
)
