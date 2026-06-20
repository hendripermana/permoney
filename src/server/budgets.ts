import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { decodeMoney, encodeMoney } from "@/lib/money"
import {
  computeBudgetProgress,
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

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedBudgetCategoryProgress {
  categoryId: string
  categoryName: string
  categoryColor: string
  categoryIcon: string
  allocatedAmount: string
  actualAmount: string
  remainingAmount: string
  isOver: boolean
  pendingCount: number
}

export interface SerializedBudgetProgress {
  budgetId: string | null
  name: string
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
}

function serializeProgress(
  progress: BudgetProgress,
  meta: {
    budgetId: string | null
    name: string
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
          category: { select: { name: true, color: true, icon: true } },
        },
      },
    },
  })
}

async function fetchPeriodLedgerRows(
  tx: TenantTransactionClient,
  familyId: string,
  period: MonthlyPeriod
): Promise<BudgetLedgerRowInput[]> {
  // Coarse UTC prefilter padded ±1 day; the pure engine does exact family-tz
  // bucketing. Only canonical, non-excluded, non-deleted expense rows count.
  const rangeStart = new Date(period.periodStart)
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 1)
  const rangeEnd = new Date(period.periodEnd)
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 2)

  const rows = await tx.transaction.findMany({
    where: {
      familyId,
      type: "expense",
      deletedAt: null,
      excluded: false,
      date: { gte: rangeStart, lt: rangeEnd },
    },
    select: {
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

async function computePeriodProgress(
  tx: TenantTransactionClient,
  familyId: string,
  month: string
): Promise<SerializedBudgetProgress> {
  const period = monthlyPeriod(month)
  // Serialized, not Promise.all: an interactive tx is one pg connection and
  // overlapping queries are rejected (see with-family.ts).
  const family = await tx.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { currency: true, timezone: true },
  })
  const baseCurrency = family.currency
  const budget = await loadBudgetRow(tx, familyId, period.periodStart)

  const allocations: BudgetAllocationInput[] = (budget?.categories ?? []).map(
    (category) => ({
      categoryId: category.categoryId,
      allocatedAmount: category.allocatedAmount,
    })
  )
  const categoryMeta = new Map<string, CategoryMeta>(
    (budget?.categories ?? []).map((category) => [
      category.categoryId,
      {
        name: category.category.name,
        color: category.category.color,
        icon: category.category.icon,
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

const getBudgetForPeriodInputSchema = z.object({ month: monthSchema })
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
  .inputValidator((data: GetBudgetForPeriodInput) =>
    getBudgetForPeriodInputSchema.parse(data)
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
