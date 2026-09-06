import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { decodeMoney, encodeMoney } from "@/lib/money"
import {
  computeBudgetProgress,
  foldRolloverCarry,
  type BudgetAllocationInput,
  type BudgetLedgerRowInput,
  type BudgetProgress,
} from "@/lib/budget-progress"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { getFamilyBaseCurrency } from "./fx"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import { isUniqueConstraintError, uuidV7Schema } from "./mutation-kit"

// =============================================================================
// PER-148 / ADR-0037 — Budgets vertical slice.
//
// A `Budget` is a concrete tenant-scoped PERIOD INSTANCE (monthly built). Its
// only durable money is the per-category allocation; actual/remaining/over are
// derived read-side from the canonical ledger via the materialized `baseAmount`
// projection (ADR-0035) and the pure `computeBudgetProgress` engine.
//
// Writes obey the ledger mutation boundary (AGENTS.md §5A): one tenant
// transaction (app.family_id + app.user_id GUCs), tenant-owned/system category
// validation, `IdempotencyRecord` replay, and an append-only `AuditLog` row in
// the same tx. Reads/writes are not balance mutations, so there is no
// Account.balance delta. Authorization: read = any active member; write =
// `requireCapability("budget:write")`.
// =============================================================================

const PERIOD_KIND_MONTHLY = "monthly"
const SET_ALLOCATIONS_ENDPOINT = "setBudgetAllocationsFn"
const ARCHIVE_BUDGET_ENDPOINT = "archiveBudgetFn"
const MOVE_ALLOCATION_ENDPOINT = "moveBudgetAllocationFn"

export class BudgetValidationError extends Error {
  override readonly name = "BudgetValidationError"
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
  }
}

