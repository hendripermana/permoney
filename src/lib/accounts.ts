export const ACCOUNT_CLASS_VALUES = ["ASSET", "LIABILITY"] as const

export type AccountClass = (typeof ACCOUNT_CLASS_VALUES)[number]

export const ACCOUNT_TYPE_VALUES = [
  "CASH",
  "DEPOSITORY",
  "E_WALLET",
  "CREDIT",
  "LOAN",
  "INVESTMENT",
  "RECEIVABLE",
  "TRACKED_ASSET",
] as const

export type AccountType = (typeof ACCOUNT_TYPE_VALUES)[number]

export const ACCOUNT_SUBTYPE_VALUES = [
  "cash",
  "checking",
  "savings",
  "payroll",
  "credit_card",
  "bnpl",
  "mortgage",
  "personal_loan",
  "payday_loan",
  "brokerage",
  "retirement",
  "crypto_wallet",
  "receivable",
  "gold",
  "silver",
  "vehicle",
  "real_estate",
  "generic_asset",
] as const

export type AccountSubtype = (typeof ACCOUNT_SUBTYPE_VALUES)[number]

/**
 * Whether an account's balance is driven by transaction flow (cash-like) or by
 * point-in-time valuations (tracked asset). This is the M2.5-4 cash-like vs
 * tracked-asset distinction (PER-75/PER-143). It is derived from `accountType`
 * so it can never drift from the ledger capability family: a `TRACKED_ASSET`
 * (property, vehicle, collectible) is valuation-driven; everything else posts
 * its balance from canonical `Transaction` rows. See docs/account-taxonomy.md
 * and ADR-0008 §6 (valuation snapshots).
 */
export const BALANCE_SOURCE_VALUES = ["transaction_flow", "valuation"] as const

export type BalanceSource = (typeof BALANCE_SOURCE_VALUES)[number]

export type AccountNormalBalance = {
  balanceSign: "negative" | "positive"
  side: "CREDIT" | "DEBIT"
}

export type AccountTaxonomy = {
  accountClass: AccountClass
  accountSubtype: string
  accountType: AccountType
  balanceSource: BalanceSource
}

export type AccountTaxonomyInput = {
  accountClass?: AccountClass
  accountSubtype?: string | null
  accountType: AccountType
}

const ASSET_ACCOUNT_TYPES = [
  "CASH",
  "DEPOSITORY",
  "E_WALLET",
  "INVESTMENT",
  "RECEIVABLE",
  "TRACKED_ASSET",
] as const satisfies readonly AccountType[]

const LIABILITY_ACCOUNT_TYPES = [
  "CREDIT",
  "LOAN",
] as const satisfies readonly AccountType[]
const LIABILITY_ACCOUNT_TYPE_SET = new Set<AccountType>(LIABILITY_ACCOUNT_TYPES)
const ASSET_ACCOUNT_TYPE_SET = new Set<AccountType>(ASSET_ACCOUNT_TYPES)

const ACCOUNT_TYPE_TO_CLASS = {
  CASH: "ASSET",
  CREDIT: "LIABILITY",
  DEPOSITORY: "ASSET",
  E_WALLET: "ASSET",
  INVESTMENT: "ASSET",
  LOAN: "LIABILITY",
  RECEIVABLE: "ASSET",
  TRACKED_ASSET: "ASSET",
} as const satisfies Record<AccountType, AccountClass>

const DEFAULT_ACCOUNT_SUBTYPE_BY_TYPE = {
  CASH: "cash",
  CREDIT: "credit_card",
  DEPOSITORY: "checking",
  E_WALLET: "cash",
  INVESTMENT: "brokerage",
  LOAN: "personal_loan",
  RECEIVABLE: "receivable",
  TRACKED_ASSET: "generic_asset",
} as const satisfies Record<AccountType, AccountSubtype>

const TRACKED_ASSET_ACCOUNT_TYPE: AccountType = "TRACKED_ASSET"

const NORMAL_BALANCE_BY_CLASS = {
  ASSET: {
    balanceSign: "positive",
    side: "DEBIT",
  },
  LIABILITY: {
    balanceSign: "negative",
    side: "CREDIT",
  },
} as const satisfies Record<AccountClass, AccountNormalBalance>

const ACCOUNT_SUBTYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export function getAccountClassForType(accountType: AccountType): AccountClass {
  return ACCOUNT_TYPE_TO_CLASS[accountType]
}

export function getAccountNormalBalance(
  accountClass: AccountClass
): AccountNormalBalance {
  return NORMAL_BALANCE_BY_CLASS[accountClass]
}

export function getDefaultAccountSubtype(
  accountType: AccountType
): AccountSubtype {
  return DEFAULT_ACCOUNT_SUBTYPE_BY_TYPE[accountType]
}

/**
 * Cash-like accounts post their balance from transaction flow; tracked assets
 * derive it from valuations. Derived from `accountType` so the flag is a pure
 * function of the ledger capability family and can never drift.
 */
export function getBalanceSourceForType(
  accountType: AccountType
): BalanceSource {
  return accountType === TRACKED_ASSET_ACCOUNT_TYPE
    ? "valuation"
    : "transaction_flow"
}

export function isCashLikeAccount(accountType: AccountType): boolean {
  return getBalanceSourceForType(accountType) === "transaction_flow"
}

export function isLiabilityAccountType(accountType: AccountType): boolean {
  return LIABILITY_ACCOUNT_TYPE_SET.has(accountType)
}

export function isAssetAccountType(accountType: AccountType): boolean {
  return ASSET_ACCOUNT_TYPE_SET.has(accountType)
}

export function normalizeAccountTaxonomy(
  input: AccountTaxonomyInput
): AccountTaxonomy {
  const expectedClass = getAccountClassForType(input.accountType)
  if (input.accountClass && input.accountClass !== expectedClass) {
    throw new Error(
      `Account type ${input.accountType} belongs to accountClass ${expectedClass}, not ${input.accountClass}`
    )
  }
  const accountSubtype =
    input.accountSubtype?.trim() || getDefaultAccountSubtype(input.accountType)
  if (!ACCOUNT_SUBTYPE_PATTERN.test(accountSubtype)) {
    throw new Error(
      `Account subtype ${accountSubtype} must be lowercase snake case`
    )
  }

  return {
    accountClass: expectedClass,
    accountSubtype,
    accountType: input.accountType,
    balanceSource: getBalanceSourceForType(input.accountType),
  }
}
