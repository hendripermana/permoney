import type { Account, Category } from "@prisma/client"
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
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

type MutationUser = { familyId?: string | null; id: string }
type TransactionStatus = "PENDING" | "CLEARED" | "RECONCILED"

interface BulkCreateRow {
  accountId: string
  amount: bigint
  attachmentUrl?: string | null
  categoryId?: string | null
  date: Date
  description: string
  id: string
  idempotencyKey: string
  merchantId?: string | null
  notes?: string | null
  status?: TransactionStatus
  type: "expense" | "income"
}

interface BulkCreatePayload {
  idempotencyKey: string
  transactions: BulkCreateRow[]
}

interface BulkCreateResult {
  count: number
  success: boolean
  transactionIds: string[]
}

interface BulkUpdatePayload {
  accountId?: string
  categoryId?: string | null
  idempotencyKey: string
  ids: string[]
  merchantId?: string | null
}

interface BulkUpdateResult {
  replacements: Array<{ id: string; replacementId: string }>
  success: boolean
}

interface BulkDeleteResult {
  count: number
  success: boolean
}

interface BulkMutationArgs<TData> {
  data: TData
  familyId: string
  user: MutationUser
}

interface DeleteMutationArgs {
  familyId: string
  idempotencyKey: string
  ids: string[]
  user: MutationUser
}

interface TransactionStateRow {
  accountId: string
  amount: bigint
  deletedAt: Date | null
  id: string
  idempotencyKey: string | null
  supersededBy: string | null
  supersedes: string | null
}

const bulkCreateMutation = bulkCreateTransactionsForFamily as unknown as (
  args: BulkMutationArgs<BulkCreatePayload>
) => Promise<BulkCreateResult>

const bulkUpdateMutation = bulkUpdateTransactionsForFamily as unknown as (
  args: BulkMutationArgs<BulkUpdatePayload>
) => Promise<BulkUpdateResult>

const bulkDeleteMutation = bulkDeleteTransactionsForFamily as unknown as (
  args: DeleteMutationArgs
) => Promise<BulkDeleteResult>

