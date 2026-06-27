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
// `EXPORT_VERSION = 2`). `all.ndjson` is one JSON object per line under a stable
// envelope `{ "entity": <Name>, "data": { ...snake_case attributes } }`. v2-only
// entities (Balance/Transfer/Trade/Holding/RecurringTransaction/Rule) are
// OPTIONAL — a degraded/pre-v2 bundle simply omits them and the reader degrades
// gracefully (ADR-0041 §1/§5/§6). The synthetic fixture builder emits this exact
// shape; when a real bundle reveals a quirk we iterate the builder, never commit
// real data (ADR-0041 §11).
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

// Phase-1 entities the reader maps. Deferred v2 entities (Transfer, Trade,
// Holding, RecurringTransaction, Rule, Tag, Valuation, Budget, BudgetCategory)
// are retained in the raw bundle and counted as `ignoredEntities`, not parsed
// into typed rows — except `Transfer`, which we DO parse so the gating tests and
// the deferred Phase-1.5 transfer pairing have a typed source (ADR-0041 §10).
export const SURE_ENTITY = {
  account: "Account",
  balance: "Balance",
  category: "Category",
  merchant: "Merchant",
  transaction: "Transaction",
  transfer: "Transfer",
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
  // reconciled number, ADR-0041 §5). `start_balance` for the opening comes from
  // the Balance snapshot, not here.
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
  /** Lines rejected as malformed (bad JSON, bad envelope, or failed schema). */
  malformedLines: SureMalformedLine[]
  /** Deferred/unknown entity name → count (retained in the raw bundle only). */
  ignoredEntities: Record<string, number>
}

const ndjsonEnvelopeSchema = z.object({
  entity: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
})

interface EntitySink<T> {
  schema: z.ZodType<T>
  push: (value: T) => void
}

/**
 * Parse a Sure `all.ndjson` bundle one line at a time. Blank lines are skipped.
 * A line is rejected as malformed (collected, not thrown) when it is not valid
 * JSON, does not match the `{ entity, data }` envelope, or fails its entity
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
        reason: "missing { entity, data } envelope",
      })
      continue
    }

    const { entity, data } = envelope.data
    const sink = sinks[entity]
    if (!sink) {
      bundle.ignoredEntities[entity] = (bundle.ignoredEntities[entity] ?? 0) + 1
      continue
    }

    const parsed = sink.schema.safeParse(data)
    if (!parsed.success) {
      bundle.malformedLines.push({
        line: lineNumber,
        reason: `invalid ${entity}: ${parsed.error.issues[0]?.message ?? "schema error"}`,
      })
      continue
    }
    sink.push(parsed.data)
  }

  return bundle
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
