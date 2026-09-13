import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vite-plus/test"

const SERVER_DIR = join(import.meta.dirname, ".")
const GUC_LITERAL = "set_config('app.bulk_ledger_replay'"

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
    )
    .map((entry) => join(entry.parentPath, entry.name))
}

describe("ADR-0044 §8 grep-proof: single GUC anchor", () => {
  test("set_config('app.bulk_ledger_replay' appears in exactly one file", () => {
    const matches = listTsFiles(SERVER_DIR).filter((file) =>
      readFileSync(file, "utf8").includes(GUC_LITERAL)
    )

    expect(matches).toEqual([join(SERVER_DIR, "bulk-ledger-replay.ts")])
  })
})
