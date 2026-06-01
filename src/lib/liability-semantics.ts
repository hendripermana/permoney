import {
  ACCOUNT_TYPE_VALUES,
  getAccountClassForType,
  type AccountType,
} from "./accounts"

export const TRANSACTION_KIND_VALUES = [
  "standard",
  "funds_movement",
  "cc_payment",
  "loan_payment",
  "liability_draw",
  "liability_interest",
  "liability_fee",
] as const

export type TransactionKind = (typeof TRANSACTION_KIND_VALUES)[number]
export type TransactionType = "expense" | "income" | "transfer"

export type TransferTransactionKind =
  | "cc_payment"
  | "funds_movement"
  | "liability_draw"
  | "loan_payment"

export type LiabilityCostTransactionKind =
  | "liability_fee"
  | "liability_interest"

const ACCOUNT_TYPE_SET: ReadonlySet<string> = new Set(ACCOUNT_TYPE_VALUES)
const LIABILITY_PRINCIPAL_PAYMENT_KINDS = new Set<TransactionKind>([
  "cc_payment",
  "loan_payment",
])
const LIABILITY_COST_KINDS = new Set<TransactionKind>([
  "liability_fee",
  "liability_interest",
])

export function parseAccountType(value: string): AccountType {
  if (ACCOUNT_TYPE_SET.has(value)) return value as AccountType
  throw new Error(`Unsupported accountType ${value}`)
}

export function deriveTransferKindForAccounts({
  fromAccountType,
  toAccountType,
}: {
  fromAccountType: AccountType
  toAccountType: AccountType
}): TransferTransactionKind {
  if (toAccountType === "CREDIT") return "cc_payment"
  if (toAccountType === "LOAN") return "loan_payment"
  if (getAccountClassForType(fromAccountType) === "LIABILITY") {
    return "liability_draw"
  }
  return "funds_movement"
}

export function isLiabilityPrincipalPaymentKind(
  kind: string
): kind is "cc_payment" | "loan_payment" {
  return LIABILITY_PRINCIPAL_PAYMENT_KINDS.has(kind as TransactionKind)
}

export function isLiabilityBorrowingKind(
  kind: string
): kind is "liability_draw" {
  return kind === "liability_draw"
}

export function isLiabilityCostKind(
  kind: string
): kind is LiabilityCostTransactionKind {
  return LIABILITY_COST_KINDS.has(kind as TransactionKind)
}

export function isOrdinarySpendingTransaction({
  kind,
  type,
}: {
  kind: string
  type: string
}): boolean {
  return type === "expense" && kind === "standard"
}
