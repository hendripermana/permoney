// ============================================================================
// PER-170 / ADR-0041 — Sure full-family migration, pure reader utilities.
//
// Deterministic, side-effect-free building blocks of the Sure migration: the
// `all.ndjson` line parser (with malformed-line rejection), the Sure v2 entity
// Zod schemas, the Sure→Permoney account-type normalizer, the sign→type+abs
// classifier (the Sure sign inversion), and the parent-first category ordering.
//
// Server orchestration (account/category/merchant creation, id-maps, staging,
// promotion) lives in `src/server/sure-migration.ts` and calls into these. This
// module is the Sure specialization parallel to `src/lib/import-staging.ts`; it
// imports nothing from Prisma/Node so it stays client-safe and unit-testable.
//
// CONTRACT — the reader targets Sure export v2 (`Family::DataExporter`,
// `EXPORT_VERSION = 2`). `all.ndjson` is one JSON object per line under the
// stable envelope `{ "type": <Name>, "data": { ...snake_case attributes } }`.
// The discriminator key is `type` (verified against a real export, PER-173) —
// strictly `type`, never `entity` (the latter was a fixture fiction that made
// PER-170 reject 100% of real bundles). The real v2 entity inventory is
// Account/Category/Merchant/Transaction/Valuation/Budget/BudgetCategory/Tag;
// only the first four map to typed rows in Phase 1, the rest are retained as
// `ignoredEntities` (ADR-0041 §1/§5/§6). The synthetic fixture builder emits
// this exact shape; a hand-authored real-shape snippet (FAKE data) guards the
// envelope. We never commit a real export — it carries PII (ADR-0041 §11).
// ============================================================================

import { z } from "zod"
import type { CurrencyCode } from "./data/currencies"
import {
  type AccountTaxonomy,
  type AccountType,
  normalizeAccountTaxonomy,
} from "./accounts"
import { toMinorUnits } from "./money"

export const SURE_EXPORT_VERSION = 2
export const SURE_PROVIDER = "sure"

// ---------------------------------------------------------------------------
// Entity envelope + Zod schemas (Sure v2 attribute names — snake_case Rails)
// ---------------------------------------------------------------------------

// Phase-1 entities the reader maps to typed rows: Account/Category/Merchant/
// Transaction and — as of PER-174 — `Valuation`, the real-export opening-balance
// source (ADR-0041 §5). Other real v2 entities (Budget, BudgetCategory, Tag, …)
// are retained in the raw bundle and counted as `ignoredEntities`, not parsed
// into typed rows this phase. `Balance` and `Transfer` schemas/sinks are
// retained for forward-compatibility but are DORMANT against real exports: a
// real Sure v2 export emits neither (verified PER-173) — opening balances come
// from `Valuation` (`kind=opening_anchor` when present, else an earliest-by-date
// heuristic — §5), transfers from the txn `kind` field. They stay so a non-Sure
// or future bundle that does carry them still parses, with a typed source.
export const SURE_ENTITY = {
  account: "Account",
  balance: "Balance",
  category: "Category",
  merchant: "Merchant",
  transaction: "Transaction",
  transfer: "Transfer",
  valuation: "Valuation",
} as const

// Sure stores money as a decimal STRING ("17000.0"); accept a number too and
// canonicalize to the clean decimal string `toMinorUnits` expects.
const sureDecimalSchema = z
  .union([z.string(), z.number()])
  .transform((value) =>
    typeof value === "number" ? String(value) : value.trim()
  )
  .refine((value) => /^-?\d+(\.\d+)?$/.test(value), "malformed decimal amount")