export class BudgetNotFoundError extends Error {
  override readonly name = "BudgetNotFoundError"
  readonly statusCode = 404
  constructor(message = "Budget not found for this period") {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Period helpers (monthly only this slice). All date-only, family-tz anchored.
// ---------------------------------------------------------------------------

const monthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")

interface MonthlyPeriod {
  periodStart: Date // @db.Date — first of month (UTC midnight)
  periodEnd: Date // @db.Date — last day of month (UTC midnight)
  start: string // YYYY-MM-DD
  end: string // YYYY-MM-DD
}

function monthlyPeriod(month: string): MonthlyPeriod {
  const [yearStr, monthStr] = month.split("-")
  const year = Number(yearStr)
  const monthIndex = Number(monthStr) - 1
  const periodStart = new Date(Date.UTC(year, monthIndex, 1))
  // Day 0 of the next month == last day of this month.
  const periodEnd = new Date(Date.UTC(year, monthIndex + 1, 0))
  return {
    periodStart,
    periodEnd,
    start: periodStart.toISOString().slice(0, 10),
    end: periodEnd.toISOString().slice(0, 10),
  }
}

function defaultBudgetName(month: string): string {
  const period = monthlyPeriod(month)
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(period.periodStart)
}

/** Current month (YYYY-MM) resolved in the family's timezone, not the server's. */
function currentMonthInZone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).format(new Date())
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedBudgetCategoryProgress {
  categoryId: string
  categoryName: string
  categoryColor: string
  categoryIcon: string
  /** Raw per-period fact — never includes rollover. */
  allocatedAmount: string
  /** 'none' | 'carryover' (PER-278 / ADR-0037 §2 follow-up). */
  rolloverPolicy: string
  /** Carry-in from prior periods; "0" when `rolloverPolicy` is `"none"`. */
  rolledOverAmount: string
  /** `allocatedAmount + rolledOverAmount` — what this category has to spend. */
  effectiveAllocatedAmount: string
  actualAmount: string
  remainingAmount: string
  isOver: boolean
  pendingCount: number
}

export interface SerializedBudgetProgress {
  budgetId: string | null
  name: string
  /** Resolved period as YYYY-MM (family-tz current month when none requested). */
  month: string
  periodKind: string
  periodStart: string
  periodEnd: string
  currency: string
  baseCurrency: string
  timezone: string
  archivedAt: string | null
  categories: SerializedBudgetCategoryProgress[]
  uncategorized: { actualAmount: string; pendingCount: number }
  totals: {
    allocatedAmount: string
    rolledOverAmount: string
    actualAmount: string
    remainingAmount: string
    isOver: boolean
    pendingTransactionCount: number
  }
}

export interface SerializedBudgetSummary {
  budgetId: string
  name: string
  periodKind: string
  periodStart: string
  periodEnd: string
  currency: string
  archivedAt: string | null
}

interface CategoryMeta {
  name: string
  color: string
  icon: string
  rolloverPolicy: string
}

function serializeProgress(
  progress: BudgetProgress,
  meta: {
    budgetId: string | null
    name: string
    month: string
    periodKind: string
    periodStart: string
    periodEnd: string
    currency: string
    baseCurrency: string
    timezone: string
    archivedAt: Date | null
    categoryMeta: Map<string, CategoryMeta>
  }
): SerializedBudgetProgress {
  return {
    budgetId: meta.budgetId,
    name: meta.name,
    month: meta.month,
    periodKind: meta.periodKind,
    periodStart: meta.periodStart,
    periodEnd: meta.periodEnd,
    currency: meta.currency,
    baseCurrency: meta.baseCurrency,
    timezone: meta.timezone,
    archivedAt: meta.archivedAt?.toISOString() ?? null,
    categories: progress.categories.map((category) => {
      const info = meta.categoryMeta.get(category.categoryId)
      return {
        categoryId: category.categoryId,
        categoryName: info?.name ?? "Unknown category",
        categoryColor: info?.color ?? "#6172F3",
        categoryIcon: info?.icon ?? "shapes",
        allocatedAmount: encodeMoney(category.allocatedAmount),
        rolloverPolicy: info?.rolloverPolicy ?? "none",
        rolledOverAmount: encodeMoney(category.rolledOverAmount),
        effectiveAllocatedAmount: encodeMoney(
          category.effectiveAllocatedAmount
        ),
        actualAmount: encodeMoney(category.actualAmount),
        remainingAmount: encodeMoney(category.remainingAmount),
        isOver: category.isOver,
        pendingCount: category.pendingCount,
      }
    }),
    uncategorized: {
      actualAmount: encodeMoney(progress.uncategorized.actualAmount),
      pendingCount: progress.uncategorized.pendingCount,
    },
    totals: {
      allocatedAmount: encodeMoney(progress.totals.allocatedAmount),
      rolledOverAmount: encodeMoney(progress.totals.rolledOverAmount),
      actualAmount: encodeMoney(progress.totals.actualAmount),
      remainingAmount: encodeMoney(progress.totals.remainingAmount),
      isOver: progress.totals.isOver,
      pendingTransactionCount: progress.totals.pendingTransactionCount,
    },
  }
}

// ---------------------------------------------------------------------------
// Ledger fetch + progress computation (shared by read + write read-back).
// ---------------------------------------------------------------------------

interface BudgetRowWithCategories {
  id: string
  name: string
  periodStart: Date
  periodEnd: Date
  currency: string
  archivedAt: Date | null
  categories: {
    categoryId: string
    allocatedAmount: bigint
    rolloverPolicy: string
    category: { name: string; color: string; icon: string }
  }[]
}

async function loadBudgetRow(
  tx: TenantTransactionClient,
  familyId: string,
  periodStart: Date
): Promise<BudgetRowWithCategories | null> {
  return await tx.budget.findUnique({
    where: {
      budget_family_period_unique: {
        familyId,
        periodKind: PERIOD_KIND_MONTHLY,
        periodStart,
      },
    },
    select: {
      id: true,
      name: true,
      periodStart: true,
      periodEnd: true,
      currency: true,
      archivedAt: true,
      categories: {
        orderBy: { category: { name: "asc" } },
        select: {
          categoryId: true,
          allocatedAmount: true,
          rolloverPolicy: true,
          category: { select: { name: true, color: true, icon: true } },
        },
      },
    },
  })
}

/**
 * Fetches canonical, non-excluded, non-deleted ledger rows in `[rangeStart,
 * rangeEnd)` (UTC instant bounds — a coarse prefilter; the pure engine does
 * exact family-tz bucketing per period). Ordinary expense rows PLUS
 * reimbursement/refund income rows (PER-260 / ADR-0055) only — a
 * reimbursement is an income row assigned an EXPENSE-type category so it
 * nets against that category's "spent" figure, the same net figure the
 * Spending report (`cash-flow.ts`) already shows for that category. No
 * categoryId filter — `computeBudgetProgress` only surfaces contributions for
 * allocated categories in its output.
 *
 * Shared by the current-period read (`fetchPeriodLedgerRows`, one call) and
 * the rollover chain resolver (`resolveRolloverCarryIn`, one call spanning
 * however many historical periods a category's carryover chain covers) —
 * bucketing per period happens in `computeBudgetProgress`, not here, so one
 * wide fetch safely serves several period computations.
 */
async function fetchLedgerRowsInRange(
  tx: TenantTransactionClient,
  familyId: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<BudgetLedgerRowInput[]> {
  const rows = await tx.transaction.findMany({
    where: {
      familyId,
      deletedAt: null,
      excluded: false,
      date: { gte: rangeStart, lt: rangeEnd },
      OR: [{ type: "expense" }, { type: "income", kind: "reimbursement" }],
    },
    select: {
      type: true,
      currency: true,
      baseCurrency: true,
      fxRateScaled: true,
      baseAmount: true,
      date: true,
      isSplit: true,
      categoryId: true,
      splitEntries: { select: { categoryId: true, amount: true } },
    },
  })

  return rows.map((row) => ({
    // Narrowed by the `where` filter above; the DB CHECK guarantees the domain.
    type: row.type as "expense" | "income",
    currency: row.currency,
    baseCurrency: row.baseCurrency,
    fxRateScaled: row.fxRateScaled,
    baseAmount: row.baseAmount,
    date: row.date,
    isSplit: row.isSplit,
    categoryId: row.categoryId,
    splitEntries: row.splitEntries.map((entry) => ({
      categoryId: entry.categoryId,
      amount: entry.amount,
    })),
  }))
}

async function fetchPeriodLedgerRows(
  tx: TenantTransactionClient,
  familyId: string,
  period: MonthlyPeriod
): Promise<BudgetLedgerRowInput[]> {
  const rangeStart = new Date(period.periodStart)
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 1)
  const rangeEnd = new Date(period.periodEnd)
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 2)
  return fetchLedgerRowsInRange(tx, familyId, rangeStart, rangeEnd)
}

function dateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Resolves the read-time rollover carry-in for a set of `"carryover"`
 * categories in the period starting at `targetPeriodStart` (PER-278 /
 * ADR-0037 §2 follow-up).
 *
 * Deliberately READ-TIME DERIVED, not materialized like Sure's
 * `Budget::RolloverCalculator` (which stores `rolled_over_amount` and
 * recomputes a forward chain under an advisory lock whenever a budget is
 * bootstrapped or an allocation changes). Permoney's whole budget-progress
 * contract is already "pure function over the canonical ledger... trivially
 * correct under reclassification" (ADR-0037 consequences) — editing a
 * transaction in a closed historical month must retroactively correct that
 * month's actual/remaining with NO explicit rebuild step. A materialized
 * carry would silently drift the moment a past transaction is edited unless
 * every transaction mutation path also re-triggered a chain recompute for
 * every affected category — real coupling into the transaction mutation hot
 * path that Sure accepts (hence the advisory lock to avoid concurrent-
 * recompute races) and this slice does not need to. The tradeoff: this walks
 * O(chain depth) historical periods per carryover category on every budget
 * read instead of O(1). Budget reads are already documented as low-frequency
 * (ADR-0037 §9) and rollover is opt-in per category, so this is accepted for
 * v1; if it becomes a hot path, materializing is the natural follow-up (the
 * math — `foldRolloverCarry` — does not change either way).
 *
 * Chain-walk rules (verified against Sure's real
 * `budget/rollover_calculator.rb`, not just ADR-0037's placeholder text):
 *   - Walk each category's periods strictly BEFORE `targetPeriodStart`,
 *     newest → oldest, collecting a prefix while `rolloverPolicy ===
 *     "carryover"`; stop (exclude) at the first period whose policy is
 *     `"none"` — that period's own surplus never left it, mirroring Sure's
 *     "switching the toggle off stops the money in both directions."
 *   - A month with NO `Budget` row, or a `Budget` with no `BudgetCategory` row
 *     for this category, is a genuine GAP, not a zero — it is simply absent
 *     from the query result and the walk continues past it untouched
 *     (Sure: "a month the user never set up is a gap in the chain").
 *   - The first period a category was ever budgeted with `"carryover"` has an
 *     empty prefix before it, so its carry-in is 0 — chain seeding needs no
 *     special case.
 */
interface RolloverChainRow {
  categoryId: string
  allocatedAmount: bigint
  rolloverPolicy: string
  budget: { periodStart: Date; periodEnd: Date }
}

interface ChainPeriod {
  periodStart: Date
  periodEnd: Date
  allocatedAmount: bigint
}

interface RolloverChains {
  chains: Map<string, ChainPeriod[]>
  earliestStart: Date | null
  latestEnd: Date | null
}

function groupByCategoryId(
  rows: RolloverChainRow[]
): Map<string, RolloverChainRow[]> {
  const byCategory = new Map<string, RolloverChainRow[]>()
  for (const row of rows) {
    const list = byCategory.get(row.categoryId)
    if (list) list.push(row)
    else byCategory.set(row.categoryId, [row])
  }
  return byCategory
}

/** One category's newest→oldest rows to its oldest→newest `"carryover"`
 * prefix, stopping at the first `"none"` row (a wall — see the caller's
 * doc comment). Empty when the period immediately before the target isn't
 * itself `"carryover"`. */
function carryoverPrefix(rows: RolloverChainRow[]): ChainPeriod[] {
  const prefix: ChainPeriod[] = []
  for (const row of rows) {
    if (row.rolloverPolicy !== "carryover") break
    prefix.push({
      periodStart: row.budget.periodStart,
      periodEnd: row.budget.periodEnd,
      allocatedAmount: row.allocatedAmount,
    })
  }
  prefix.reverse() // oldest -> newest, ending just before the target period
  return prefix
}

/** Builds each category's carryover chain plus the combined date span the
 * chains cover — a single ledger fetch (by the caller) can then serve every
 * chain's per-period actuals. */
function buildRolloverChains(rows: RolloverChainRow[]): RolloverChains {
  const chains = new Map<string, ChainPeriod[]>()
  let earliestStart: Date | null = null
  let latestEnd: Date | null = null

  for (const [categoryId, categoryRows] of groupByCategoryId(rows)) {
    const prefix = carryoverPrefix(categoryRows)
    if (prefix.length === 0) continue
    chains.set(categoryId, prefix)
    const first = prefix.at(0)
    const last = prefix.at(-1)
    if (
      first &&
      (earliestStart === null || first.periodStart < earliestStart)
    ) {
      earliestStart = first.periodStart
    }
    if (last && (latestEnd === null || last.periodEnd > latestEnd)) {
      latestEnd = last.periodEnd
    }
  }

  return { chains, earliestStart, latestEnd }
}

/** One category's carry-in: each historical period's actual is derived fresh
 * from `rangeRows` via the same pure engine used everywhere else (no
 * separate accounting path), then folded per `foldRolloverCarry`. */
function foldChainCarryIn(
  categoryId: string,
  chain: ChainPeriod[],
  rangeRows: BudgetLedgerRowInput[],
  timezone: string
): bigint {
  const foldInputs = chain.map((histPeriod) => {
    const historicalProgress = computeBudgetProgress({
      allocations: [
        { categoryId, allocatedAmount: histPeriod.allocatedAmount },
      ],
      transactions: rangeRows,
      period: {
        start: dateOnlyString(histPeriod.periodStart),
        end: dateOnlyString(histPeriod.periodEnd),
        timezone,
      },
    })
    return {
      allocatedAmount: histPeriod.allocatedAmount,
      actualAmount: historicalProgress.categories[0]?.actualAmount ?? 0n,
    }
  })
  return foldRolloverCarry(foldInputs)
}

async function resolveRolloverCarryIn(
  tx: TenantTransactionClient,
  familyId: string,
  timezone: string,
  targetPeriodStart: Date,
  carryoverCategoryIds: string[]
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>()
  if (carryoverCategoryIds.length === 0) return result

  // ALL prior periods for these categories, any policy — the walk below needs
  // to see a "none" row to know where to stop, so filtering to
  // rolloverPolicy="carryover" here would silently bridge across a period the
  // user turned rollover off for.
  const priorRows = await tx.budgetCategory.findMany({
    where: {
      familyId,
      categoryId: { in: carryoverCategoryIds },
      budget: {
        periodKind: PERIOD_KIND_MONTHLY,
        periodStart: { lt: targetPeriodStart },
      },
    },
    select: {
      categoryId: true,
      allocatedAmount: true,
      rolloverPolicy: true,
      budget: { select: { periodStart: true, periodEnd: true } },
    },
    orderBy: { budget: { periodStart: "desc" } },
  })

  const { chains, earliestStart, latestEnd } = buildRolloverChains(priorRows)

  // Common case: no category has any prior "carryover" history yet — bail
  // before the ledger fetch (mirrors Sure's own "families that never enabled
  // rollover pay one query and never contend").
  if (chains.size === 0 || earliestStart === null || latestEnd === null) {
    return result
  }

  const rangeStart = new Date(earliestStart)
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 1)
  const rangeEnd = new Date(latestEnd)
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 2)
  const rangeRows = await fetchLedgerRowsInRange(
    tx,
    familyId,
    rangeStart,
    rangeEnd
  )

  for (const [categoryId, chain] of chains) {
    result.set(
      categoryId,
      foldChainCarryIn(categoryId, chain, rangeRows, timezone)
    )
  }

  return result
}

