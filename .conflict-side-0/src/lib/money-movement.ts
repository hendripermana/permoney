import type { AccountType } from "./accounts"

/**
 * PER-247 — Contextual money movement.
 *
 * A `funds_movement` transfer carries a constrained, nullable `purpose` label
 * describing WHY the money moved (top-up to an e-wallet, an investment
 * contribution/withdrawal, savings, cash withdrawal). The purpose lives on
 * the canonical `Transfer` pairing record (one value shared by both legs) and
 * is derived from the account taxonomy by default; the user may override it.
 * Liability transfer kinds (cc_payment / loan_payment / liability_draw) do
 * NOT take a purpose — their `kind` already carries the meaning (enforced by
 * the transfer_liability_kind_safe constraint trigger).
 */
export const TRANSFER_PURPOSE_VALUES = [
  "top_up",
  "investment_contribution",
  "investment_withdrawal",
  "savings",
  "cash_withdrawal",
] as const

export type TransferPurpose = (typeof TRANSFER_PURPOSE_VALUES)[number]

/** Short human labels for each purpose (UI select + list rendering). */
export const TRANSFER_PURPOSE_LABELS: Record<TransferPurpose, string> = {
  top_up: "Top-up",
  investment_contribution: "Invest",
  investment_withdrawal: "Withdraw",
  savings: "Savings",
  cash_withdrawal: "Cash withdrawal",
}

/**
 * The contextual noun for a money movement in a transaction list row
 * (PER-247 scope 3). A funds_movement transfer with a resolved purpose reads
 * as that purpose ("Top-up", "Invest", "Withdraw", …) instead of the generic
 * "Transfer"; everything else (a plain transfer, a liability kind) falls back
 * to "Transfer". Direction ("from"/"to"), the counterparty account name, and
 * the fee are formatted by the call site — they differ per list — so this
 * stays a pure, reusable label. Accepts the raw persisted string (the DB
 * CHECK guarantees it is a valid purpose) and defends against an unknown one.
 */
export function transferMovementNoun(
  purpose: string | null | undefined
): string {
  if (purpose && purpose in TRANSFER_PURPOSE_LABELS) {
    return TRANSFER_PURPOSE_LABELS[purpose as TransferPurpose]
  }
  return "Transfer"
}

/**
 * The single human label for a money movement, contextual on BOTH the transfer
 * `kind` and its `purpose` (PER-247). This is the ONE source of truth for the
 * label shown wherever a transfer is summarized — the ledger list, the
 * per-account statement, and the per-account "spend by category" breakdown.
 *
 * Liability transfer kinds already carry their meaning in `kind` and never take
 * a purpose, so they map directly:
 *   cc_payment → "Pay credit card", loan_payment → "Pay loan",
 *   liability_draw → "Borrow".
 * A plain `funds_movement` (or any other kind, e.g. an unclassified transfer)
 * falls back to the purpose noun ("Top-up"/"Invest"/"Withdraw"/"Savings"/
 * "Cash withdrawal"/"Transfer"). Accepts the raw persisted strings; the DB
 * CHECK constraints guarantee valid domains and this defends against unknowns.
 */
export function moneyMovementLabel({
  kind,
  purpose,
}: {
  kind?: string | null
  purpose?: string | null
}): string {
  if (kind === "cc_payment") return "Pay credit card"
  if (kind === "loan_payment") return "Pay loan"
  if (kind === "liability_draw") return "Borrow"
  return transferMovementNoun(purpose)
}

/**
 * Derive the default purpose for a funds_movement transfer from the account
 * taxonomy (class/type/subtype — never ad-hoc product strings, AGENTS.md §5).
 * Returns null when no rule matches (a plain transfer). An INVESTMENT →
 * INVESTMENT move is ambiguous (both "contribution" and "withdrawal" apply),
 * so it deliberately derives null; the user may still override explicitly.
 */
export function deriveTransferPurpose({
  fromAccountType,
  toAccountType,
  toAccountSubtype,
}: {
  fromAccountType: AccountType
  toAccountType: AccountType
  toAccountSubtype?: string | null
}): TransferPurpose | null {
  if (fromAccountType === "INVESTMENT" && toAccountType === "INVESTMENT") {
    return null
  }
  if (toAccountType === "E_WALLET") return "top_up"
  if (toAccountType === "INVESTMENT") return "investment_contribution"
  if (fromAccountType === "INVESTMENT") return "investment_withdrawal"
  if (toAccountType === "CASH") return "cash_withdrawal"
  if (toAccountType === "DEPOSITORY" && toAccountSubtype === "savings") {
    return "savings"
  }
  return null
}
