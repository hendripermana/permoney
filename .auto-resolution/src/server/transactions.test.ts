import { describe, expect, test } from "vite-plus/test"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  bulkCreateTransactionsTransportInputSchema,
  bulkDeleteTransactionsTransportInputSchema,
  bulkUpdateTransactionsTransportInputSchema,
} from "./transactions"

// Audit fix: bulk endpoints run their whole array inside one interactive
// transaction on the RLS-scoped connection — an unbounded array risks
// unbounded transaction time and connection-pool starvation for other
// tenants. Boundary tests only (the row/id shape itself is exercised
// elsewhere); these prove the .max(500) bound is actually wired and
// rejects before any transaction would open.

function minimalRow(i: number) {
  return {
    id: `row-${i}`,
    idempotencyKey: createUuidV7(),
    accountId: "account-1",
    amount: "1000",
    date: "2026-07-18",
    description: `Row ${i}`,
    type: "expense" as const,
  }
}

describe("bulkCreateTransactionsTransportInputSchema", () => {
  test("accepts exactly 500 transactions", () => {
    const transactions = Array.from({ length: 500 }, (_, i) => minimalRow(i))
    expect(() =>
      bulkCreateTransactionsTransportInputSchema.parse({ transactions })
    ).not.toThrow()
  })

  test("rejects 501 transactions", () => {
    const transactions = Array.from({ length: 501 }, (_, i) => minimalRow(i))
    expect(() =>
      bulkCreateTransactionsTransportInputSchema.parse({ transactions })
    ).toThrow()
  })
})

describe("bulkUpdateTransactionsTransportInputSchema", () => {
  test("accepts exactly 500 ids", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`)
    expect(() =>
      bulkUpdateTransactionsTransportInputSchema.parse({ ids })
    ).not.toThrow()
  })

  test("rejects 501 ids", () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`)
    expect(() =>
      bulkUpdateTransactionsTransportInputSchema.parse({ ids })
    ).toThrow()
  })
})

describe("bulkDeleteTransactionsTransportInputSchema", () => {
  test("accepts exactly 500 ids", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`)
    expect(() =>
      bulkDeleteTransactionsTransportInputSchema.parse({ ids })
    ).not.toThrow()
  })

  test("rejects 501 ids", () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`)
    expect(() =>
      bulkDeleteTransactionsTransportInputSchema.parse({ ids })
    ).toThrow()
  })
})
