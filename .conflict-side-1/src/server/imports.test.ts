import { describe, expect, test } from "vite-plus/test"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  createImportBatchInputSchema,
  reviewImportRowsInputSchema,
} from "./imports"

// Audit fix: the whole `rows`/`decisions` array is staged inside one
// interactive transaction — unbounded is a resource-exhaustion risk.
// Boundary tests only, proving the bound is actually wired.

function minimalStagedRow(i: number) {
  return {
    accountId: "account-1",
    rawPayload: {},
    date: "2026-07-18",
    amount: "1000",
    type: "expense" as const,
    description: `Row ${i}`,
  }
}

describe("createImportBatchInputSchema", () => {
  const base = { contentHash: "hash-1" }

  test("accepts exactly 5000 rows", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => minimalStagedRow(i))
    expect(() =>
      createImportBatchInputSchema.parse({ ...base, rows })
    ).not.toThrow()
  })

  test("rejects 5001 rows", () => {
    const rows = Array.from({ length: 5001 }, (_, i) => minimalStagedRow(i))
    expect(() =>
      createImportBatchInputSchema.parse({ ...base, rows })
    ).toThrow()
  })
})

describe("reviewImportRowsInputSchema", () => {
  const base = { batchId: "batch-1", idempotencyKey: createUuidV7() }

  function decision(i: number) {
    return { rowId: `row-${i}`, verdict: "confirm" as const }
  }

  test("accepts exactly 5000 decisions", () => {
    const decisions = Array.from({ length: 5000 }, (_, i) => decision(i))
    expect(() =>
      reviewImportRowsInputSchema.parse({ ...base, decisions })
    ).not.toThrow()
  })

  test("rejects 5001 decisions", () => {
    const decisions = Array.from({ length: 5001 }, (_, i) => decision(i))
    expect(() =>
      reviewImportRowsInputSchema.parse({ ...base, decisions })
    ).toThrow()
  })
})