async function computePeriodProgress(
  tx: TenantTransactionClient,
  familyId: string,
  requestedMonth: string | undefined
): Promise<SerializedBudgetProgress> {
  // Serialized, not Promise.all: an interactive tx is one pg connection and
  // overlapping queries are rejected (see with-family.ts). Read the family
  // first so the default period is anchored to the FAMILY timezone, not the
  // caller's clock (ADR-0037 §1).
  const family = await tx.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { currency: true, timezone: true },
  })
  const month = requestedMonth ?? currentMonthInZone(family.timezone)
  const period = monthlyPeriod(month)
  const baseCurrency = family.currency
  const budget = await loadBudgetRow(tx, familyId, period.periodStart)

  // PER-278 / ADR-0037 §2 follow-up: resolve carry-in for opted-in categories
  // BEFORE the current period's own ledger fetch (serialized, not
  // Promise.all — see the comment above on the family lookup).
  const carryoverCategoryIds = (budget?.categories ?? [])
    .filter((category) => category.rolloverPolicy === "carryover")
    .map((category) => category.categoryId)
  const carryIn = await resolveRolloverCarryIn(
    tx,
    familyId,
    family.timezone,
    period.periodStart,
    carryoverCategoryIds
  )

  const allocations: BudgetAllocationInput[] = (budget?.categories ?? []).map(
    (category) => ({
      categoryId: category.categoryId,
      allocatedAmount: category.allocatedAmount,
      rolledOverAmount: carryIn.get(category.categoryId) ?? 0n,
    })
  )
  const categoryMeta = new Map<string, CategoryMeta>(
    (budget?.categories ?? []).map((category) => [
      category.categoryId,
      {
        name: category.category.name,
        color: category.category.color,
        icon: category.category.icon,
        rolloverPolicy: category.rolloverPolicy,
      },
    ])
  )

  const transactions = await fetchPeriodLedgerRows(tx, familyId, period)
  const progress = computeBudgetProgress({
    allocations,
    transactions,
    period: { start: period.start, end: period.end, timezone: family.timezone },
  })

  return serializeProgress(progress, {
    budgetId: budget?.id ?? null,
    name: budget?.name ?? defaultBudgetName(month),
    month,
    periodKind: PERIOD_KIND_MONTHLY,
    periodStart: period.start,
    periodEnd: period.end,
    currency: budget?.currency ?? baseCurrency,
    baseCurrency,
    timezone: family.timezone,
    archivedAt: budget?.archivedAt ?? null,
    categoryMeta,
  })
}