// Sure `accountable_type` discriminator (STI class name). Unknown values are
// tolerated by `normalizeSureAccountType` (conservative fallback), so the schema
// keeps it a free string rather than an enum.
export const sureAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountable_type: z.string().min(1),
  classification: z.enum(["asset", "liability"]).nullable().optional(),
  subtype: z.string().nullable().optional(),
  currency: z.string().min(3).max(3),
  // Sure's reported balances — retained as provenance ONLY (never written as a
  // reconciled number, ADR-0041 §5). The opening balance comes from a
  // `Valuation` (`opening_anchor`, else earliest-by-date heuristic), not here.
  balance: sureDecimalSchema.nullable().optional(),
  cash_balance: sureDecimalSchema.nullable().optional(),
})
export type SureAccount = z.infer<typeof sureAccountSchema>

export const sureBalanceSchema = z.object({
  account_id: z.string().min(1),
  date: z.string().min(1),
  start_balance: sureDecimalSchema.nullable().optional(),
  end_balance: sureDecimalSchema.nullable().optional(),
})
export type SureBalance = z.infer<typeof sureBalanceSchema>

// A Sure `Valuation` is a point-in-time TOTAL account value anchor (an `Entry`
// whose `entryable` is a Valuation). Its `kind` ∈ {opening_anchor, current_anchor,
// reconciliation} (verified against `valuation.rb` + `data_exporter.rb`, export
// v2). In Sure's `Balance::ForwardCalculator` a valuation OVERRIDES the computed
// balance on its date — so `amount` is the absolute value at `date`, NOT a
// pre-history opening (treating it as one and adding Σtxns double-counts; §5).
//
// `kind` is a TOLERANT string, never an enum: an unknown future kind must not
// reject the row — only `opening_anchor` is matched. A real degraded export
// (the user's) omits `kind` entirely; the orchestrator detects that globally
// (`bundleHasValuationKind`) and falls back to the earliest-by-date heuristic
// (§5). `account_id` is REQUIRED — every opening decision groups by it.
export const sureValuationSchema = z.object({
  account_id: z.string().min(1),
  amount: sureDecimalSchema,
  currency: z.string().min(3).max(3),
  date: z.string().min(1),
  entry_id: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
})
export type SureValuation = z.infer<typeof sureValuationSchema>

export const sureCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  classification: z.enum(["expense", "income"]),
  color: z.string().nullable().optional(),
  lucide_icon: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
})
export type SureCategory = z.infer<typeof sureCategorySchema>

export const sureMerchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().nullable().optional(),
  logo_url: z.string().nullable().optional(),
})
export type SureMerchant = z.infer<typeof sureMerchantSchema>

// Sure transaction `kind`. `standard` is the only promotable kind in Phase 1;
// the transfer kinds are HELD (ADR-0041 §6). Free string for forward-compat.
export const sureTransactionSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  category_id: z.string().nullable().optional(),
  merchant_id: z.string().nullable().optional(),
  date: z.string().min(1),
  // Sign convention: Sure stores outflow/expense POSITIVE, inflow/income
  // NEGATIVE (inverted vs Permoney). See `classifySureAmount`.
  amount: sureDecimalSchema,
  currency: z.string().min(3).max(3),
  name: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  excluded: z.boolean().nullable().optional(),
  tag_ids: z.array(z.string()).nullable().optional(),
  // v2 embedded splits — OUT OF SCOPE Phase 1 (held). Presence flags a split
  // parent; contents are retained in rawPayload, not parsed into Permoney rows.
  split_lines: z.array(z.unknown()).nullable().optional(),
})
export type SureTransaction = z.infer<typeof sureTransactionSchema>

export const sureTransferSchema = z.object({
  id: z.string().min(1),
  inflow_transaction_id: z.string().min(1),
  outflow_transaction_id: z.string().min(1),
  status: z.string().nullable().optional(),
})
export type SureTransfer = z.infer<typeof sureTransferSchema>

// ---------------------------------------------------------------------------
// NDJSON parse (per-line, malformed-line rejection — ADR-0041 §1)
// ---------------------------------------------------------------------------

export interface SureMalformedLine {
  line: number // 1-based source line number
  reason: string
}

