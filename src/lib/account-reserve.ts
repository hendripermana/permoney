// =============================================================================
// PER-217 — reserve / minimum balance ("dana mengendap") — pure client helpers.
//
// The reserve is a user-defined spending FLOOR: money kept untouched inside a
// cash-like account (a bank/e-wallet minimum balance, or a self-imposed buffer).
// It is LEDGER-NEUTRAL — it never changes the stored balance, net worth, or any
// transaction. It only reshapes what the user sees as "safe to spend":
//
//     available (safe-to-spend) = balance − reserve
//
// The server folds the reserve into its authoritative `available` (which also
// subtracts uncleared holds — see valuations.ts computeAvailable). These helpers
// give the client the same reserve-aware figure for the account card and detail
// hero WITHOUT a round-trip, working purely on the minor-unit balance + reserve
// already present on every account record. All math stays in bigint minor units.
// =============================================================================

/**
 * Safe-to-spend after honoring the reserve floor. May be NEGATIVE when the
 * balance has dipped below the reserve — that is a deliberate, useful signal
 * ("you're into your dana mengendap"), never clamped away.
 */
export function availableAfterReserve(
  balanceMinor: bigint,
  reserveMinor: bigint
): bigint {
  return balanceMinor - reserveMinor
}

/**
 * Health of the balance relative to its reserve floor:
 *   - "none":    no reserve set (reserve <= 0)
 *   - "below":   balance is under the floor (available is negative)
 *   - "near":    balance is within 20% above the floor (getting close)
 *   - "healthy": comfortably above the floor
 */
export type ReserveHealth = "none" | "below" | "near" | "healthy"

export function reserveHealth(
  balanceMinor: bigint,
  reserveMinor: bigint
): ReserveHealth {
  if (reserveMinor <= 0n) return "none"
  if (balanceMinor < reserveMinor) return "below"
  // 20% headroom band above the floor, computed in integer minor units.
  const nearCeiling = (reserveMinor * 12n) / 10n
  if (balanceMinor < nearCeiling) return "near"
  return "healthy"
}

/**
 * Fraction (0..1) of the current balance that the reserve locks down — the size
 * of the "reserved" segment in a balance gauge. Balance at/below the reserve is
 * fully locked (1); no reserve or a non-positive balance leaves nothing to
 * split. Uses Number only for the final ratio (safe: it is a bounded 0..1
 * proportion for display, never money math).
 */
export function reserveLockedFraction(
  balanceMinor: bigint,
  reserveMinor: bigint
): number {
  if (reserveMinor <= 0n) return 0
  if (balanceMinor <= 0n) return 1
  if (reserveMinor >= balanceMinor) return 1
  return Number(reserveMinor) / Number(balanceMinor)
}

/**
 * Whether a reserve is meaningfully set (positive) for display purposes. A
 * `null`/absent or "0" reserve reads as "no reserve".
 */
export function hasReserve(reserveMinor: bigint | null): boolean {
  return reserveMinor !== null && reserveMinor > 0n
}

/**
 * Reserve is only meaningful for cash-like ASSET accounts (the DB CHECK enforces
 * this; the client mirrors it to decide whether to show the reserve input/UI).
 */
export function accountSupportsReserve(account: {
  accountClass: string
  balanceSource: string
}): boolean {
  return (
    account.accountClass === "ASSET" &&
    account.balanceSource === "transaction_flow"
  )
}
