import { z } from "zod"

// =============================================================================
// PER-267 — ADR-0043's PER-264 amendment, "UI surface" section.
//
// A backdated transaction entered at/before a `ground_truth` anchor is
// recorded for history but does not move the account's balance (the anchor is
// an independent observation of reality that already absorbed it). The
// transaction form's "ubah saldo juga" override is the rarely-used escape
// hatch for the genuine edge case — money discovered *right now* that wasn't
// in the wallet before. Second review point 3 (see ADR-0043) rejected a
// mandatory free-text reason as producing "asdf"/"lupa"-grade noise; a small,
// structured reason set is more useful for later analysis and still one tap
// in the common case. This file is the single, Prisma-free source of truth
// for that reason set, shared by the client (chip labels) and the server
// (`transactionInputSchema`'s `balanceOverride` field, `transactions.ts`).
// =============================================================================

export const BALANCE_OVERRIDE_REASON_VALUES = [
  "forgot_to_log",
  "found_uncounted_balance",
  "correcting_earlier_reconcile",
  "other",
] as const

export type BalanceOverrideReason =
  (typeof BALANCE_OVERRIDE_REASON_VALUES)[number]

// Indonesian labels — this project's transaction-entry UI copy is already
// Indonesian (see transaction-form-modal.tsx); this feature matches that tone.
export const BALANCE_OVERRIDE_REASON_LABELS: Record<
  BalanceOverrideReason,
  string
> = {
  forgot_to_log: "Lupa dicatat",
  found_uncounted_balance: "Ketemu saldo/uang yang belum terhitung",
  correcting_earlier_reconcile: "Koreksi reconcile sebelumnya",
  other: "Lainnya",
}

export const BALANCE_OVERRIDE_REASONS = BALANCE_OVERRIDE_REASON_VALUES.map(
  (value) => ({ value, label: BALANCE_OVERRIDE_REASON_LABELS[value] })
)

export const OTHER_BALANCE_OVERRIDE_REASON: BalanceOverrideReason = "other"

export const balanceOverrideInputSchema = z
  .object({
    reason: z.enum(BALANCE_OVERRIDE_REASON_VALUES),
    // Optional free text — required only for "other", enforced by the
    // `.refine` below so the constraint lives in one place, not duplicated
    // between the client form and the server boundary.
    note: z.string().trim().max(280).optional(),
  })
  .refine(
    (value) =>
      value.reason !== OTHER_BALANCE_OVERRIDE_REASON ||
      Boolean(value.note && value.note.length > 0),
    {
      message: 'A short note is required when the reason is "Lainnya"',
      path: ["note"],
    }
  )

export type BalanceOverrideInput = z.infer<typeof balanceOverrideInputSchema>

/**
 * The UI-hint predicate: would `date` be EXCLUDED from the ground-truth
 * anchor's balance, i.e. is `date <= A.valuationDate` under the server's
 * `afterAnchor` predicate (`sumTransactionFlowAfterAnchor`,
 * `src/server/valuations.ts`)?
 *
 * `Valuation.valuationDate` is always stored/compared at midnight of its
 * calendar day (`@db.Date`), while a real transaction's `date` carries an
 * actual clock time. That makes the boundary asymmetric: a transaction on a
 * calendar day STRICTLY BEFORE the anchor's is always `<=` (any time of day),
 * but a transaction on the SAME calendar day as the anchor is virtually
 * always `>` (any non-midnight time is after that day's 00:00:00) — same-day
 * entries are ordinary post-anchor activity, not excluded ones. So this
 * compares calendar days with `<`, not `<=`, even though the column itself is
 * date-only — matching what the server will actually decide, not just the
 * column's storage granularity. This is a client-side approximation for
 * banner purposes only; the server re-derives the real condition
 * independently before ever honoring an override (never trusts this
 * client-side check for a money-moving decision).
 */
export function isOnOrBeforeAnchorDate(
  date: Date,
  anchorValuationDate: string
): boolean {
  return toCalendarDateString(date) < anchorValuationDate
}

function toCalendarDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
