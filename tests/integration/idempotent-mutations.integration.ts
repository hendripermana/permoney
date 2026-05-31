import { Prisma } from "@prisma/client"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
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

type TransactionKind = "expense" | "income" | "transfer"
type TransactionStatus = "PENDING" | "CLEARED" | "RECONCILED"

interface MutationUser {
  familyId?: string | null
  id: string
}

interface SerializedTransactionResult {
  id: string
}

interface UpdateMutationPayload {
  accountId: string
  amount: bigint
  attachmentUrl?: string | null
  categoryId?: string | null
  currency?: string
  date: Date
  description: string
  destinationAmount?: bigint | null
  destinationCurrency?: string | null
  id: string
  idempotencyKey: string
  isSplit?: boolean
  merchantId?: string | null
  notes?: string | null
  splitEntries?: Array<{
    amount: bigint
    categoryId?: string | null
    description: string
    merchantId?: string | null
  }>
  status?: TransactionStatus
  toAccountId?: string | null
  type: TransactionKind
}

interface UpdateMutationArgs {
  data: UpdateMutationPayload
  familyId: string
  user: MutationUser
}

interface DeleteMutationArgs {
  familyId: string
  id: string
  idempotencyKey: string
  user: MutationUser
}

interface SupersessionRow {
  amount: bigint
  deletedAt: Date | null
  id: string
  supersededBy: string | null
  supersedes: string | null
  type: string
}

interface AccountBalanceRow {
  balance: bigint
  id: string
}

const updateMutation = updateTransactionForFamily as unknown as (
  args: UpdateMutationArgs
) => Promise<SerializedTransactionResult>

const deleteMutation = deleteTransactionForFamily as unknown as (
  args: DeleteMutationArgs
) => Promise<{ success: boolean }>