// ===========================================================================
// READ — budget progress for a period
// ===========================================================================

const getBudgetForPeriodInputSchema = z.object({
  // Optional: when omitted the server resolves the current month in the family
  // timezone, so the default period never depends on the browser's clock.
  month: monthSchema.optional(),
})
type GetBudgetForPeriodInput = z.infer<typeof getBudgetForPeriodInputSchema>

export async function getBudgetForPeriodForFamily({
  data,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: GetBudgetForPeriodInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedBudgetProgress> {
  const { month } = getBudgetForPeriodInputSchema.parse(data)
  return await runInTenantTransaction(familyId, userId, (tx) =>
    computePeriodProgress(tx, familyId, month)
  )
}

export const getBudgetForPeriodFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: GetBudgetForPeriodInput | undefined) =>
    getBudgetForPeriodInputSchema.parse(data ?? {})
  )
  .handler(async ({ data, context }) => {
    return await getBudgetForPeriodForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// READ — list budgets (non-archived by default)
// ===========================================================================

const listBudgetsInputSchema = z.object({
  includeArchived: z.boolean().optional(),
})
type ListBudgetsInput = z.infer<typeof listBudgetsInputSchema>

export async function listBudgetsForFamily({
  data,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: ListBudgetsInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedBudgetSummary[]> {
  const { includeArchived } = listBudgetsInputSchema.parse(data)
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const budgets = await tx.budget.findMany({
      where: {
        familyId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { periodStart: "desc" },
      select: {
        id: true,
        name: true,
        periodKind: true,
        periodStart: true,
        periodEnd: true,
        currency: true,
        archivedAt: true,
      },
    })
    return budgets.map((budget) => ({
      budgetId: budget.id,
      name: budget.name,
      periodKind: budget.periodKind,
      periodStart: budget.periodStart.toISOString().slice(0, 10),
      periodEnd: budget.periodEnd.toISOString().slice(0, 10),
      currency: budget.currency,
      archivedAt: budget.archivedAt?.toISOString() ?? null,
    }))
  })
}

export const listBudgetsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: ListBudgetsInput) =>
    listBudgetsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await listBudgetsForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// READ — expense categories available for budgeting (system + own family)
// ===========================================================================

export interface SerializedExpenseCategory {
  id: string
  name: string
  color: string
  icon: string
}

export const listExpenseCategoriesFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }): Promise<SerializedExpenseCategory[]> => {
    return await scopedTenantTransaction(
      context.familyId,
      context.user.id,
      async (tx) => {
        return await tx.category.findMany({
          where: {
            type: "expense",
            OR: [{ isSystem: true }, { familyId: context.familyId }],
          },
          orderBy: { name: "asc" },
          select: { id: true, name: true, color: true, icon: true },
        })
      }
    )
  })

// ===========================================================================
// WRITE — set (upsert) budget allocations for a period
// ===========================================================================

const allocationInputSchema = z.object({
  categoryId: z.string().min(1),
  // Wire money string in base-currency minor units, >= 0.
  allocatedAmount: z
    .string()
    .trim()
    .regex(
      /^\d+$/,
      "allocatedAmount must be a non-negative minor-unit integer"
    ),
  rolloverPolicy: z.enum(["none", "carryover"]).optional(),
})

