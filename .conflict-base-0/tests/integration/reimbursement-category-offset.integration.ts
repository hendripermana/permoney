import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import {
  getBudgetForPeriodForFamily,
  setBudgetAllocationsForFamily,
} from "@/server/budgets"
import {
  getCashFlowReportForFamily,
  type CashFlowReportResult,
} from "@/server/reporting"
import { createTransactionForFamily } from "@/server/transactions"
import {
  CategoryTypeMismatchError,
  TenantReferenceError,
} from "@/server/validation/tenant-references"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-260 / ADR-0055 — Real-Postgres proof of the reimbursement/refund
// category-offset contract: an income row tagged kind="reimbursement" and
// assigned an EXPENSE-type category (a) nets correctly in the Spending report
// (`getCashFlowReportForFamily`'s byCategory), (b) reduces that SAME
// category's budget "spent" figure by the identical amount (never a second,
// disagreeing source of truth — ADR-0049/ADR-0054 precedent), and (c) is
// rejected server-side when the shape is wrong: wrong transaction type,
// wrong category type, or a cross-tenant category reference.
//
// Covers the three dogfooding cases at their real percentages: split-bill
// reimbursement (partial), dinner reimbursement (partial), and a cancelled
// order refund (100%).

const MONTH = "2026-06"
const FROM = "2026-06-01"
const TO = "2026-06-30"
const ON = (d = "2026-06-15") => new Date(`${d}T03:00:00.000Z`)

