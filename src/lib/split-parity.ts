/**
 * Split Parity Guard — GAAP Compliance Helper (BigInt edition)
 * =============================================================================
 *
 * Backend-side authoritative invariant for split transactions:
 *
 *   sum(splitEntry.amount) === parent.amount
 *
 * Now operates on `bigint` minor units (post-ADR-0001 migration). With BigInt
 * arithmetic this check is **exact** — no epsilon needed. Float's
 * non-associativity (`(a+b)+c !== a+(b+c)`) was the only reason the old
 * implementation tolerated a 0.01 epsilon; that tolerance silently absorbed
 * real bugs in addition to Float noise. Exact equality is now the rule.
 *
 * Extracted as a pure function so:
 *   1. The same logic is shared between `createTransactionFn` and
 *      `updateTransactionFn` (single source of truth, no drift).
 *   2. It can be unit-tested without spinning up Prisma + a database.
 *
 * @see docs/adr/0001-money-type-migration.md
 */

import { absMoney, sumMoney, type Money } from "@/lib/money"

export interface ParitySplitEntry {
  amount: Money | bigint
}

export interface ParitySplitInput {
  amount: Money | bigint
  isSplit: boolean
  splitEntries?: Array<ParitySplitEntry> | null
}

export interface ParityCheckResult {
  ok: boolean
  /** Sum of provided split entries in minor units. */
  splitSum: bigint
  /** Absolute delta between splitSum and parent magnitude (in minor units). */
  delta: bigint
}

/**
 * Run the split parity check without throwing. Useful for callers that want
 * to surface a structured error (e.g. attach to a Zod issue, log telemetry).
 *
 * Edge cases:
 * - `isSplit === false`: returns `ok: true` regardless of entries.
 * - Empty / missing `splitEntries`: returns `ok: true` (split flag with no
 *   entries is treated upstream — this guard only checks the sum invariant).
 *
 * NOTE: parent `amount` is compared against `|sum|` because the parent's
 * sign carries the transaction direction (negative for expense, positive
 * for income) while split children are always stored as magnitudes.
 */
export function checkSplitParity(input: ParitySplitInput): ParityCheckResult {
  if (!input.isSplit || !input.splitEntries?.length) {
    return { ok: true, splitSum: 0n, delta: 0n }
  }

  const splitSum = sumMoney(input.splitEntries.map((e) => e.amount))
  const parentMagnitude = absMoney(input.amount)
  const diff = splitSum - parentMagnitude
  const delta = diff < 0n ? -diff : diff
  return { ok: delta === 0n, splitSum, delta }
}

/**
 * Throwing variant for use inside Prisma `$transaction` blocks. The thrown
 * error rolls back the transaction automatically (ACID safety net).
 *
 * Error code prefix `SPLIT_PARITY_VIOLATION:` is matched by the form layer
 * to render a field-level error; do not change without coordinating with
 * `transaction-form-modal.tsx`.
 */
export function assertSplitParity(input: ParitySplitInput): void {
  const result = checkSplitParity(input)
  if (result.ok) return

  throw new Error(
    `SPLIT_PARITY_VIOLATION: SplitEntries sum (${result.splitSum.toString()}) ` +
      `must equal parent amount magnitude (${absMoney(input.amount).toString()}). ` +
      `Δ = ${result.delta.toString()} minor units (exact match required).`
  )
}
