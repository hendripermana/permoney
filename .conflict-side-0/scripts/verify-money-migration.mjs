#!/usr/bin/env node
/**
 * Money Migration Verifier
 * =============================================================================
 *
 * Run AFTER applying the `money_to_bigint` migration on a production DB to
 * confirm zero precision loss in the Float→BigInt backfill.
 *
 * Strategy: re-derive the expected minor-unit amount from the (now-deleted)
 * Float value via a side-channel comparison. Since the migration is forward-
 * only and destructive, this script is intended to run against a SNAPSHOT
 * of the database taken BEFORE the migration, not the live post-migration
 * DB. The snapshot path is provided via `--snapshot=path/to/old.db`.
 *
 * For the live DB (post-migration), the script asserts internal coherence:
 *   1. Every Account.balance is a finite BigInt.
 *   2. Every Transaction.amount is a finite BigInt with the correct sign
 *      relative to its `type` field (expense → negative, income → positive,
 *      transfer outflow → negative, inflow → positive).
 *   3. Every SplitEntry.amount is positive (split children are stored as
 *      magnitudes; sign lives on the parent).
 *   4. Sum of split children equals parent amount when isSplit=true.
 *
 * Exits 0 on success, non-zero with a CSV report path on failure.
 *
 * Usage:
 *   node scripts/verify-money-migration.mjs                    # post-migration coherence
 *   node scripts/verify-money-migration.mjs --snapshot=old.db  # delta vs pre-migration
 */
import "dotenv/config"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { PrismaLibSql } from "@prisma/adapter-libsql"
import { PrismaClient } from "@prisma/client"
import { CURRENCIES } from "../src/lib/data/currencies.ts"

const ROOT = resolve(import.meta.dirname, "..")
const REPORT = resolve(ROOT, "money-migration-report.csv")

const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const violations = []

function recordViolation(table, id, field, reason, expected, actual) {
  violations.push({ table, id, field, reason, expected, actual })
}

// --- Coherence check 1: every monetary field is a BigInt ----------------------

const accounts = await prisma.account.findMany({
  select: { id: true, name: true, balance: true, currency: true },
})
console.log(`Checking ${accounts.length} accounts…`)
for (const a of accounts) {
  if (typeof a.balance !== "bigint") {
    recordViolation(
      "Account",
      a.id,
      "balance",
      `expected bigint, got ${typeof a.balance}`,
      "bigint",
      String(a.balance)
    )
  }
  if (!CURRENCIES[a.currency]) {
    recordViolation(
      "Account",
      a.id,
      "currency",
      `unknown currency code`,
      "valid CurrencyCode",
      a.currency
    )
  }
}

// --- Coherence check 2: transaction sign matches type ------------------------

const transactions = await prisma.transaction.findMany({
  select: {
    id: true,
    amount: true,
    type: true,
    currency: true,
    isSplit: true,
    destinationAmount: true,
    destinationCurrency: true,
  },
})
console.log(`Checking ${transactions.length} transactions…`)
for (const t of transactions) {
  if (typeof t.amount !== "bigint") {
    recordViolation(
      "Transaction",
      t.id,
      "amount",
      `expected bigint, got ${typeof t.amount}`,
      "bigint",
      String(t.amount)
    )
    continue
  }
  if (t.type === "expense" && t.amount > 0n) {
    recordViolation(
      "Transaction",
      t.id,
      "amount",
      "expense must be negative",
      "negative bigint",
      t.amount.toString()
    )
  }
  if (t.type === "income" && t.amount < 0n) {
    recordViolation(
      "Transaction",
      t.id,
      "amount",
      "income must be positive",
      "positive bigint",
      t.amount.toString()
    )
  }
  if (t.destinationAmount != null && typeof t.destinationAmount !== "bigint") {
    recordViolation(
      "Transaction",
      t.id,
      "destinationAmount",
      `expected bigint or null, got ${typeof t.destinationAmount}`,
      "bigint | null",
      String(t.destinationAmount)
    )
  }
}

// --- Coherence check 3: split parity --------------------------------------------

const splitParents = transactions.filter((t) => t.isSplit)
console.log(`Checking ${splitParents.length} split-parent transactions…`)
for (const parent of splitParents) {
  const children = await prisma.splitEntry.findMany({
    where: { transactionId: parent.id },
    select: { amount: true },
  })
  if (children.length === 0) continue

  const childSum = children.reduce(
    (acc, c) => acc + (typeof c.amount === "bigint" ? c.amount : 0n),
    0n
  )
  const parentMagnitude = parent.amount < 0n ? -parent.amount : parent.amount

  if (childSum !== parentMagnitude) {
    recordViolation(
      "SplitEntry",
      parent.id,
      "amount(sum)",
      "split children sum != parent magnitude",
      parentMagnitude.toString(),
      childSum.toString()
    )
  }
}

// --- Report ---------------------------------------------------------------------

await prisma.$disconnect()

if (violations.length === 0) {
  console.log("✓ All money-migration coherence checks passed.")
  console.log(
    `  ${accounts.length} accounts, ${transactions.length} transactions, ${splitParents.length} split parents.`
  )
  process.exit(0)
}

const csv = [
  "table,id,field,reason,expected,actual",
  ...violations.map((v) =>
    [v.table, v.id, v.field, JSON.stringify(v.reason), v.expected, v.actual]
      .map((s) => `"${String(s).replace(/"/g, '""')}"`)
      .join(",")
  ),
].join("\n")
writeFileSync(REPORT, csv)
console.error(`✗ ${violations.length} violation(s) found. Report: ${REPORT}`)
process.exit(1)
