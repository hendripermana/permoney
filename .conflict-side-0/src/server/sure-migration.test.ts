import { describe, expect, test } from "vite-plus/test"
import {
  SURE_MIGRATION_BUNDLE_MAX_BYTES,
  sureMigrationInputSchema,
} from "./sure-migration"

// Audit fix: `bundle` is the entire raw migration export, read via
// `new TextEncoder().encode(data.bundle)` — unbounded is a resource-
// exhaustion risk. A byte-length `.refine` is used (not `.max()`, which
// counts UTF-16 code units, not bytes).

function bundleOfByteLength(byteLength: number): string {
  // ASCII characters are always exactly 1 byte in UTF-8, so string length
  // === byte length here — avoids re-implementing TextEncoder's counting.
  return "a".repeat(byteLength)
}

describe("sureMigrationInputSchema", () => {
  const base = { filename: "all.ndjson" }

  test("accepts a bundle at exactly the byte limit", () => {
    const bundle = bundleOfByteLength(SURE_MIGRATION_BUNDLE_MAX_BYTES)
    expect(() =>
      sureMigrationInputSchema.parse({ ...base, bundle })
    ).not.toThrow()
  })

  test("rejects a bundle one byte over the limit", () => {
    const bundle = bundleOfByteLength(SURE_MIGRATION_BUNDLE_MAX_BYTES + 1)
    expect(() => sureMigrationInputSchema.parse({ ...base, bundle })).toThrow()
  })
})
