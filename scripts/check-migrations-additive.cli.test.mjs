/**
 * End-to-end tests for the migration guard CLI (F1 audit S8.1).
 *
 * The detector is unit-tested separately; what matters here is the *plumbing*
 * that decides which migrations count as new — an added file (whole content),
 * a modified file (added lines only), a missing base ref, and the exit codes
 * CI depends on. Each case runs the real script against a throwaway git repo.
 */

import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"

const SCRIPT = join(import.meta.dirname, "check-migrations-additive.mjs")
const fixtures = []

const GIT_ISOLATION = [
  "-c",
  "user.email=guard@test.local",
  "-c",
  "user.name=Migration Guard Test",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/nonexistent",
]

function git(cwd, args) {
  return execFileSync("git", [...GIT_ISOLATION, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function makeRepo({ baseMigration, headMigration, mode = "added" }) {
  const root = mkdtempSync(join(tmpdir(), "migration-guard-"))
  fixtures.push(root)
  git(root, ["init", "-q"])
  writeMigration(root, "20260101000000_base", baseMigration)
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "base"])
  const base = git(root, ["rev-parse", "HEAD"]).trim()
  // "added" exercises the new-file path; "modified" rewrites the file that
  // already shipped, so only the diff's added lines may be judged.
  writeMigration(
    root,
    mode === "added" ? "20260102000000_head" : "20260101000000_base",
    headMigration
  )
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "head"])
  return { root, base }
}

function writeMigration(root, name, sql) {
  const dir = join(root, "prisma", "migrations", name)
  mkdirSync(dir, { recursive: true })
  // Real migrations end with a newline. Without one, git reports the file's
  // last line as rewritten (`\ No newline at end of file`) and the guard then
  // judges that line as added — strict, but git-accurate, and rare enough to
  // accept rather than special-case.
  writeFileSync(
    join(dir, "migration.sql"),
    sql.endsWith("\n") ? sql : `${sql}\n`
  )
}

function runGuard(cwd, args) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  }
}

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop(), { force: true, recursive: true })
  }
})

describe("check-migrations-additive CLI", () => {
  it("fails an added migration with destructive DDL and no marker", () => {
    const { root, base } = makeRepo({
      baseMigration: `CREATE TABLE "A" ("id" text);`,
      headMigration: `ALTER TABLE "A" DROP COLUMN "id";`,
    })

    const result = runGuard(root, ["--base", base, "--require-base"])

    expect(result.status).toBe(1)
    expect(result.output).toContain("20260102000000_head/migration.sql")
    expect(result.output).toContain("MIGRATION GUARD FAILED")
    expect(result.output).toContain("-- @destructive: <why this is safe")
  })

  it("passes the same migration once it carries a marker", () => {
    const { root, base } = makeRepo({
      baseMigration: `CREATE TABLE "A" ("id" text);`,
      headMigration: `-- @destructive: legacy column, unused since PER-100\nALTER TABLE "A" DROP COLUMN "id";`,
    })

    const result = runGuard(root, ["--base", base, "--require-base"])

    expect(result.status).toBe(0)
    expect(result.output).toContain("allowed by marker: legacy column")
  })

  it("passes an additive migration", () => {
    const { root, base } = makeRepo({
      baseMigration: `CREATE TABLE "A" ("id" text);`,
      headMigration: `ALTER TABLE "A" ADD COLUMN "note" text;`,
    })

    const result = runGuard(root, ["--base", base, "--require-base"])

    expect(result.status).toBe(0)
    expect(result.output).toContain("MIGRATION GUARD PASSED")
  })

  it("does not re-flag destructive DDL that already shipped, when the file is only modified", () => {
    const { root, base } = makeRepo({
      baseMigration: `ALTER TABLE "A" DROP COLUMN "old";`,
      headMigration: `ALTER TABLE "A" DROP COLUMN "old";\nALTER TABLE "A" ADD COLUMN "note" text;`,
      mode: "modified",
    })

    const result = runGuard(root, ["--base", base, "--require-base"])

    expect(result.status).toBe(0)
    expect(result.output).not.toContain("MIGRATION GUARD FAILED")
  })

  it("flags destructive DDL newly added to an already-tracked migration", () => {
    const { root, base } = makeRepo({
      baseMigration: `ALTER TABLE "A" DROP COLUMN "old";`,
      headMigration: `ALTER TABLE "A" DROP COLUMN "old";\nALTER TABLE "A" DROP COLUMN "second";`,
      mode: "modified",
    })

    const result = runGuard(root, ["--base", base, "--require-base"])

    expect(result.status).toBe(1)
    expect(result.output).toContain("drop-column")
    expect(result.output).toContain(`"second"`)
  })

  it("fails loudly with --require-base when the base ref cannot be resolved", () => {
    const { root } = makeRepo({
      baseMigration: `CREATE TABLE "A" ("id" text);`,
      headMigration: `ALTER TABLE "A" ADD COLUMN "note" text;`,
    })

    const result = runGuard(root, [
      "--base",
      "origin/does-not-exist",
      "--require-base",
    ])

    expect(result.status).toBe(1)
    expect(result.output).toContain("MIGRATION GUARD ERROR")
  })

  it("skips (exit 0) without --require-base when there is nothing to compare against", () => {
    const { root } = makeRepo({
      baseMigration: `CREATE TABLE "A" ("id" text);`,
      headMigration: `ALTER TABLE "A" ADD COLUMN "note" text;`,
    })

    const result = runGuard(root, ["--base", "origin/does-not-exist"])

    expect(result.status).toBe(0)
    expect(result.output).toContain("MIGRATION GUARD SKIPPED")
  })
})