const setBudgetAllocationsInputSchema = z.object({
  month: monthSchema,
  name: z.string().trim().min(1).max(120).optional(),
  allocations: z.array(allocationInputSchema).max(500),
  idempotencyKey: uuidV7Schema,
})

type SetBudgetAllocationsInput = z.input<typeof setBudgetAllocationsInputSchema>

async function validateExpenseCategories(
  tx: TenantTransactionClient,
  familyId: string,
  categoryIds: string[]
): Promise<void> {
  if (categoryIds.length === 0) return
  // RLS scopes this to system + own-family categories; a cross-tenant id simply
  // does not come back, which we turn into a validation error (tenant-owned
  // reference validation, ADR-0011). We additionally assert expense type.
  const categories = await tx.category.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, type: true, isSystem: true, familyId: true },
  })
  const byId = new Map(categories.map((category) => [category.id, category]))
  for (const categoryId of categoryIds) {
    const category = byId.get(categoryId)
    if (!category) {
      throw new BudgetValidationError(
        `Category ${categoryId} is not accessible to this family`
      )
    }
    if (!category.isSystem && category.familyId !== familyId) {
      throw new BudgetValidationError(
        `Category ${categoryId} does not belong to this family`
      )
    }
    if (category.type !== "expense") {
      throw new BudgetValidationError(
        `Category ${categoryId} is not an expense category and cannot be budgeted`
      )
    }
  }
}

