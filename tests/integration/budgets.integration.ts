import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  BudgetNotFoundError,
  BudgetValidationError,
  archiveBudgetForFamily,
  getBudgetForPeriodForFamily,
  listBudgetsForFamily,
  setBudgetAllocationsForFamily,
} from "@/server/budgets"
import { IdempotencyConflictError } from "@/server/idempotency"
import { roleCan } from "@/server/middleware/authz"
import { IDENTITY_RATE } from "@/lib/fx"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import { withPrivilegedDatabase } from "./support/privileged-db"

// PER-148 / ADR-0037 — Real-Postgres proof of the budget contract: tenant
// isolation (composite FK + membership-guarded RLS), tenant-owned/system
// category validation, audit, idempotent replay, archive, DB CHECKs, and that
// progress is computed from the real ledger (expense-only, excluded/transfer
// filtered, splits per child).

const MONTH = "2026-06"
const IN_JUNE = new Date("2026-06-15T03:00:00.000Z")

describe("budgets vertical slice (PER-148)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  // Inject the harness tenant runner so the domain fns run with both GUCs set
  // to the acting member (exactly what familyMiddleware would do).
  const runner = (actorId: string) => {
    return <T>(
      familyId: string,
      userId: string,
      fn: Parameters<typeof harness.withMember>[2]
    ) => {
      expect(userId).toBe(actorId)
      return harness.withMember(familyId, userId, fn) as Promise<T>
    }
  }

  interface ExpenseOptions {
    amount: bigint
    baseAmount?: bigint | null
    currency?: string
    categoryId?: string | null
    date?: Date
    excluded?: boolean
    type?: "expense" | "income" | "transfer"
  }

  const createLedgerRow = async (
    familyId: string,
    userId: string,
    accountId: string,
    opts: ExpenseOptions
  ) => {
    const base = opts.baseAmount === undefined ? opts.amount : opts.baseAmount
    return await harness.withMember(familyId, userId, (tx) =>
      tx.transaction.create({
        data: {
          accountId,
          familyId,
          userId,
          amount: opts.amount,
          currency: opts.currency ?? "IDR",
          baseAmount: base,
          baseCurrency: base === null ? null : "IDR",
          fxRateScaled: base === null ? null : IDENTITY_RATE,
          type: opts.type ?? "expense",
          status: "CLEARED",
          description: "test row",
          date: opts.date ?? IN_JUNE,
          categoryId: opts.categoryId ?? null,
          excluded: opts.excluded ?? false,
        },
      })
    )
  }

  const seedSystemCategory = async (id: string): Promise<string> => {
    await withPrivilegedDatabase(harness.databaseName, async (client) => {
      await client.query(
        `INSERT INTO "Category"
         (id, name, type, color, icon, "isSystem", "familyId", "parentId")
         VALUES ($1, 'System Food', 'expense', '#6172F3', 'shapes', true, NULL, NULL)`,
        [id]
      )
    })
    return id
  }

  // -------------------------------------------------------------------------
  // End-to-end: set allocations, read progress from the real ledger
  // -------------------------------------------------------------------------
  test("set allocations then read computes actual from the ledger", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({ familyId: owner.family.id })
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })
    await createLedgerRow(owner.family.id, owner.user.id, account.id, {
      amount: -50_000n,
      categoryId: food.id,
    })

    const progress = await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: food.id, allocatedAmount: "100000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })

    const row = progress.categories.find((c) => c.categoryId === food.id)
    expect(row?.allocatedAmount).toBe("100000")
    expect(row?.actualAmount).toBe("50000")
    expect(row?.remainingAmount).toBe("50000")
    expect(row?.isOver).toBe(false)
    expect(progress.currency).toBe("IDR")
  })

  test("excluded, non-expense, and out-of-period rows do not count", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({ familyId: owner.family.id })
    // All rows uncategorized so the surviving one lands in the visibility line.
    await createLedgerRow(owner.family.id, owner.user.id, account.id, {
      amount: -50_000n,
    })
    await createLedgerRow(owner.family.id, owner.user.id, account.id, {
      amount: -99_999n,
      excluded: true,
    })
    // Non-expense (income) rows are excluded by the same `type = 'expense'`
    // filter that excludes transfer legs.
    await createLedgerRow(owner.family.id, owner.user.id, account.id, {
      amount: 88_888n,
      type: "income",
    })
    await createLedgerRow(owner.family.id, owner.user.id, account.id, {
      amount: -77_777n,
      date: new Date("2026-05-31T03:00:00.000Z"), // previous month
    })

    const progress = await getBudgetForPeriodForFamily({
      data: { month: MONTH },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    // Only the single -50,000 expense in June counts; null-category line empty.
    expect(progress.uncategorized.actualAmount).toBe("50000")
  })

  test("split transaction contributes per child category", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({ familyId: owner.family.id })
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })
    const fun = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Fun",
    })
    await harness.withMember(owner.family.id, owner.user.id, (tx) =>
      tx.transaction.create({
        data: {
          accountId: account.id,
          familyId: owner.family.id,
          userId: owner.user.id,
          amount: -100_000n,
          currency: "IDR",
          baseAmount: -100_000n,
          baseCurrency: "IDR",
          fxRateScaled: IDENTITY_RATE,
          type: "expense",
          status: "CLEARED",
          description: "split row",
          date: IN_JUNE,
          isSplit: true,
          categoryId: null,
          splitEntries: {
            create: [
              {
                description: "groceries",
                amount: 60_000n,
                categoryId: food.id,
              },
              { description: "movie", amount: 40_000n, categoryId: fun.id },
            ],
          },
        },
      })
    )

    const progress = await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [
          { categoryId: food.id, allocatedAmount: "100000" },
          { categoryId: fun.id, allocatedAmount: "100000" },
        ],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(
      progress.categories.find((c) => c.categoryId === food.id)?.actualAmount
    ).toBe("60000")
    expect(
      progress.categories.find((c) => c.categoryId === fun.id)?.actualAmount
    ).toBe("40000")
  })

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------
  test("a family cannot read another family's budget (RLS membership guard)", async () => {
    const familyA = await factories.createAuthenticatedOnboardedUser()
    const familyB = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: familyA.family.id,
      type: "expense",
    })
    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: food.id, allocatedAmount: "100000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyA.family.id,
      userId: familyA.user.id,
      runInTenantTransaction: runner(familyA.user.id),
    })

    // B's user scoped to family A: the membership guard yields zero rows.
    const leaked = await getBudgetForPeriodForFamily({
      data: { month: MONTH },
      familyId: familyA.family.id,
      userId: familyB.user.id,
      runInTenantTransaction: runner(familyB.user.id),
    })
    expect(leaked.budgetId).toBeNull()
    expect(leaked.categories).toHaveLength(0)

    // A sees its own.
    const own = await getBudgetForPeriodForFamily({
      data: { month: MONTH },
      familyId: familyA.family.id,
      userId: familyA.user.id,
      runInTenantTransaction: runner(familyA.user.id),
    })
    expect(own.budgetId).not.toBeNull()
    expect(own.categories).toHaveLength(1)
  })

  test("writing into another family's budget is rejected", async () => {
    const familyA = await factories.createAuthenticatedOnboardedUser()
    const familyB = await factories.createAuthenticatedOnboardedUser()
    const aCategory = await factories.createCategory({
      familyId: familyA.family.id,
      type: "expense",
    })
    await expect(
      setBudgetAllocationsForFamily({
        data: {
          month: MONTH,
          allocations: [
            { categoryId: aCategory.id, allocatedAmount: "100000" },
          ],
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: familyA.family.id,
        userId: familyB.user.id,
        runInTenantTransaction: runner(familyB.user.id),
      })
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // Tenant-owned / system / type category validation
  // -------------------------------------------------------------------------
  test("a cross-tenant categoryId is rejected", async () => {
    const familyA = await factories.createAuthenticatedOnboardedUser()
    const familyB = await factories.createAuthenticatedOnboardedUser()
    const bCategory = await factories.createCategory({
      familyId: familyB.family.id,
      type: "expense",
    })
    await expect(
      setBudgetAllocationsForFamily({
        data: {
          month: MONTH,
          allocations: [
            { categoryId: bCategory.id, allocatedAmount: "100000" },
          ],
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: familyA.family.id,
        userId: familyA.user.id,
        runInTenantTransaction: runner(familyA.user.id),
      })
    ).rejects.toBeInstanceOf(BudgetValidationError)
  })

  test("an income category cannot be budgeted", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const income = await factories.createCategory({
      familyId: owner.family.id,
      type: "income",
    })
    await expect(
      setBudgetAllocationsForFamily({
        data: {
          month: MONTH,
          allocations: [{ categoryId: income.id, allocatedAmount: "100000" }],
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        userId: owner.user.id,
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(BudgetValidationError)
  })

  test("a global system expense category is accepted", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const systemId = await seedSystemCategory("sys_food_budget")
    const progress = await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: systemId, allocatedAmount: "250000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(
      progress.categories.find((c) => c.categoryId === systemId)
        ?.allocatedAmount
    ).toBe("250000")
  })

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------
  test("setting allocations writes an append-only audit row", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
    })
    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: food.id, allocatedAmount: "100000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    const audits = await harness.withMember(
      owner.family.id,
      owner.user.id,
      (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Budget", action: "create" },
        })
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]?.userId).toBe(owner.user.id)
  })

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------
  test("replaying the same key + payload does not double-write", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
    })
    const key = factories.createIdempotencyKey()
    const payload = {
      month: MONTH,
      allocations: [{ categoryId: food.id, allocatedAmount: "100000" }],
      idempotencyKey: key,
    }
    await setBudgetAllocationsForFamily({
      data: payload,
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    await setBudgetAllocationsForFamily({
      data: payload,
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })

    const budgets = await harness.withMember(
      owner.family.id,
      owner.user.id,
      (tx) => tx.budget.findMany({ include: { categories: true } })
    )
    expect(budgets).toHaveLength(1)
    expect(budgets[0]?.categories).toHaveLength(1)
    const audits = await harness.withMember(
      owner.family.id,
      owner.user.id,
      (tx) => tx.auditLog.count({ where: { entityType: "Budget" } })
    )
    expect(audits).toBe(1)
  })

  test("the same key with a different payload conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
    })
    const key = factories.createIdempotencyKey()
    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: food.id, allocatedAmount: "100000" }],
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    await expect(
      setBudgetAllocationsForFamily({
        data: {
          month: MONTH,
          allocations: [{ categoryId: food.id, allocatedAmount: "999999" }],
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        userId: owner.user.id,
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  // -------------------------------------------------------------------------
  // Archive
  // -------------------------------------------------------------------------
  test("archiving removes a budget from the active list, idempotently", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
    })
    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: food.id, allocatedAmount: "100000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })

    const first = await archiveBudgetForFamily({
      data: { month: MONTH, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    // Re-archiving with a fresh key is a no-op success (same archivedAt).
    const second = await archiveBudgetForFamily({
      data: { month: MONTH, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(second.archivedAt).toBe(first.archivedAt)

    const active = await listBudgetsForFamily({
      data: {},
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(active).toHaveLength(0)
    const all = await listBudgetsForFamily({
      data: { includeArchived: true },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(all).toHaveLength(1)
  })

  test("archiving a non-existent period throws not found", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await expect(
      archiveBudgetForFamily({
        data: {
          month: MONTH,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        userId: owner.user.id,
        runInTenantTransaction: runner(owner.user.id),
      })
    ).rejects.toBeInstanceOf(BudgetNotFoundError)
  })

  // -------------------------------------------------------------------------
  // Period default + archive lifecycle (P1 review fixes)
  // -------------------------------------------------------------------------
  test("reading with no month resolves to the family-timezone current month", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const expected = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
    }).format(new Date())

    const progress = await getBudgetForPeriodForFamily({
      data: {},
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(progress.month).toBe(expected)
  })

  test("editing an archived period reactivates it with an audited transition", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
    })
    const set = async (amount: string) =>
      await setBudgetAllocationsForFamily({
        data: {
          month: MONTH,
          allocations: [{ categoryId: food.id, allocatedAmount: amount }],
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        userId: owner.user.id,
        runInTenantTransaction: runner(owner.user.id),
      })

    await set("100000")
    await archiveBudgetForFamily({
      data: { month: MONTH, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    // Editing the archived period reactivates it.
    await set("120000")

    const budgets = await harness.withMember(
      owner.family.id,
      owner.user.id,
      (tx) => tx.budget.findMany()
    )
    expect(budgets[0]?.archivedAt).toBeNull()

    // The reactivating edit recorded the archivedAt transition (not silent).
    const audits = await harness.withMember(
      owner.family.id,
      owner.user.id,
      (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Budget", action: "update" },
          orderBy: { createdAt: "desc" },
        })
    )
    const before = audits[0]?.beforeJson as {
      archivedAt?: string | null
    } | null
    const after = audits[0]?.afterJson as { archivedAt?: string | null } | null
    expect(before?.archivedAt).toBeTruthy()
    expect(after?.archivedAt).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Database CHECK constraints (the law, independent of zod)
  // -------------------------------------------------------------------------
  test("DB rejects a negative allocation, bad periodKind, and inverted period", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
    })

    // Negative allocation via a budget+line written directly under the guard.
    await expect(
      harness.withMember(owner.family.id, owner.user.id, async (tx) => {
        const budget = await tx.budget.create({
          data: {
            familyId: owner.family.id,
            name: "June",
            periodKind: "monthly",
            periodStart: new Date("2026-06-01"),
            periodEnd: new Date("2026-06-30"),
            currency: "IDR",
            createdById: owner.user.id,
          },
        })
        await tx.budgetCategory.create({
          data: {
            familyId: owner.family.id,
            budgetId: budget.id,
            categoryId: food.id,
            allocatedAmount: -1n,
          },
        })
      })
    ).rejects.toThrow()

    await expect(
      harness.withMember(owner.family.id, owner.user.id, (tx) =>
        tx.budget.create({
          data: {
            familyId: owner.family.id,
            name: "Bad kind",
            periodKind: "yearly",
            periodStart: new Date("2026-07-01"),
            periodEnd: new Date("2026-07-31"),
            currency: "IDR",
            createdById: owner.user.id,
          },
        })
      )
    ).rejects.toThrow()

    await expect(
      harness.withMember(owner.family.id, owner.user.id, (tx) =>
        tx.budget.create({
          data: {
            familyId: owner.family.id,
            name: "Inverted",
            periodKind: "monthly",
            periodStart: new Date("2026-08-31"),
            periodEnd: new Date("2026-08-01"),
            currency: "IDR",
            createdById: owner.user.id,
          },
        })
      )
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // Capability matrix (ADR-0037 §5)
  // -------------------------------------------------------------------------
  test("budget:write is granted to owner/admin/member, denied to viewer", () => {
    expect(roleCan("owner", "budget:write")).toBe(true)
    expect(roleCan("admin", "budget:write")).toBe(true)
    expect(roleCan("member", "budget:write")).toBe(true)
    expect(roleCan("viewer", "budget:write")).toBe(false)
  })
})
