/**
 * Split Parity Guard — GAAP Compliance Helper
 * =============================================================================
 *
 * Backend-side authoritative invariant for split transactions:
 *
 *   sum(splitEntry.amount) === parent.amount
 *
 * The UI form already validates this for UX, but UI validation can be bypassed
 * (request crafted by hand, browser bug, race condition, optimistic mutation
 * drift). The server function MUST re-validate before writing the row, or the
 * ledger silently accumulates inconsistent split parents.
 *
 * Extracted as a pure function so:
 *   1. The same logic is shared between `createTransactionFn` and
 *      `updateTransactionFn` (single source of truth, no drift).
 *   2. It can be unit-tested without spinning up Prisma + a database.
 *   3. Future migration to integer-cents money type (see ADR-0001) only
 *      touches this one function instead of every handler.
 *
 * NOTE on the epsilon (`0.01`):
 * Floats are not associative — repeated additions accumulate rounding error.
 * `0.01` is one cent, the smallest unit we currently care about for IDR/USD
 * scale=2 currencies. Once the BigInt-cents migration lands, this helper will
 * accept BigInt and use exact equality.
 */

export interface ParitySplitEntry {
  amount: number
}

export interface ParitySplitInput {
  amount: number
  isSplit: boolean
  splitEntries?: Array<ParitySplitEntry> | null
}

/**
 * Tolerance in absolute monetary units. Differences below this are considered
 * floating-point noise and accepted. See ADR-0001 for the migration plan.
 */
export const SPLIT_PARITY_EPSILON = 0.01

export interface ParityCheckResult {
  ok: boolean
  /** Sum of provided split entries (NaN-safe; non-finite inputs surface here). */
  splitSum: number
  /** Absolute delta between splitSum and parent amount. */
  delta: number
}

/**
 * Run the split parity check without throwing. Useful for callers that want
 * to surface a structured error (e.g. attach to a Zod issue, log telemetry).
 *
 * Edge cases:
 * - `isSplit === false`: returns `ok: true` regardless of entries.
 * - Empty / missing `splitEntries`: returns `ok: true` (split flag with no
 *   entries is treated upstream — this guard only checks the sum invariant).
 * - Non-finite amounts (NaN, Infinity): returns `ok: false` with delta=NaN.
 *   Callers should reject these inputs at the schema layer; this guard is a
 *   second line of defense, not the primary validator.
 */
export function checkSplitParity(input: ParitySplitInput): ParityCheckResult {
  if (!input.isSplit || !input.splitEntries?.length) {
    return { ok: true, splitSum: 0, delta: 0 }
  }

  const splitSum = input.splitEntries.reduce(
    (acc, entry) => acc + entry.amount,
    0
  )

  // Guard against NaN/Infinity sneaking past the schema.
  if (!Number.isFinite(splitSum) || !Number.isFinite(input.amount)) {
    return { ok: false, splitSum, delta: Number.NaN }
  }

  const delta = Math.abs(splitSum - input.amount)
  return { ok: delta <= SPLIT_PARITY_EPSILON, splitSum, delta }
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
    `SPLIT_PARITY_VIOLATION: SplitEntries sum (${result.splitSum.toFixed(2)}) ` +
      `must equal parent amount (${input.amount.toFixed(2)}). ` +
      `Δ = ${result.delta.toFixed(2)} (epsilon = ${SPLIT_PARITY_EPSILON.toFixed(2)})`
  )
}