export interface ParsedSureBundle {
  accounts: SureAccount[]
  balances: SureBalance[]
  categories: SureCategory[]
  merchants: SureMerchant[]
  transactions: SureTransaction[]
  transfers: SureTransfer[]
  /** Point-in-time account-value anchors — the opening-balance source (§5). */
  valuations: SureValuation[]
  /** Lines rejected as malformed (bad JSON, bad envelope, or failed schema). */
  malformedLines: SureMalformedLine[]
  /** Deferred/unknown entity name → count (retained in the raw bundle only). */
  ignoredEntities: Record<string, number>
}

// Real Sure exports key the discriminator as `type` (verified PER-173). STRICT:
// we read `type` only — never `entity` — so the contract stays unambiguous
// (CLAUDE.md "Strict Contracts"); a line without a string `type` is malformed.
const ndjsonEnvelopeSchema = z.object({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
})

interface EntitySink<T> {
  schema: z.ZodType<T>
  push: (value: T) => void
}

/**
 * Parse a Sure `all.ndjson` bundle one line at a time. Blank lines are skipped.
 * A line is rejected as malformed (collected, not thrown) when it is not valid
 * JSON, does not match the `{ type, data }` envelope, or fails its entity
 * schema. Known but deferred entities are counted in `ignoredEntities` and
 * retained only in the raw bundle. The parse never throws on row-level problems
 * so one corrupt line can never abort a multi-thousand-row migration; the
 * orchestrator decides how to surface `malformedLines`.
 */
export function parseSureBundle(content: string): ParsedSureBundle {
  const bundle: ParsedSureBundle = {
    accounts: [],
    balances: [],
    categories: [],
    merchants: [],
    transactions: [],
    transfers: [],
    valuations: [],
    malformedLines: [],
    ignoredEntities: {},
  }

  const sinks: Record<string, EntitySink<unknown>> = {
    [SURE_ENTITY.account]: {
      schema: sureAccountSchema,
      push: (v) => bundle.accounts.push(v as SureAccount),
    },
    [SURE_ENTITY.balance]: {
      schema: sureBalanceSchema,
      push: (v) => bundle.balances.push(v as SureBalance),
    },
    [SURE_ENTITY.category]: {
      schema: sureCategorySchema,
      push: (v) => bundle.categories.push(v as SureCategory),
    },
    [SURE_ENTITY.merchant]: {
      schema: sureMerchantSchema,
      push: (v) => bundle.merchants.push(v as SureMerchant),
    },
    [SURE_ENTITY.transaction]: {
      schema: sureTransactionSchema,
      push: (v) => bundle.transactions.push(v as SureTransaction),
    },
    [SURE_ENTITY.transfer]: {
      schema: sureTransferSchema,
      push: (v) => bundle.transfers.push(v as SureTransfer),
    },
    [SURE_ENTITY.valuation]: {
      schema: sureValuationSchema,
      push: (v) => bundle.valuations.push(v as SureValuation),
    },
  }

  const lines = content.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const raw = lines[index]?.trim() ?? ""
    if (raw === "") continue

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      bundle.malformedLines.push({ line: lineNumber, reason: "invalid JSON" })
      continue
    }

    const envelope = ndjsonEnvelopeSchema.safeParse(json)
    if (!envelope.success) {
      bundle.malformedLines.push({
        line: lineNumber,
        reason: "missing { type, data } envelope",
      })
      continue
    }

    const { type: entityType, data } = envelope.data
    const sink = sinks[entityType]
    if (!sink) {
      bundle.ignoredEntities[entityType] =
        (bundle.ignoredEntities[entityType] ?? 0) + 1
      continue
    }

    const parsed = sink.schema.safeParse(data)
    if (!parsed.success) {
      bundle.malformedLines.push({
        line: lineNumber,
        reason: `invalid ${entityType}: ${parsed.error.issues[0]?.message ?? "schema error"}`,
      })
      continue
    }
    sink.push(parsed.data)
  }

  return bundle
}