describe("bulk mutation parity with single ledger invariants (PER-95)", () => {
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

  test("bulk create replays the same batch key without duplicating rows, balances, or audit logs", async () => {
    const fixture = await createExpenseFixture()
    const firstRowKey = factories.createIdempotencyKey()
    const secondRowKey = factories.createIdempotencyKey()
    const payload: BulkCreatePayload = {
      idempotencyKey: factories.createIdempotencyKey(),
      transactions: [
        bulkCreateRow({
          accountId: fixture.account.id,
          amount: 12_000n,
          categoryId: fixture.category.id,
          description: "Bulk create expense",
          idempotencyKey: firstRowKey,
          type: "expense",
        }),
        bulkCreateRow({
          accountId: fixture.account.id,
          amount: 7_000n,
          categoryId: fixture.category.id,
          description: "Bulk create income",
          idempotencyKey: secondRowKey,
          type: "income",
        }),
      ],
    }

    const first = await bulkCreateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const replay = await bulkCreateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      count: 2,
      success: true,
      transactionIds: payload.transactions.map((row) => row.id),
    })
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 95_000n,
    })

    const [transactions, auditRows, idempotencyRecords] = await Promise.all([
      readTransactionStates(
        fixture.owner.family.id,
        payload.transactions.map((row) => row.id)
      ),
      countAuditRows(fixture.owner.family.id, {
        action: "create",
        entityType: "Transaction",
        idempotencyKey: payload.idempotencyKey,
      }),
      countIdempotencyRecords(
        fixture.owner.family.id,
        "bulkCreateTransactionsFn",
        payload.idempotencyKey
      ),
    ])

    expect(
      transactions
        .map((row) => row.idempotencyKey)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual(
      [firstRowKey, secondRowKey].sort((left, right) =>
        left.localeCompare(right)
      )
    )
    expect(auditRows).toBe(2)
    expect(idempotencyRecords).toBe(1)
  })

  test("bulk create rejects same batch key with different canonical payload without partial mutation", async () => {
    const fixture = await createExpenseFixture()
    const payload: BulkCreatePayload = {
      idempotencyKey: factories.createIdempotencyKey(),
      transactions: [
        bulkCreateRow({
          accountId: fixture.account.id,
          amount: 8_000n,
          categoryId: fixture.category.id,
          description: "Conflict original",
          idempotencyKey: factories.createIdempotencyKey(),
          type: "expense",
        }),
      ],
    }

    await bulkCreateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    await expect(
      bulkCreateMutation({
        data: {
          ...payload,
          transactions: [
            {
              ...payload.transactions[0]!,
              amount: 9_000n,
              description: "Conflict changed",
            },
          ],
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      })
    ).rejects.toMatchObject({ statusCode: 409 })

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 92_000n,
    })
    expect(await countTransactionsForFamily(fixture.owner.family.id)).toBe(1)
  })

  test("bulk update uses PER-93 supersession semantics and replays without duplicate balance effects", async () => {
    const fixture = await createExpenseFixture()
    const destination = await factories.createAccount({
      balance: 50_000n,
      familyId: fixture.owner.family.id,
      name: "Bulk update destination",
    })
    const first = await createExpense(fixture, {
      amount: 10_000n,
      description: "Bulk update first",
    })
    const second = await createExpense(fixture, {
      amount: 5_000n,
      description: "Bulk update second",
    })
    const payload: BulkUpdatePayload = {
      accountId: destination.id,
      idempotencyKey: factories.createIdempotencyKey(),
      ids: [first.id, second.id],
    }

    const result = await bulkUpdateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const replay = await bulkUpdateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(replay).toEqual(result)
    expect(result.replacements).toHaveLength(2)
    expect(result.replacements.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort()
    )

    const originalRows = await readTransactionStates(fixture.owner.family.id, [
      first.id,
      second.id,
    ])
    const replacementIds = result.replacements.map((row) => row.replacementId)
    const replacementRows = await readTransactionStates(
      fixture.owner.family.id,
      replacementIds
    )

    expect(originalRows.every((row) => row.deletedAt instanceof Date)).toBe(
      true
    )
    expect(
      originalRows
        .map((row) => row.supersededBy)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual(replacementIds.sort((left, right) => left.localeCompare(right)))
    expect(replacementRows.every((row) => row.deletedAt === null)).toBe(true)
    expect(
      replacementRows.every((row) => row.accountId === destination.id)
    ).toBe(true)
    expect(
      replacementRows
        .map((row) => row.supersedes)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual(
      [first.id, second.id].sort((left, right) => left.localeCompare(right))
    )
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 100_000n,
      [destination.id]: 35_000n,
    })
    expect(await countTransactionsForFamily(fixture.owner.family.id)).toBe(4)
    expect(
      await countAuditRows(fixture.owner.family.id, {
        action: "soft_delete",
        entityType: "Transaction",
        idempotencyKey: payload.idempotencyKey,
      })
    ).toBe(2)
    expect(
      await countAuditRows(fixture.owner.family.id, {
        action: "create",
        entityType: "Transaction",
        idempotencyKey: payload.idempotencyKey,
      })
    ).toBe(2)
  })

  test("bulk update rejects a batch containing a deleted row and rolls back active siblings", async () => {
    const fixture = await createExpenseFixture()
    const active = await createExpense(fixture, {
      amount: 4_000n,
      description: "Bulk update active sibling",
    })
    const closed = await createExpense(fixture, {
      amount: 6_000n,
      description: "Bulk update deleted sibling",
    })
    await bulkDeleteMutation({
      familyId: fixture.owner.family.id,
      idempotencyKey: factories.createIdempotencyKey(),
      ids: [closed.id],
      user: fixture.owner.user,
    })

    await expect(
      bulkUpdateMutation({
        data: {
          categoryId: fixture.category.id,
          idempotencyKey: factories.createIdempotencyKey(),
          ids: [active.id, closed.id],
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      })
    ).rejects.toMatchObject({ statusCode: 410 })

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 96_000n,
    })
    const activeState = await readTransactionStates(fixture.owner.family.id, [
      active.id,
    ])
    expect(activeState[0]).toMatchObject({
      deletedAt: null,
      supersededBy: null,
      supersedes: null,
    })
  })

  test("bulk delete replays the same batch key without reversing balances twice", async () => {
    const fixture = await createExpenseFixture()
    const first = await createExpense(fixture, {
      amount: 11_000n,
      description: "Bulk delete first",
    })
    const second = await createExpense(fixture, {
      amount: 4_000n,
      description: "Bulk delete second",
    })
    const idempotencyKey = factories.createIdempotencyKey()

    const firstDelete = await bulkDeleteMutation({
      familyId: fixture.owner.family.id,
      idempotencyKey,
      ids: [first.id, second.id],
      user: fixture.owner.user,
    })
    const replay = await bulkDeleteMutation({
      familyId: fixture.owner.family.id,
      idempotencyKey,
      ids: [first.id, second.id],
      user: fixture.owner.user,
    })

    expect(replay).toEqual(firstDelete)
    expect(firstDelete).toEqual({ count: 2, success: true })
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 100_000n,
    })
    expect(
      await countAuditRows(fixture.owner.family.id, {
        action: "soft_delete",
        entityType: "Transaction",
        idempotencyKey,
      })
    ).toBe(2)

    await expect(
      bulkDeleteMutation({
        familyId: fixture.owner.family.id,
        idempotencyKey: factories.createIdempotencyKey(),
        ids: [first.id, second.id],
        user: fixture.owner.user,
      })
    ).rejects.toMatchObject({ statusCode: 410 })
  })

  test("bulk delete rejects a mixed cross-tenant batch without mutating the owner ledger", async () => {
    const ownerFixture = await createExpenseFixture()
    const intruderFixture = await createExpenseFixture()
    const ownerTransaction = await createExpense(ownerFixture, {
      amount: 13_000n,
      description: "Owner row must stay active",
    })
    const intruderTransaction = await createExpense(intruderFixture, {
      amount: 17_000n,
      description: "Intruder row must be inaccessible",
    })

    await expect(
      bulkDeleteMutation({
        familyId: ownerFixture.owner.family.id,
        idempotencyKey: factories.createIdempotencyKey(),
        ids: [ownerTransaction.id, intruderTransaction.id],
        user: ownerFixture.owner.user,
      })
    ).rejects.toThrow("Transaction not found or access denied")

    await expectAccountBalances(ownerFixture.owner.family.id, {
      [ownerFixture.account.id]: 87_000n,
    })
    const ownerRows = await readTransactionStates(
      ownerFixture.owner.family.id,
      [ownerTransaction.id]
    )
    expect(ownerRows[0]?.deletedAt).toBeNull()
  })

  async function createExpenseFixture(): Promise<{
    account: Account
    category: Category
    owner: AuthenticatedOnboardedUser
  }> {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, category] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-95 account",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-95 category",
        type: "expense",
      }),
    ])
    return { account, category, owner }
  }

  function bulkCreateRow({
    accountId,
    amount,
    categoryId,
    description,
    idempotencyKey,
    type,
  }: {
    accountId: string
    amount: bigint
    categoryId: string
    description: string
    idempotencyKey: string
    type: "expense" | "income"
  }): BulkCreateRow {
    return {
      accountId,
      amount,
      categoryId,
      date: new Date("2026-06-02T01:00:00.000Z"),
      description,
      id: factories.createIdempotencyKey(),
      idempotencyKey,
      status: "CLEARED",
      type,
    }
  }

  async function createExpense(
    fixture: Awaited<ReturnType<typeof createExpenseFixture>>,
    input: { amount: bigint; description: string }
  ): Promise<{ id: string }> {
    return await createTransactionForFamily({
      data: {
        accountId: fixture.account.id,
        amount: input.amount,
        categoryId: fixture.category.id,
        currency: "IDR",
        date: new Date("2026-06-02T01:30:00.000Z"),
        description: input.description,
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
  }

  async function readTransactionStates(
    familyId: string,
    ids: readonly string[]
  ): Promise<TransactionStateRow[]> {
    return await harness.withFamily(familyId, (tx) =>
      tx.transaction.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          accountId: true,
          amount: true,
          deletedAt: true,
          id: true,
          idempotencyKey: true,
          supersededBy: true,
          supersedes: true,
        },
        where: { id: { in: [...ids] } },
      })
    )
  }

  async function readAccountBalances(
    familyId: string,
    accountIds: readonly string[]
  ): Promise<Map<string, bigint>> {
    const rows = await harness.withFamily(familyId, (tx) =>
      tx.account.findMany({
        select: { balance: true, id: true },
        where: { id: { in: [...accountIds] } },
      })
    )
    return new Map(rows.map((row) => [row.id, row.balance]))
  }

  async function expectAccountBalances(
    familyId: string,
    expected: Record<string, bigint>
  ): Promise<void> {
    const balances = await readAccountBalances(familyId, Object.keys(expected))
    expect(Object.fromEntries(balances)).toEqual(expected)
  }

  async function countTransactionsForFamily(familyId: string): Promise<number> {
    return await harness.withFamily(familyId, (tx) =>
      tx.transaction.count({ where: { familyId } })
    )
  }

  async function countAuditRows(
    familyId: string,
    where: {
      action: string
      entityType: string
      idempotencyKey: string
    }
  ): Promise<number> {
    return await harness.withFamily(familyId, (tx) =>
      tx.auditLog.count({ where })
    )
  }

  async function countIdempotencyRecords(
    familyId: string,
    endpoint: string,
    key: string
  ): Promise<number> {
    return await harness.withFamily(familyId, (tx) =>
      tx.idempotencyRecord.count({ where: { endpoint, familyId, key } })
    )
  }
})