export async function setBudgetAllocationsForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: SetBudgetAllocationsInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SerializedBudgetProgress> {
  const data = setBudgetAllocationsInputSchema.parse(rawData)

  // Reject duplicate categories in one payload (ambiguous allocation).
  const categoryIds = data.allocations.map(
    (allocation) => allocation.categoryId
  )
  if (new Set(categoryIds).size !== categoryIds.length) {
    throw new BudgetValidationError(
      "Duplicate categoryId in budget allocations"
    )
  }

  const period = monthlyPeriod(data.month)
  const canonicalAllocations = data.allocations
    .map((allocation) => ({
      categoryId: allocation.categoryId,
      allocatedAmount: allocation.allocatedAmount,
      rolloverPolicy: allocation.rolloverPolicy ?? "none",
    }))
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId))
  const requestHash = await hashCanonicalPayload({
    month: data.month,
    name: data.name ?? null,
    allocations: canonicalAllocations,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedBudgetProgress>(tx, {
          endpoint: SET_ALLOCATIONS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      await validateExpenseCategories(tx, familyId, categoryIds)

      const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
      const existing = await loadBudgetRow(tx, familyId, period.periodStart)
      const beforeSnapshot = existing
        ? {
            name: existing.name,
            archivedAt: existing.archivedAt?.toISOString() ?? null,
            allocations: existing.categories.map((category) => ({
              categoryId: category.categoryId,
              allocatedAmount: category.allocatedAmount.toString(),
            })),
          }
        : null

      // Upsert the period row. Currency is captured = base on first create and
      // never re-denominated (ADR-0035 / ADR-0037 §4).
      const budget = await tx.budget.upsert({
        where: {
          budget_family_period_unique: {
            familyId,
            periodKind: PERIOD_KIND_MONTHLY,
            periodStart: period.periodStart,
          },
        },
        // Editing a period's allocations reactivates it if it was archived;
        // the transition is captured in the audit before/after below so it is
        // never a silent un-archive (ADR-0037 §1).
        update: {
          name: data.name ?? defaultBudgetName(data.month),
          archivedAt: null,
        },
        create: {
          familyId,
          name: data.name ?? defaultBudgetName(data.month),
          periodKind: PERIOD_KIND_MONTHLY,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          currency: baseCurrency,
          createdById: userId,
        },
        select: { id: true },
      })

      // Full-replace the allocation set: upsert provided lines, delete the rest.
      for (const allocation of data.allocations) {
        await tx.budgetCategory.upsert({
          where: {
            budget_category_unique: {
              budgetId: budget.id,
              categoryId: allocation.categoryId,
            },
          },
          update: {
            allocatedAmount: decodeMoney(allocation.allocatedAmount),
            rolloverPolicy: allocation.rolloverPolicy ?? "none",
          },
          create: {
            familyId,
            budgetId: budget.id,
            categoryId: allocation.categoryId,
            allocatedAmount: decodeMoney(allocation.allocatedAmount),
            rolloverPolicy: allocation.rolloverPolicy ?? "none",
          },
        })
      }
      await tx.budgetCategory.deleteMany({
        where: {
          budgetId: budget.id,
          categoryId: { notIn: categoryIds.length > 0 ? categoryIds : [""] },
        },
      })

      await auditLog(tx, auditCtx, {
        action: existing ? "update" : "create",
        entityType: "Budget",
        entityId: budget.id,
        before: beforeSnapshot,
        after: {
          name: data.name ?? defaultBudgetName(data.month),
          archivedAt: null,
          periodKind: PERIOD_KIND_MONTHLY,
          periodStart: period.start,
          periodEnd: period.end,
          currency: baseCurrency,
          allocations: canonicalAllocations,
        },
      })

      const result = await computePeriodProgress(tx, familyId, data.month)
      await persistIdempotentEndpointResponse(tx, {
        endpoint: SET_ALLOCATIONS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: result,
      })
      return result
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedBudgetProgress>(tx, {
        endpoint: SET_ALLOCATIONS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const setBudgetAllocationsFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("budget:write")])
  .inputValidator((data: SetBudgetAllocationsInput) =>
    setBudgetAllocationsInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await setBudgetAllocationsForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// WRITE — archive a budget period
// ===========================================================================

const archiveBudgetInputSchema = z.object({
  month: monthSchema,
  idempotencyKey: uuidV7Schema,
})
type ArchiveBudgetInput = z.input<typeof archiveBudgetInputSchema>

export interface ArchiveBudgetResult {
  budgetId: string
  archivedAt: string
}

export async function archiveBudgetForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: ArchiveBudgetInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<ArchiveBudgetResult> {
  const data = archiveBudgetInputSchema.parse(rawData)
  const period = monthlyPeriod(data.month)
  const requestHash = await hashCanonicalPayload({ month: data.month })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<ArchiveBudgetResult>(tx, {
          endpoint: ARCHIVE_BUDGET_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const existing = await tx.budget.findUnique({
        where: {
          budget_family_period_unique: {
            familyId,
            periodKind: PERIOD_KIND_MONTHLY,
            periodStart: period.periodStart,
          },
        },
        select: { id: true, archivedAt: true },
      })
      if (!existing) throw new BudgetNotFoundError()

      // Idempotent: re-archiving an already-archived budget is a no-op success.
      const archivedAt = existing.archivedAt ?? new Date()
      if (!existing.archivedAt) {
        await tx.budget.update({
          where: { id: existing.id },
          data: { archivedAt },
        })
        await auditLog(tx, auditCtx, {
          action: "soft_delete",
          entityType: "Budget",
          entityId: existing.id,
          before: { archivedAt: null },
          after: { archivedAt: archivedAt.toISOString() },
        })
      }

      const result: ArchiveBudgetResult = {
        budgetId: existing.id,
        archivedAt: archivedAt.toISOString(),
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: ARCHIVE_BUDGET_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: result,
      })
      return result
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<ArchiveBudgetResult>(tx, {
        endpoint: ARCHIVE_BUDGET_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const archiveBudgetFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("budget:write")])
  .inputValidator((data: ArchiveBudgetInput) =>
    archiveBudgetInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await archiveBudgetForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ===========================================================================
// WRITE — move allocation between two categories in the SAME period
// PER-278 / ADR-0037 §2 follow-up ("Roll With the Punches" reallocation)
// ===========================================================================
//
// Verified against Sure's real `BudgetCategory.move_allocation!`
// (`we-promise/sure`), which this mirrors (minus Permoney's non-existent
// parent/subcategory ring-fencing — ADR-0037 §3.3 has no budget rollup this
// slice, so that whole branch does not exist here):
//   - Amount must be positive.
//   - Both categories must belong to the SAME budget (period) — a move never
//     crosses periods; there is no such thing as moving allocation "into the
//     future" or "into the past" here.
//   - Not the same category.
//   - The source must stay >= 0 after the move — `amount` cannot exceed the
//     source's CURRENT `allocatedAmount`. A move can never manufacture money
//     by driving one category negative to rescue a worse negative elsewhere;
//     the DB CHECK (`allocatedAmount >= 0`, ADR-0037 §6) is defense-in-depth
//     against a concurrent move racing this same check.
//   - Deliberately does NOT touch rollover: Permoney's rollover carry-in is
//     read-time derived (`resolveRolloverCarryIn`), not a stored column, so
//     there is no cached chain state for a move to invalidate — one of the
//     concrete wins of the read-derived choice over Sure's materialized one
//     (Sure's `move_allocation!` comment explicitly warns the caller must run
//     `Budget::RolloverCalculator` afterward, in a separate transaction, to
//     avoid an advisory-lock/row-lock deadlock; Permoney has no such second
//     step to forget).

const moveAllocationInputSchema = z.object({
  month: monthSchema,
  fromCategoryId: z.string().min(1),
  toCategoryId: z.string().min(1),
  // Wire money string in base-currency minor units, > 0.
  amount: z
    .string()
    .trim()
    .regex(/^\d+$/, "amount must be a non-negative minor-unit integer"),
  idempotencyKey: uuidV7Schema,
})
type MoveAllocationInput = z.input<typeof moveAllocationInputSchema>

export interface MoveAllocationResult {
  budgetId: string
  from: { categoryId: string; allocatedAmount: string }
  to: { categoryId: string; allocatedAmount: string }
  progress: SerializedBudgetProgress
}

export async function moveBudgetAllocationForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: MoveAllocationInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<MoveAllocationResult> {
  const data = moveAllocationInputSchema.parse(rawData)

  if (data.fromCategoryId === data.toCategoryId) {
    throw new BudgetValidationError(
      "Cannot move allocation to the same category"
    )
  }
  const amount = decodeMoney(data.amount)
  if (amount <= 0n) {
    throw new BudgetValidationError("amount must be greater than zero")
  }

  const period = monthlyPeriod(data.month)
  const requestHash = await hashCanonicalPayload({
    month: data.month,
    fromCategoryId: data.fromCategoryId,
    toCategoryId: data.toCategoryId,
    amount: data.amount,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<MoveAllocationResult>(tx, {
          endpoint: MOVE_ALLOCATION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const budget = await tx.budget.findUnique({
        where: {
          budget_family_period_unique: {
            familyId,
            periodKind: PERIOD_KIND_MONTHLY,
            periodStart: period.periodStart,
          },
        },
        select: { id: true },
      })
      if (!budget) throw new BudgetNotFoundError()

      // Sequential, not Promise.all — one pg connection per interactive tx
      // (see the family-lookup comment in computePeriodProgress). `familyId`
      // is redundant with `budgetId` already being family-scoped above (a
      // `budgetId` uniquely determines its family via the composite FK), but
      // is included explicitly as tenant-owned-reference defense-in-depth
      // (CLAUDE.md §5A) rather than relying on RLS/FK structure alone.
      const fromRow = await tx.budgetCategory.findFirst({
        where: {
          budgetId: budget.id,
          categoryId: data.fromCategoryId,
          familyId,
        },
        select: { id: true, allocatedAmount: true },
      })
      if (!fromRow) {
        throw new BudgetValidationError(
          `Category ${data.fromCategoryId} has no allocation in this period`
        )
      }
      const toRow = await tx.budgetCategory.findFirst({
        where: { budgetId: budget.id, categoryId: data.toCategoryId, familyId },
        select: { id: true, allocatedAmount: true },
      })
      if (!toRow) {
        throw new BudgetValidationError(
          `Category ${data.toCategoryId} has no allocation in this period`
        )
      }
      if (amount > fromRow.allocatedAmount) {
        throw new BudgetValidationError(
          "Cannot move more than the source category's current allocation"
        )
      }

      const beforeSnapshot = {
        from: {
          categoryId: data.fromCategoryId,
          allocatedAmount: fromRow.allocatedAmount.toString(),
        },
        to: {
          categoryId: data.toCategoryId,
          allocatedAmount: toRow.allocatedAmount.toString(),
        },
      }

      // Atomic increment/decrement, never a memory-computed replace (CLAUDE.md
      // §5A). The `allocatedAmount >= 0` DB CHECK (ADR-0037 §6) is
      // defense-in-depth against a concurrent move racing the pre-check above.
      const updatedFrom = await tx.budgetCategory.update({
        where: { id: fromRow.id },
        data: { allocatedAmount: { decrement: amount } },
        select: { allocatedAmount: true },
      })
      const updatedTo = await tx.budgetCategory.update({
        where: { id: toRow.id },
        data: { allocatedAmount: { increment: amount } },
        select: { allocatedAmount: true },
      })

      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "BudgetCategory",
        entityId: budget.id,
        before: beforeSnapshot,
        after: {
          from: {
            categoryId: data.fromCategoryId,
            allocatedAmount: updatedFrom.allocatedAmount.toString(),
          },
          to: {
            categoryId: data.toCategoryId,
            allocatedAmount: updatedTo.allocatedAmount.toString(),
          },
          amountMoved: data.amount,
        },
      })

      const progress = await computePeriodProgress(tx, familyId, data.month)
      const result: MoveAllocationResult = {
        budgetId: budget.id,
        from: {
          categoryId: data.fromCategoryId,
          allocatedAmount: updatedFrom.allocatedAmount.toString(),
        },
        to: {
          categoryId: data.toCategoryId,
          allocatedAmount: updatedTo.allocatedAmount.toString(),
        },
        progress,
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: MOVE_ALLOCATION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: result,
      })
      return result
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<MoveAllocationResult>(tx, {
        endpoint: MOVE_ALLOCATION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (!replay) throw error
    return replay
  }
}

export const moveBudgetAllocationFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("budget:write")])
  .inputValidator((data: MoveAllocationInput) =>
    moveAllocationInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await moveBudgetAllocationForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