/**
 * Does this bundle "speak `kind`"? True when ANY valuation row carries a
 * non-empty (trimmed) `kind`. This is a GLOBAL, per-bundle signal — a real v2
 * export writes `kind` on every valuation, a degraded export omits it entirely,
 * so the two never mix in practice. When true, `kind` is authoritative for the
 * whole bundle: an account with no `opening_anchor` is a gap (0), NEVER guessed
 * via the date heuristic (ADR-0041 §5). A serialized empty string (`kind: ""`)
 * counts as absent, so a stray blank never flips a degraded export into kind-mode.
 */
export function bundleHasValuationKind(
  valuations: readonly SureValuation[]
): boolean {
  return valuations.some(
    (v) => typeof v.kind === "string" && v.kind.trim() !== ""
  )
}

// ---------------------------------------------------------------------------
// Account type normalization (Sure accountable_type → Permoney taxonomy §2)
// ---------------------------------------------------------------------------

export interface NormalizedSureAccount extends AccountTaxonomy {
  /** Phase-1 promotion gate: only importable accounts have rows promoted. */
  isImportable: boolean
}

interface SureAccountTypeRule {
  accountType: AccountType
  isImportable: boolean
  /** Sure `subtype` → Permoney subtype overrides; else `defaultSubtype`. */
  subtypeMap?: Record<string, string>
  defaultSubtype: string
}

// ADR-0041 §2. `accountClass` + `balanceSource` are derived downstream by
// `normalizeAccountTaxonomy` (pure function of `accountType`) so they can NEVER
// drift from Sure-copied values. Investment is transaction_flow in the taxonomy
// but HELD in Phase 1 (its meaningful postings are Trades/Holdings, PER-150);
// PreciousMetal/OtherAsset are valuation-driven TRACKED_ASSET (PER-146).
const SURE_ACCOUNT_TYPE_RULES: Record<string, SureAccountTypeRule> = {
  Depository: {
    accountType: "DEPOSITORY",
    isImportable: true,
    subtypeMap: {
      savings: "savings",
      checking: "checking",
      cooperative: "cooperative",
    },
    defaultSubtype: "checking",
  },
  CreditCard: {
    accountType: "CREDIT",
    isImportable: true,
    defaultSubtype: "credit_card",
  },
  Loan: {
    accountType: "LOAN",
    isImportable: true,
    defaultSubtype: "personal_loan",
  },
  Investment: {
    accountType: "INVESTMENT",
    isImportable: false,
    subtypeMap: {
      mutual_fund: "mutual_fund",
      cooperative_share: "cooperative_share",
    },
    defaultSubtype: "brokerage",
  },
  PreciousMetal: {
    accountType: "TRACKED_ASSET",
    isImportable: false,
    defaultSubtype: "gold",
  },
  OtherAsset: {
    accountType: "TRACKED_ASSET",
    isImportable: false,
    defaultSubtype: "generic_asset",
  },
}

// Conservative fallback for an unknown `accountable_type`: a cash-like
// depository/checking shell (ADR-0041 §2). Cash-like and importable so its plain
// flow rows still promote; the account shell always exists so refs resolve.
const SURE_ACCOUNT_FALLBACK: SureAccountTypeRule = {
  accountType: "DEPOSITORY",
  isImportable: true,
  defaultSubtype: "checking",
}

/**
 * Normalize a Sure `accountable_type` (+ `subtype`) into Permoney taxonomy plus
 * the Phase-1 `isImportable` gate. `accountClass`/`balanceSource` come from
 * `normalizeAccountTaxonomy`, so this can never produce an inconsistent taxonomy.
 */
export function normalizeSureAccountType(
  accountableType: string,
  subtype?: string | null
): NormalizedSureAccount {
  const rule = SURE_ACCOUNT_TYPE_RULES[accountableType] ?? SURE_ACCOUNT_FALLBACK
  const key = subtype?.trim().toLowerCase()
  const mappedSubtype = (key && rule.subtypeMap?.[key]) || rule.defaultSubtype
  const taxonomy = normalizeAccountTaxonomy({
    accountType: rule.accountType,
    accountSubtype: mappedSubtype,
  })
  return { ...taxonomy, isImportable: rule.isImportable }
}

