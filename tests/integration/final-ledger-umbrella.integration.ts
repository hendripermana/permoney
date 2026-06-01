import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  bulkCreateTransactionsForFamily,
  bulkDeleteTransactionsForFamily,
  bulkUpdateTransactionsForFamily,
  createTransactionForFamily,
  deleteTransactionForFamily,
  updateTransactionForFamily,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

type TransactionStatus = "PENDING" | "CLEARED" | "RECONCILED"

interface BulkCreateRow {
  accountId: string
  amount: bigint
  categoryId: string
  date: Date
  description: string
  id: string
  idempotencyKey: string
  status: TransactionStatus
  type: "expense" | "income"
}

interface TransactionStateRow {
  accountId: string
  amount: bigint
  categoryId: string | null
  deletedAt: Date | null
  id: string
  isSplit: boolean
  merchantId: string | null
  supersededBy: string | null
  supersedes: string | null
  toAccountId: string | null
  type: string
}

const LEDGER_TEST_DATE = new Date("2026-06-04T00:00:00.000Z")
const DATABASE_CONSTRAINT_REJECTION =
  /constraint|foreign key|violates|P2003|P2004|23503|23514/i

describe("M2 final real-Postgres ledger umbrella suite (PER-88)", () => {
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
    if (harness) await harness.teardown()
  })

  test("create path persists expense, income, transfer, and split rows with exact balances and audit evidence", async () => {
    const fixture = await createLedgerFixture()
    const expenseKey = factories.createIdempotencyKey()
    const incomeKey = factories.createIdempotencyKey()
    const transferKey = factories.createIdempotencyKey()
    const splitKey = factories.createIdempotencyKey()

    const expense = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: expenseKey,
        accountId: fixture.primaryAccount.id,
        amount: 12_000n,
        categoryId: fixture.expenseCategory.id,
        currency: "IDR",
        date: LEDGER_TEST_DATE,
        description: "PER-88 umbrella expense",
        isSplit: false,
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: fixture.owner.user,
    })
    const income = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: incomeKey,
        accountId: fixture.primaryAccount.id,
        amount: 30_000n,
        categoryId: fixture.incomeCategory.id,
        currency: "IDR",
        date: LEDGER_TEST_DATE,
        description: "PER-88 umbrella income",
        isSplit: false,
        status: "CLEARED",
        type: "income",
      },
      familyId: fixture.owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: fixture.owner.user,
    })
    const transfer = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: transferKey,
        accountId: fixture.primaryAccount.id,
        amount: 20_000n,
        currency: "IDR",
        date: LEDGER_TEST_DATE,
        description: "PER-88 umbrella transfer",
        isSplit: false,
        status: "CLEARED",
        toAccountId: fixture.transferDestination.id,
        type: "transfer",
      },
      familyId: fixture.owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: fixture.owner.user,
    })
    const split = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: splitKey,
        accountId: fixture.primaryAccount.id,
        amount: 15_000n,
        categoryId: fixture.expenseCategory.id,
        currency: "IDR",
        date: LEDGER_TEST_DATE,
        description: "PER-88 umbrella split",
        isSplit: true,
        merchantId: fixture.merchant.id,
        splitEntries: [
          {
            amount: 7_000n,
            categoryId: fixture.expenseCategory.id,
            description: "PER-88 split line one",
            merchantId: fixture.merchant.id,
          },
          {
            amount: 8_000n,
            categoryId: fixture.secondaryExpenseCategory.id,
            description: "PER-88 split line two",
            merchantId: fixture.merchant.id,
          },
        ],
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: fixture.owner.user,
    })

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 83_000n,
      [fixture.transferDestination.id]: 30_000n,
    })

    const rows = await readTransactionStates(fixture.owner.family.id, [
      expense.id,
      income.id,
      transfer.id,
      split.id,
    ])
    expect(rows.get(expense.id)).toMatchObject({
      amount: -12_000n,
      categoryId: fixture.expenseCategory.id,
      type: "expense",
    })
    expect(rows.get(income.id)).toMatchObject({
      amount: 30_000n,
      categoryId: fixture.incomeCategory.id,
      type: "income",
    })
    expect(rows.get(transfer.id)).toMatchObject({
      amount: -20_000n,
      toAccountId: fixture.transferDestination.id,
      type: "transfer",
    })
    expect(rows.get(split.id)).toMatchObject({
      amount: -15_000n,
      categoryId: null,
      isSplit: true,
      merchantId: null,
      type: "expense",
    })

    const transferGraph = await harness.withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.transfer.findUniqueOrThrow({
          include: { inflowTransaction: true },
          where: { outflowTransactionId: transfer.id },
        })
    )
    expect(transferGraph.inflowTransaction).toMatchObject({
      accountId: fixture.transferDestination.id,
      amount: 20_000n,
      toAccountId: fixture.primaryAccount.id,
      type: "transfer",
    })

    const splitEntries = await harness.withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.splitEntry.findMany({
          orderBy: { amount: "asc" },
          where: { transactionId: split.id },
        })
    )
    expect(splitEntries.map((entry) => entry.amount)).toEqual([7_000n, 8_000n])
    expect(
      splitEntries.every((entry) => entry.merchantId === fixture.merchant.id)
    ).toBe(true)

    const mutationKeys = [expenseKey, incomeKey, transferKey, splitKey]
    await expectAuditCount(fixture.owner.family.id, {
      action: "create",
      count: 5,
      entityType: "Transaction",
      idempotencyKeys: mutationKeys,
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "create",
      count: 1,
      entityType: "Transfer",
      idempotencyKeys: mutationKeys,
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "create",
      count: 2,
      entityType: "SplitEntry",
      idempotencyKeys: mutationKeys,
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "update",
      count: 5,
      entityType: "Account",
      idempotencyKeys: mutationKeys,
    })
  })

  test("update path reverses old meaning, creates a replacement id, and audits before and after snapshots", async () => {
    const fixture = await createLedgerFixture()
    const original = await createExpense(fixture, {
      amount: 12_000n,
      description: "PER-88 update original expense",
    })
    const updateKey = factories.createIdempotencyKey()

    const updated = await updateTransactionForFamily({
      data: {
        id: original.id,
        idempotencyKey: updateKey,
        accountId: fixture.secondaryAccount.id,
        amount: 25_000n,
        categoryId: fixture.incomeCategory.id,
        currency: "IDR",
        date: LEDGER_TEST_DATE,
        description: "PER-88 update replacement income",
        isSplit: false,
        status: "CLEARED",
        type: "income",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(updated.id).not.toBe(original.id)
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 100_000n,
      [fixture.secondaryAccount.id]: 45_000n,
    })

    const rows = await readTransactionStates(fixture.owner.family.id, [
      original.id,
      updated.id,
    ])
    const originalRow = rows.get(original.id)
    const updatedRow = rows.get(updated.id)
    expect(originalRow).toMatchObject({
      amount: -12_000n,
      supersededBy: updated.id,
      supersedes: null,
    })
    expect(originalRow?.deletedAt).toBeInstanceOf(Date)
    expect(updatedRow).toMatchObject({
      accountId: fixture.secondaryAccount.id,
      amount: 25_000n,
      categoryId: fixture.incomeCategory.id,
      deletedAt: null,
      supersededBy: null,
      supersedes: original.id,
      type: "income",
    })

    await expectAuditCount(fixture.owner.family.id, {
      action: "soft_delete",
      count: 1,
      entityType: "Transaction",
      idempotencyKeys: [updateKey],
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "create",
      count: 1,
      entityType: "Transaction",
      idempotencyKeys: [updateKey],
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "update",
      count: 2,
      entityType: "Account",
      idempotencyKeys: [updateKey],
    })
    await expectIdempotencyRecordCount(
      fixture.owner.family.id,
      "updateTransactionFn",
      updateKey,
      1
    )
  })

  test("delete replay reverses balances once, preserves the row for audit, and blocks later updates", async () => {
    const fixture = await createLedgerFixture()
    const original = await createExpense(fixture, {
      amount: 18_000n,
      description: "PER-88 delete replay expense",
    })
    const deleteKey = factories.createIdempotencyKey()

    const first = await deleteTransactionForFamily({
      id: original.id,
      idempotencyKey: deleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const second = await deleteTransactionForFamily({
      id: original.id,
      idempotencyKey: deleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const third = await deleteTransactionForFamily({
      id: original.id,
      idempotencyKey: deleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect([first, second, third]).toEqual([
      { success: true },
      { success: true },
      { success: true },
    ])
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 100_000n,
    })

    const rows = await readTransactionStates(fixture.owner.family.id, [
      original.id,
    ])
    expect(rows.get(original.id)?.deletedAt).toBeInstanceOf(Date)
    await expectAuditCount(fixture.owner.family.id, {
      action: "soft_delete",
      count: 1,
      entityType: "Transaction",
      idempotencyKeys: [deleteKey],
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "update",
      count: 1,
      entityType: "Account",
      idempotencyKeys: [deleteKey],
    })
    await expectIdempotencyRecordCount(
      fixture.owner.family.id,
      "deleteTransactionFn",
      deleteKey,
      1
    )

    await expect(
      updateTransactionForFamily({
        data: {
          id: original.id,
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: fixture.primaryAccount.id,
          amount: 21_000n,
          categoryId: fixture.expenseCategory.id,
          currency: "IDR",
          date: LEDGER_TEST_DATE,
          description: "PER-88 update after delete",
          isSplit: false,
          status: "CLEARED",
          type: "expense",
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      })
    ).rejects.toMatchObject({ statusCode: 410 })
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 100_000n,
    })
  })

  test("bulk create/update/delete keeps single-mutation balance, audit, and idempotency parity", async () => {
    const fixture = await createLedgerFixture()
    const bulkCreateKey = factories.createIdempotencyKey()
    const bulkUpdateKey = factories.createIdempotencyKey()
    const bulkDeleteKey = factories.createIdempotencyKey()
    const createRows = [
      bulkRow({
        accountId: fixture.primaryAccount.id,
        amount: 6_000n,
        categoryId: fixture.expenseCategory.id,
        description: "PER-88 bulk expense",
        type: "expense",
      }),
      bulkRow({
        accountId: fixture.primaryAccount.id,
        amount: 10_000n,
        categoryId: fixture.incomeCategory.id,
        description: "PER-88 bulk income",
        type: "income",
      }),
    ]

    const created = await bulkCreateTransactionsForFamily({
      data: {
        idempotencyKey: bulkCreateKey,
        transactions: createRows,
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(created).toMatchObject({
      count: 2,
      success: true,
      transactionIds: createRows.map((row) => row.id),
    })
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 104_000n,
      [fixture.secondaryAccount.id]: 20_000n,
    })

    const updated = await bulkUpdateTransactionsForFamily({
      data: {
        ids: createRows.map((row) => row.id),
        idempotencyKey: bulkUpdateKey,
        accountId: fixture.secondaryAccount.id,
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(updated.replacements).toHaveLength(2)
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 100_000n,
      [fixture.secondaryAccount.id]: 24_000n,
    })

    const replacementIds = updated.replacements.map((row) => row.replacementId)
    const statesAfterUpdate = await readTransactionStates(
      fixture.owner.family.id,
      [...createRows.map((row) => row.id), ...replacementIds]
    )
    expect(
      createRows.every(
        (row) =>
          statesAfterUpdate.get(row.id)?.deletedAt instanceof Date &&
          replacementIds.includes(
            statesAfterUpdate.get(row.id)?.supersededBy ?? ""
          )
      )
    ).toBe(true)
    expect(
      replacementIds.every(
        (id) =>
          statesAfterUpdate.get(id)?.accountId ===
            fixture.secondaryAccount.id &&
          statesAfterUpdate.get(id)?.deletedAt === null
      )
    ).toBe(true)

    const deleted = await bulkDeleteTransactionsForFamily({
      ids: replacementIds,
      idempotencyKey: bulkDeleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const replayedDelete = await bulkDeleteTransactionsForFamily({
      ids: replacementIds,
      idempotencyKey: bulkDeleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(replayedDelete).toEqual(deleted)
    expect(deleted).toEqual({ count: 2, success: true })
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.primaryAccount.id]: 100_000n,
      [fixture.secondaryAccount.id]: 20_000n,
    })

    await expectAuditCount(fixture.owner.family.id, {
      action: "create",
      count: 2,
      entityType: "Transaction",
      idempotencyKeys: [bulkCreateKey],
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "soft_delete",
      count: 2,
      entityType: "Transaction",
      idempotencyKeys: [bulkUpdateKey],
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "create",
      count: 2,
      entityType: "Transaction",
      idempotencyKeys: [bulkUpdateKey],
    })
    await expectAuditCount(fixture.owner.family.id, {
      action: "soft_delete",
      count: 2,
      entityType: "Transaction",
      idempotencyKeys: [bulkDeleteKey],
    })
    await expectIdempotencyRecordCount(
      fixture.owner.family.id,
      "bulkCreateTransactionsFn",
      bulkCreateKey,
      1
    )
    await expectIdempotencyRecordCount(
      fixture.owner.family.id,
      "bulkUpdateTransactionsFn",
      bulkUpdateKey,
      1
    )
    await expectIdempotencyRecordCount(
      fixture.owner.family.id,
      "bulkDeleteTransactionsFn",
      bulkDeleteKey,
      1
    )
  })

  test("RLS GUC and database constraints remain active as final backstops", async () => {
    const fixture = await createLedgerFixture()

    const visibleWithoutGuc = await harness.prisma.account.findFirst({
      where: { id: fixture.primaryAccount.id },
    })
    expect(visibleWithoutGuc).toBeNull()

    await expect(
      harness.withFamily(fixture.owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: fixture.primaryAccount.id,
            amount: 1n,
            currency: "IDR",
            description: "PER-88 invalid positive expense",
            familyId: fixture.owner.family.id,
            type: "expense",
            userId: fixture.owner.user.id,
          },
        })
      )
    ).rejects.toThrow(DATABASE_CONSTRAINT_REJECTION)
  })

  async function createLedgerFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [
      primaryAccount,
      secondaryAccount,
      transferDestination,
      expenseCategory,
      secondaryExpenseCategory,
      incomeCategory,
      merchant,
    ] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-88 primary account",
      }),
      factories.createAccount({
        balance: 20_000n,
        familyId: owner.family.id,
        name: "PER-88 secondary account",
      }),
      factories.createAccount({
        balance: 10_000n,
        familyId: owner.family.id,
        name: "PER-88 transfer destination",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-88 expense category",
        type: "expense",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-88 secondary expense category",
        type: "expense",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-88 income category",
        type: "income",
      }),
      factories.createMerchant({
        familyId: owner.family.id,
        name: "PER-88 merchant",
      }),
    ])

    return {
      expenseCategory,
      incomeCategory,
      merchant,
      owner,
      primaryAccount,
      secondaryAccount,
      secondaryExpenseCategory,
      transferDestination,
    }
  }

  async function createExpense(
    fixture: Awaited<ReturnType<typeof createLedgerFixture>>,
    input: { amount: bigint; description: string }
  ): Promise<{ id: string }> {
    return await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: fixture.primaryAccount.id,
        amount: input.amount,
        categoryId: fixture.expenseCategory.id,
        currency: "IDR",
        date: LEDGER_TEST_DATE,
        description: input.description,
        isSplit: false,
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: fixture.owner.user,
    })
  }

  function bulkRow({
    accountId,
    amount,
    categoryId,
    description,
    type,
  }: {
    accountId: string
    amount: bigint
    categoryId: string
    description: string
    type: "expense" | "income"
  }): BulkCreateRow {
    return {
      id: factories.createIdempotencyKey(),
      idempotencyKey: factories.createIdempotencyKey(),
      accountId,
      amount,
      categoryId,
      date: LEDGER_TEST_DATE,
      description,
      status: "CLEARED",
      type,
    }
  }

  async function readTransactionStates(
    familyId: string,
    ids: readonly string[]
  ): Promise<Map<string, TransactionStateRow>> {
    const rows = await harness.withFamily(familyId, (tx) =>
      tx.transaction.findMany({
        select: {
          accountId: true,
          amount: true,
          categoryId: true,
          deletedAt: true,
          id: true,
          isSplit: true,
          merchantId: true,
          supersededBy: true,
          supersedes: true,
          toAccountId: true,
          type: true,
        },
        where: { id: { in: [...ids] } },
      })
    )
    return new Map(rows.map((row) => [row.id, row]))
  }

  async function expectAccountBalances(
    familyId: string,
    expected: Record<string, bigint>
  ): Promise<void> {
    const rows = await harness.withFamily(familyId, (tx) =>
      tx.account.findMany({
        select: { balance: true, id: true },
        where: { id: { in: Object.keys(expected) } },
      })
    )
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.balance]))
    ).toEqual(expected)
  }

  async function expectAuditCount(
    familyId: string,
    {
      action,
      count,
      entityType,
      idempotencyKeys,
    }: {
      action: string
      count: number
      entityType: string
      idempotencyKeys: readonly string[]
    }
  ): Promise<void> {
    const actual = await harness.withFamily(familyId, (tx) =>
      tx.auditLog.count({
        where: {
          action,
          entityType,
          familyId,
          idempotencyKey: { in: [...idempotencyKeys] },
        },
      })
    )
    expect(actual).toBe(count)
  }

  async function expectIdempotencyRecordCount(
    familyId: string,
    endpoint: string,
    key: string,
    count: number
  ): Promise<void> {
    const actual = await harness.withFamily(familyId, (tx) =>
      tx.idempotencyRecord.count({
        where: { endpoint, familyId, key },
      })
    )
    expect(actual).toBe(count)
  }
})