describe("idempotent update/delete ledger mutations (PER-93)", () => {
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

  test("update soft-deletes the old transaction, creates a new id, links supersession, and applies one balance delta", async () => {
    const fixture = await createExpenseFixture()
    const original = await createExpense(fixture, {
      amount: 10_000n,
      description: "Original expense",
    })
    const updateKey = factories.createIdempotencyKey()

    const updated = await updateMutation({
      data: {
        id: original.id,
        idempotencyKey: updateKey,
        accountId: fixture.account.id,
        amount: 25_000n,
        categoryId: fixture.category.id,
        currency: "IDR",
        date: new Date("2026-06-01T02:00:00.000Z"),
        description: "Updated expense",
        isSplit: false,
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(updated.id).not.toBe(original.id)

    const rows = await readSupersessionRows(fixture.owner.family.id, [
      original.id,
      updated.id,
    ])
    expect(rows.get(original.id)).toMatchObject({
      amount: -10_000n,
      supersededBy: updated.id,
      supersedes: null,
    })
    expect(rows.get(original.id)?.deletedAt).toBeInstanceOf(Date)
    expect(rows.get(updated.id)).toMatchObject({
      amount: -25_000n,
      deletedAt: null,
      supersededBy: null,
      supersedes: original.id,
    })

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 75_000n,
    })

    const auditRows = await harness.withFamily(fixture.owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: {
          entityType: "Transaction",
          idempotencyKey: updateKey,
        },
        orderBy: { createdAt: "asc" },
        select: {
          action: true,
          afterJson: true,
          beforeJson: true,
          entityId: true,
        },
      })
    )
    expect(auditRows.map((row) => [row.action, row.entityId])).toEqual([
      ["soft_delete", original.id],
      ["create", updated.id],
    ])
    expect(auditRows.every((row) => row.beforeJson !== null)).toBe(false)
    expect(auditRows.every((row) => row.afterJson !== null)).toBe(true)
  })

  test("replaying update with the same idempotency key returns the same new id without duplicate balance or audit effects", async () => {
    const fixture = await createExpenseFixture()
    const original = await createExpense(fixture, {
      amount: 10_000n,
      description: "Replay update original",
    })
    const payload: UpdateMutationPayload = {
      id: original.id,
      idempotencyKey: factories.createIdempotencyKey(),
      accountId: fixture.account.id,
      amount: 25_000n,
      categoryId: fixture.category.id,
      currency: "IDR",
      date: new Date("2026-06-01T02:01:00.000Z"),
      description: "Replay update replacement",
      isSplit: false,
      status: "CLEARED",
      type: "expense",
    }

    const first = await updateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const replay = await updateMutation({
      data: payload,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(replay.id).toBe(first.id)
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 75_000n,
    })

    const transactionAudits = await harness.withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.auditLog.findMany({
          where: {
            entityType: "Transaction",
            idempotencyKey: payload.idempotencyKey,
          },
          select: { action: true, entityId: true },
        })
    )
    expect(transactionAudits).toHaveLength(2)
    expect(transactionAudits.map((row) => row.action).sort()).toEqual([
      "create",
      "soft_delete",
    ])
  })

  test("update transfer soft-deletes both old legs and old transfer, then creates a new paired transfer graph", async () => {
    const fixture = await createTransferFixture()
    const transfer = await createTransfer(fixture, {
      amount: 100_000n,
      description: "Original transfer",
      toAccountId: fixture.destinationOne.id,
    })
    const oldTransfer = await readTransferByOutflow(
      fixture.owner.family.id,
      transfer.id
    )
    const updateKey = factories.createIdempotencyKey()

    const updated = await updateMutation({
      data: {
        id: transfer.id,
        idempotencyKey: updateKey,
        accountId: fixture.source.id,
        amount: 150_000n,
        currency: "IDR",
        date: new Date("2026-06-01T02:02:00.000Z"),
        description: "Updated transfer",
        destinationAmount: null,
        destinationCurrency: null,
        isSplit: false,
        status: "CLEARED",
        toAccountId: fixture.destinationTwo.id,
        type: "transfer",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(updated.id).not.toBe(transfer.id)
    const newTransfer = await readTransferByOutflow(
      fixture.owner.family.id,
      updated.id
    )
    expect(newTransfer.id).not.toBe(oldTransfer.id)

    const rows = await readSupersessionRows(fixture.owner.family.id, [
      oldTransfer.outflowTransactionId,
      oldTransfer.inflowTransactionId,
      newTransfer.outflowTransactionId,
      newTransfer.inflowTransactionId,
    ])
    expect(
      rows.get(oldTransfer.outflowTransactionId)?.deletedAt
    ).toBeInstanceOf(Date)
    expect(rows.get(oldTransfer.inflowTransactionId)?.deletedAt).toBeInstanceOf(
      Date
    )
    expect(rows.get(oldTransfer.outflowTransactionId)?.supersededBy).toBe(
      newTransfer.outflowTransactionId
    )
    expect(rows.get(oldTransfer.inflowTransactionId)?.supersededBy).toBe(
      newTransfer.inflowTransactionId
    )
    expect(rows.get(newTransfer.outflowTransactionId)).toMatchObject({
      amount: -150_000n,
      deletedAt: null,
      supersedes: oldTransfer.outflowTransactionId,
    })
    expect(rows.get(newTransfer.inflowTransactionId)).toMatchObject({
      amount: 150_000n,
      deletedAt: null,
      supersedes: oldTransfer.inflowTransactionId,
    })

    const oldTransferAfter = await readTransferById(
      fixture.owner.family.id,
      oldTransfer.id
    )
    expect(oldTransferAfter.deletedAt).toBeInstanceOf(Date)
    expect(newTransfer.deletedAt).toBeNull()

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.source.id]: 850_000n,
      [fixture.destinationOne.id]: 100_000n,
      [fixture.destinationTwo.id]: 250_000n,
    })
  })

  test("delete replay with the same idempotency key returns prior success without double reversal or duplicate audit", async () => {
    const fixture = await createExpenseFixture()
    const original = await createExpense(fixture, {
      amount: 20_000n,
      description: "Delete replay expense",
    })
    const deleteKey = factories.createIdempotencyKey()

    await deleteMutation({
      id: original.id,
      idempotencyKey: deleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const replay = await deleteMutation({
      id: original.id,
      idempotencyKey: deleteKey,
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(replay).toEqual({ success: true })
    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 100_000n,
    })

    const transactionAudits = await harness.withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.auditLog.findMany({
          where: {
            action: "soft_delete",
            entityId: original.id,
            entityType: "Transaction",
            idempotencyKey: deleteKey,
          },
        })
    )
    expect(transactionAudits).toHaveLength(1)
  })

  test("updating a soft-deleted transaction fails with 410 Gone and does not mutate balances", async () => {
    const fixture = await createExpenseFixture()
    const original = await createExpense(fixture, {
      amount: 15_000n,
      description: "Gone update expense",
    })
    await deleteMutation({
      id: original.id,
      idempotencyKey: factories.createIdempotencyKey(),
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    await expect(
      updateMutation({
        data: {
          id: original.id,
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: fixture.account.id,
          amount: 30_000n,
          categoryId: fixture.category.id,
          currency: "IDR",
          date: new Date("2026-06-01T02:03:00.000Z"),
          description: "Should not resurrect",
          isSplit: false,
          status: "CLEARED",
          type: "expense",
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      })
    ).rejects.toMatchObject({ statusCode: 410 })

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 100_000n,
    })
    const activeCount = await harness.withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.transaction.count({
          where: { accountId: fixture.account.id, deletedAt: null },
        })
    )
    expect(activeCount).toBe(0)
  })

  test("concurrent update and delete on the same transaction settle with exactly one winner and a coherent balance", async () => {
    const fixture = await createExpenseFixture()
    const original = await createExpense(fixture, {
      amount: 10_000n,
      description: "Race original",
    })

    const results = await Promise.allSettled([
      updateMutation({
        data: {
          id: original.id,
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: fixture.account.id,
          amount: 20_000n,
          categoryId: fixture.category.id,
          currency: "IDR",
          date: new Date("2026-06-01T02:04:00.000Z"),
          description: "Race update",
          isSplit: false,
          status: "CLEARED",
          type: "expense",
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      }),
      deleteMutation({
        id: original.id,
        idempotencyKey: factories.createIdempotencyKey(),
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      }),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    expect(rejected?.reason).toMatchObject({ statusCode: 410 })

    const balances = await readAccountBalances(fixture.owner.family.id, [
      fixture.account.id,
    ])
    expect([80_000n, 100_000n]).toContain(balances.get(fixture.account.id))
  })

  test("bulk update path uses PER-95 replacement parity with idempotent replay", async () => {
    const fixture = await createExpenseFixture()
    const secondCategory = await factories.createCategory({
      familyId: fixture.owner.family.id,
      name: "Bulk updated category",
      type: "expense",
    })
    const first = await createExpense(fixture, {
      amount: 5_000n,
      description: "Bulk update first",
    })
    const second = await createExpense(fixture, {
      amount: 7_000n,
      description: "Bulk update second",
    })
    const idempotencyKey = factories.createIdempotencyKey()

    const result = await bulkUpdateTransactionsForFamily({
      data: {
        ids: [first.id, second.id],
        idempotencyKey,
        categoryId: secondCategory.id,
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
    const replay = await bulkUpdateTransactionsForFamily({
      data: {
        ids: [first.id, second.id],
        idempotencyKey,
        categoryId: secondCategory.id,
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    expect(replay).toEqual(result)

    await expectAccountBalances(fixture.owner.family.id, {
      [fixture.account.id]: 88_000n,
    })
    const replacementIds = result.replacements.map((row) => row.replacementId)
    const [originals, replacements] = await Promise.all([
      harness.withFamily(fixture.owner.family.id, (tx) =>
        tx.transaction.findMany({
          where: { id: { in: [first.id, second.id] } },
          select: { deletedAt: true, id: true, supersededBy: true },
        })
      ),
      harness.withFamily(fixture.owner.family.id, (tx) =>
        tx.transaction.findMany({
          where: { id: { in: replacementIds } },
          select: { categoryId: true, deletedAt: true, supersedes: true },
        })
      ),
    ])
    expect(originals.every((row) => row.deletedAt instanceof Date)).toBe(true)
    expect(
      originals
        .map((row) => row.supersededBy)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual(replacementIds.sort((left, right) => left.localeCompare(right)))
    expect(
      replacements
        .map((row) => row.categoryId)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual([secondCategory.id, secondCategory.id])
    expect(replacements.every((row) => row.deletedAt === null)).toBe(true)
    expect(
      replacements
        .map((row) => row.supersedes)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual(
      [first.id, second.id].sort((left, right) => left.localeCompare(right))
    )
  })

  async function createExpenseFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, category] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-93 expense account",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-93 expense category",
        type: "expense",
      }),
    ])

    return { account, category, owner }
  }

  async function createTransferFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [source, destinationOne, destinationTwo] = await Promise.all([
      factories.createAccount({
        balance: 1_000_000n,
        familyId: owner.family.id,
        name: "PER-93 source",
      }),
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-93 destination one",
      }),
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-93 destination two",
      }),
    ])

    return { destinationOne, destinationTwo, owner, source }
  }

  async function createExpense(
    fixture: Awaited<ReturnType<typeof createExpenseFixture>>,
    input: { amount: bigint; description: string }
  ) {
    return await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: fixture.account.id,
        amount: input.amount,
        categoryId: fixture.category.id,
        currency: "IDR",
        date: new Date("2026-06-01T01:00:00.000Z"),
        description: input.description,
        isSplit: false,
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
  }

  async function createTransfer(
    fixture: Awaited<ReturnType<typeof createTransferFixture>>,
    input: { amount: bigint; description: string; toAccountId: string }
  ) {
    return await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: fixture.source.id,
        amount: input.amount,
        currency: "IDR",
        date: new Date("2026-06-01T01:30:00.000Z"),
        description: input.description,
        isSplit: false,
        status: "CLEARED",
        toAccountId: input.toAccountId,
        type: "transfer",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })
  }

  async function readSupersessionRows(familyId: string, ids: string[]) {
    const rows = await harness.withFamily(
      familyId,
      (tx) =>
        tx.$queryRaw<SupersessionRow[]>`
        SELECT id, amount, type, "deletedAt", "supersededBy", "supersedes"
        FROM "Transaction"
        WHERE id IN (${Prisma.join(ids)})
      `
    )
    return new Map(rows.map((row) => [row.id, row]))
  }

  async function readTransferByOutflow(familyId: string, outflowId: string) {
    return await harness.withFamily(familyId, (tx) =>
      tx.transfer.findUniqueOrThrow({
        where: { outflowTransactionId: outflowId },
      })
    )
  }

  async function readTransferById(familyId: string, id: string) {
    return await harness.withFamily(familyId, (tx) =>
      tx.transfer.findUniqueOrThrow({
        where: { id },
      })
    )
  }

  async function readAccountBalances(familyId: string, accountIds: string[]) {
    const rows = await harness.withFamily(familyId, (tx) =>
      tx.account.findMany({
        where: { id: { in: accountIds } },
        select: { balance: true, id: true },
      })
    )
    return new Map(rows.map((row: AccountBalanceRow) => [row.id, row.balance]))
  }

  async function expectAccountBalances(
    familyId: string,
    expected: Record<string, bigint>
  ) {
    const balances = await readAccountBalances(familyId, Object.keys(expected))
    expect(Object.fromEntries(balances)).toEqual(expected)
  }
})