// ---------------------------------------------------------------------------
// Sign → type + abs amount (the Sure inversion — ADR-0041 §4.C)
// ---------------------------------------------------------------------------

export interface ClassifiedSureAmount {
  /** Permoney row type; PER-82 re-signs at promote (expense→neg, income→pos). */
  type: "income" | "expense"
  /** Absolute minor units, ready for the PER-82 `StagedRowInput.amount` seam. */
  absMinorUnits: bigint
  /** Sure amount was exactly 0 → classified as expense and flagged for review. */
  isZeroAmount: boolean
}

/**
 * Convert a Sure entry amount (outflow/expense POSITIVE, inflow/income NEGATIVE)
 * into a Permoney `(type, abs)` pair in the target account's currency. This is a
 * pure CLASSIFICATION, not a sign hack — PER-82 re-derives the signed ledger
 * amount from `type` + abs at promote. `0` is classified as `expense` and
 * flagged (`isZeroAmount`) so the orchestrator can surface it for review.
 */
export function classifySureAmount(
  amount: string,
  currency: CurrencyCode
): ClassifiedSureAmount {
  const minor = toMinorUnits(amount, currency) as bigint
  const isZeroAmount = minor === 0n
  // Sure: outflow > 0 → expense; inflow < 0 → income; 0 → expense (flagged).
  const type = minor >= 0n ? "expense" : "income"
  const absMinorUnits = minor < 0n ? -minor : minor
  return { type, absMinorUnits, isZeroAmount }
}

// ---------------------------------------------------------------------------
// Pre-confirm preview summary (PER-171 — client-side mirror of the gates)
// ---------------------------------------------------------------------------

// The guided importer's preview is computed in the browser by running THIS same
// reader on the uploaded bundle, because the migration server fn commits in one
// shot (no server dry-run). To keep the preview honest, the held classification
// below mirrors the orchestrator's `isPromotable` gate (src/server/sure-migration.ts)
// branch-for-branch and with the SAME precedence, so the previewed counts agree
// with the authoritative SureMigrationResult after promotion. The parity is
// pinned by a unit test against the synthetic v2 fixture manifest.

/** A held transaction's single primary reason (assigned with isPromotable's precedence). */
export type SureHeldReason =
  | "transfer"
  | "nonImportableAccount"
  | "currencyMismatch"
  | "split"

export interface SurePreviewAccount extends NormalizedSureAccount {
  currency: string
}

/** An account's Phase-1 promotion eligibility (mirror of isPromotable's account gate). */
function isImportableSureAccount(account: NormalizedSureAccount): boolean {
  return account.isImportable && account.balanceSource === "transaction_flow"
}

/**
 * Why a staged Sure transaction is held in Phase 1, or `null` if it will promote.
 * Precedence matches the server's `isPromotable`: non-standard kind, then a
 * non-importable account, then a currency mismatch, then a split parent.
 */
export function sureHeldReason(
  txn: SureTransaction,
  account: SurePreviewAccount
): SureHeldReason | null {
  const kind = (txn.kind ?? "standard").trim() || "standard"
  if (kind !== "standard") return "transfer"
  if (!isImportableSureAccount(account)) return "nonImportableAccount"
  if (txn.currency !== account.currency) return "currencyMismatch"
  if (txn.split_lines && txn.split_lines.length > 0) return "split"
  return null
}

export interface SureBundlePreview {
  accounts: { total: number; importable: number; held: number }
  categories: number
  merchants: number
  transactions: {
    total: number
    /** Standard rows on importable, currency-matching accounts — become ledger txns. */
    promotable: number
    /** Staged but held this phase (sum of `heldByReason`). */
    held: number
    heldByReason: Record<SureHeldReason, number>
    /** Zero-amount rows — retained in the artifact, not stageable (ADR-0041 §4.C). */
    zeroAmountSkipped: number
    /** Unparseable dates — retained in the artifact, not staged. */
    invalidDateSkipped: number
    /** Rows whose account is absent from the bundle (degraded export). */
    unmappable: number
  }
  /** Typed Transfer rows (deferred Phase-2 pairing source). */
  transfers: number
  /** Typed Valuation rows — the opening-balance source (ADR-0041 §5). */
  valuations: number
  malformedLines: number
  ignoredEntities: Record<string, number>
}