describe("reimbursement/refund category offset (PER-260)", () => {
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

  const setFamilyDefaults = (
    owner: AuthenticatedOnboardedUser,
    currency: string,
    timezone: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.family.update({
        where: { id: owner.family.id },
        data: { currency, timezone },
      })
    )

  const account = (
    owner: AuthenticatedOnboardedUser,
    name: string,
    accountType: AccountType = "DEPOSITORY"
  ) =>
    factories.createAccount({
      familyId: owner.family.id,
      name,
      accountType,
      currency: "IDR",
      balance: 100_000_000n,
    })

  const create = (
    owner: AuthenticatedOnboardedUser,
    data: Omit<
      Parameters<typeof createTransactionForFamily>[0]["data"],
      "idempotencyKey"
    >
  ) =>
    createTransactionForFamily({
      data: { idempotencyKey: factories.createIdempotencyKey(), ...data },
      familyId: owner.family.id,
      user: owner.user,
    })

  const cashFlowReport = (owner: AuthenticatedOnboardedUser) =>
    getCashFlowReportForFamily({
      data: { from: FROM, to: TO, interval: "month" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  const catGroup = (r: CashFlowReportResult, id: string | null) =>
    r.byCategory.find((g) => g.categoryId === id)

  // ---- the three dogfooding cases, proven via the cash-flow report ----------

  test("0% reimbursed: an ordinary expense is untouched by the new kind", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const subs = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Subscriptions",
    })

    await create(owner, {
      type: "expense",
      amount: 319_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: subs.id,
      description: "Apple One",
      date: ON(),
    })

    const r = await cashFlowReport(owner)
    expect(catGroup(r, subs.id)?.expense).toBe("319000")
    expect(catGroup(r, subs.id)?.income).toBe("0")
    expect(catGroup(r, subs.id)?.net).toBe("-319000")
  })

  test("partial reimbursement (dinner split with family) nets the same category", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })

    await create(owner, {
      type: "expense",
      amount: 180_500n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      description: "dinner",
      date: ON(),
    })
    await create(owner, {
      type: "income",
      kind: "reimbursement",
      amount: 180_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      description: "family covered dinner",
      date: ON(),
    })

    const r = await cashFlowReport(owner)
    const group = catGroup(r, food.id)
    expect(group?.expense).toBe("180500")
    expect(group?.income).toBe("180000")
    expect(group?.net).toBe("-500")
  })

  test("100% refund of a cancelled order nets the category to zero", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const shopping = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Shopping",
    })

    await create(owner, {
      type: "expense",
      amount: 300_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: shopping.id,
      description: "order",
      date: ON(),
    })
    await create(owner, {
      type: "income",
      kind: "reimbursement",
      amount: 300_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: shopping.id,
      description: "cancelled order refund",
      date: ON(),
    })

    const r = await cashFlowReport(owner)
    expect(catGroup(r, shopping.id)?.net).toBe("0")
  })

  test("split-bill reimbursement across multiple rows nets one category", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const subs = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Subscriptions",
    })

    await create(owner, {
      type: "expense",
      amount: 319_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: subs.id,
      description: "Apple One",
      date: ON(),
    })
    for (const share of [63_612n, 63_613n, 63_612n, 63_613n]) {
      await create(owner, {
        type: "income",
        kind: "reimbursement",
        amount: share,
        currency: "IDR",
        accountId: wallet.id,
        categoryId: subs.id,
        description: "friend's share",
        date: ON(),
      })
    }

    const r = await cashFlowReport(owner)
    // Real burden: 319,000 - 254,450 = 64,550.
    expect(catGroup(r, subs.id)?.net).toBe("-64550")
  })

  // ---- budget parity: the SAME rows must net identically in both screens ----

  test("budget 'spent' nets identically to the cash-flow report for the same rows", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })

    await create(owner, {
      type: "expense",
      amount: 180_500n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      description: "dinner",
      date: ON(),
    })
    await create(owner, {
      type: "income",
      kind: "reimbursement",
      amount: 180_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      description: "family covered dinner",
      date: ON(),
    })

    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: food.id, allocatedAmount: "200000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })

    const budget = await getBudgetForPeriodForFamily({
      data: { month: MONTH },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    const cashFlow = await cashFlowReport(owner)

    const budgetSpent = budget.categories.find(
      (c) => c.categoryId === food.id
    )?.actualAmount
    const cashFlowGroup = catGroup(cashFlow, food.id)
    // The Spending report shows net = income - expense = -500 for this
    // category; the Budget "spent" figure must be the same net SPEND, i.e.
    // +500 (expense magnitude net of the reimbursement) — the two screens
    // must never disagree about the same underlying transactions.
    expect(budgetSpent).toBe("500")
    expect(cashFlowGroup?.net).toBe("-500")
  })

  test("100% refund nets the budget category to zero, matching the cash-flow report", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const shopping = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Shopping",
    })

    await create(owner, {
      type: "expense",
      amount: 300_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: shopping.id,
      description: "order",
      date: ON(),
    })
    await create(owner, {
      type: "income",
      kind: "reimbursement",
      amount: 300_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: shopping.id,
      description: "cancelled order refund",
      date: ON(),
    })

    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [{ categoryId: shopping.id, allocatedAmount: "500000" }],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })

    const budget = await getBudgetForPeriodForFamily({
      data: { month: MONTH },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(
      budget.categories.find((c) => c.categoryId === shopping.id)?.actualAmount
    ).toBe("0")
  })

  // ---- server-side rejection: wrong type, wrong category type, cross-tenant --

  test("rejects kind=reimbursement on a non-income transaction", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const wallet = await account(owner, "Wallet")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })

    await expect(
      create(owner, {
        type: "expense",
        kind: "reimbursement",
        amount: 10_000n,
        currency: "IDR",
        accountId: wallet.id,
        categoryId: food.id,
        description: "invalid",
        date: ON(),
      })
    ).rejects.toThrow()
  })

  test("rejects a reimbursement whose category is INCOME-typed, not EXPENSE", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const wallet = await account(owner, "Wallet")
    const salary = await factories.createCategory({
      familyId: owner.family.id,
      type: "income",
      name: "Salary",
    })

    await expect(
      create(owner, {
        type: "income",
        kind: "reimbursement",
        amount: 10_000n,
        currency: "IDR",
        accountId: wallet.id,
        categoryId: salary.id,
        description: "invalid",
        date: ON(),
      })
    ).rejects.toThrow(CategoryTypeMismatchError)
  })

  test("tenant isolation: a reimbursement categoryId from another family is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const wallet = await account(owner, "Wallet")

    const otherFamily = await factories.createAuthenticatedOnboardedUser()
    const foreignCategory = await factories.createCategory({
      familyId: otherFamily.family.id,
      type: "expense",
      name: "Foreign Food",
    })

    await expect(
      create(owner, {
        type: "income",
        kind: "reimbursement",
        amount: 10_000n,
        currency: "IDR",
        accountId: wallet.id,
        categoryId: foreignCategory.id,
        description: "invalid",
        date: ON(),
      })
    ).rejects.toThrow(TenantReferenceError)
  })

  test("does not affect an unrelated category in either screen", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })
    const transport = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Transport",
    })

    await create(owner, {
      type: "expense",
      amount: 180_500n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      description: "dinner",
      date: ON(),
    })
    await create(owner, {
      type: "income",
      kind: "reimbursement",
      amount: 180_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      description: "family covered dinner",
      date: ON(),
    })
    await create(owner, {
      type: "expense",
      amount: 100_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: transport.id,
      description: "gas",
      date: ON(),
    })

    await setBudgetAllocationsForFamily({
      data: {
        month: MONTH,
        allocations: [
          { categoryId: food.id, allocatedAmount: "200000" },
          { categoryId: transport.id, allocatedAmount: "150000" },
        ],
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })

    const budget = await getBudgetForPeriodForFamily({
      data: { month: MONTH },
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: runner(owner.user.id),
    })
    expect(
      budget.categories.find((c) => c.categoryId === transport.id)?.actualAmount
    ).toBe("100000")

    const r = await cashFlowReport(owner)
    expect(catGroup(r, transport.id)?.expense).toBe("100000")
    expect(catGroup(r, transport.id)?.income).toBe("0")
  })
})