/**
 * Summarize a parsed Sure bundle into the honest "what will be created vs held"
 * counts the guided importer previews before the user confirms. This is a pure
 * mirror of the orchestrator's staging gates; the post-promote screen replaces
 * these estimates with the authoritative server result.
 */
export function summarizeSureBundle(
  bundle: ParsedSureBundle
): SureBundlePreview {
  const accountById = new Map<string, SurePreviewAccount>()
  let importableAccounts = 0
  for (const account of bundle.accounts) {
    const normalized: SurePreviewAccount = {
      ...normalizeSureAccountType(account.accountable_type, account.subtype),
      currency: account.currency,
    }
    accountById.set(account.id, normalized)
    if (isImportableSureAccount(normalized)) importableAccounts += 1
  }

  const heldByReason: Record<SureHeldReason, number> = {
    transfer: 0,
    nonImportableAccount: 0,
    currencyMismatch: 0,
    split: 0,
  }
  let promotable = 0
  let held = 0
  let zeroAmountSkipped = 0
  let invalidDateSkipped = 0
  let unmappable = 0

  for (const txn of bundle.transactions) {
    const account = accountById.get(txn.account_id)
    if (!account) {
      unmappable += 1
      continue
    }
    if (Number.isNaN(new Date(txn.date).getTime())) {
      invalidDateSkipped += 1
      continue
    }
    const { isZeroAmount } = classifySureAmount(
      txn.amount,
      account.currency as CurrencyCode
    )
    if (isZeroAmount) {
      zeroAmountSkipped += 1
      continue
    }
    const reason = sureHeldReason(txn, account)
    if (reason === null) {
      promotable += 1
      continue
    }
    heldByReason[reason] += 1
    held += 1
  }

  return {
    accounts: {
      total: bundle.accounts.length,
      importable: importableAccounts,
      held: bundle.accounts.length - importableAccounts,
    },
    categories: bundle.categories.length,
    merchants: bundle.merchants.length,
    transactions: {
      total: bundle.transactions.length,
      promotable,
      held,
      heldByReason,
      zeroAmountSkipped,
      invalidDateSkipped,
      unmappable,
    },
    transfers: bundle.transfers.length,
    valuations: bundle.valuations.length,
    malformedLines: bundle.malformedLines.length,
    ignoredEntities: bundle.ignoredEntities,
  }
}

// ---------------------------------------------------------------------------
// Category parent-first ordering (two-pass remap support — ADR-0041 §3)
// ---------------------------------------------------------------------------

/**
 * Order Sure categories so every parent precedes its children, letting the
 * orchestrator build the id-map in one forward pass (a child's `parent_id`
 * always resolves). Roots — categories with no `parent_id`, or whose parent is
 * absent from the bundle (degraded export) — come first. Any cycle (Sure should
 * never emit one) is broken deterministically by emitting the remaining nodes in
 * stable input order, so the function is total and never loops.
 */
export function orderCategoriesParentsFirst(
  categories: readonly SureCategory[]
): SureCategory[] {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const ordered: SureCategory[] = []
  const placed = new Set<string>()

  const place = (category: SureCategory, guard: Set<string>): void => {
    if (placed.has(category.id)) return
    const parentId = category.parent_id ?? null
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent && !placed.has(parent.id) && !guard.has(category.id)) {
      guard.add(category.id)
      place(parent, guard)
    }
    if (placed.has(category.id)) return
    ordered.push(category)
    placed.add(category.id)
  }

  for (const category of categories) place(category, new Set())
  return ordered
}
