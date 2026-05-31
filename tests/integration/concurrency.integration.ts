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
  createTransactionForFamily,
  deleteTransactionForFamily,
  updateTransactionForFamily,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
  type IntegrationTx,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

interface AccountSnapshot {
  balance: bigint
  id: string
  version: number
}

interface RetryEvent {
  attempt: number
  errorName: string
  nextDelayMs: number
}

interface SerializableRetryOptions {
  baseDelayMs?: number
  jitterRatio?: number
  maxRetries?: number
  onRetry?: (event: RetryEvent) => void
}

interface SerializableRetryClient {
  $transaction<T>(
    fn: (tx: IntegrationTx) => Promise<T>,
    options?: { isolationLevel?: unknown; maxWait?: number; timeout?: number }
  ): Promise<T>
}

interface WithRetryModule {
  BalanceConflictError: new (...args: never[]) => Error
  withSerializableRetry: <T>(
    client: SerializableRetryClient,
    fn: (tx: IntegrationTx) => Promise<T>,
    opts?: SerializableRetryOptions
  ) => Promise<T>
}

describe("ledger concurrency and retry policy (PER-18)", () => {
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

  test("two parallel transfers from one source account commit with versioned balance snapshots", async () => {
    const fixture = await createTransferFixture()

    const [toSavings, toBrokerage] = await Promise.all([
      createTransactionForFamily({
        data: {
          id: factories.createIdempotencyKey(),
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: fixture.source.id,
          amount: 100_000n,
          currency: "IDR",
          date: new Date("2026-05-30T00:00:00.000Z"),
          description: "Move to savings",
          isSplit: false,
          status: "CLEARED",
          toAccountId: fixture.destinationOne.id,
          type: "transfer",
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      }),
      createTransactionForFamily({
        data: {
          id: factories.createIdempotencyKey(),
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: fixture.source.id,
          amount: 250_000n,
          currency: "IDR",
          date: new Date("2026-05-30T00:00:01.000Z"),
          description: "Move to brokerage",
          isSplit: false,
          status: "CLEARED",
          toAccountId: fixture.destinationTwo.id,
          type: "transfer",
        },
        familyId: fixture.owner.family.id,
        user: fixture.owner.user,
      }),
    ])

    expect(toSavings.id).not.toBe(toBrokerage.id)

    const snapshots = await readAccountSnapshots(fixture.owner.family.id, [
      fixture.source.id,
      fixture.destinationOne.id,
      fixture.destinationTwo.id,
    ])
    expect(snapshots.get(fixture.source.id)).toMatchObject({
      balance: 650_000n,
      version: 2,
    })
    expect(snapshots.get(fixture.destinationOne.id)).toMatchObject({
      balance: 200_000n,
      version: 1,
    })
    expect(snapshots.get(fixture.destinationTwo.id)).toMatchObject({
      balance: 350_000n,
      version: 1,
    })

    const outflowSnapshots = await harness.withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.transaction.findMany({
          where: {
            accountId: fixture.source.id,
            familyId: fixture.owner.family.id,
            type: "transfer",
          },
          orderBy: { accountBalanceAfter: "asc" },
          select: { accountBalanceAfter: true },
        })
    )
    expect(outflowSnapshots[0]?.accountBalanceAfter).toBe(650_000n)
    expect([750_000n, 900_000n]).toContain(
      outflowSnapshots[1]?.accountBalanceAfter
    )
  })

  test("three parallel transfers touching one account all commit with bounded retry and correct final balance", async () => {
    const fixture = await createTransferFixture()
    const destinations = [
      fixture.destinationOne.id,
      fixture.destinationTwo.id,
      (
        await factories.createAccount({
          balance: 100_000n,
          familyId: fixture.owner.family.id,
          name: "Emergency",
        })
      ).id,
    ]
    const amounts = [50_000n, 75_000n, 125_000n]

    await Promise.all(
      destinations.map((destinationId, index) =>
        createTransactionForFamily({
          data: {
            id: factories.createIdempotencyKey(),
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: fixture.source.id,
            amount: amounts[index]!,
            currency: "IDR",
            date: new Date(`2026-05-30T00:01:0${index}.000Z`),
            description: `Concurrent transfer ${index + 1}`,
            isSplit: false,
            status: "CLEARED",
            toAccountId: destinationId,
            type: "transfer",
          },
          familyId: fixture.owner.family.id,
          user: fixture.owner.user,
        })
      )
    )

    const snapshots = await readAccountSnapshots(fixture.owner.family.id, [
      fixture.source.id,
      ...destinations,
    ])
    expect(snapshots.get(fixture.source.id)).toMatchObject({
      balance: 750_000n,
      version: 3,
    })
    expect(destinations.map((id) => snapshots.get(id)?.version)).toStrictEqual([
      1, 1, 1,
    ])
  })

  test("unrecoverable serialization failure exhausts retry budget as BalanceConflictError", async () => {
    const retryModule = await loadRetryModule()
    let attempts = 0
    const alwaysFailingClient: SerializableRetryClient = {
      async $transaction<T>(): Promise<T> {
        attempts += 1
        const error = new Error("forced serialization failure")
        Object.assign(error, { code: "40001" })
        throw error
      },
    }

    await expect(
      retryModule.withSerializableRetry(
        alwaysFailingClient,
        async () => "unreachable",
        {
          baseDelayMs: 0,
          jitterRatio: 0,
          maxRetries: 3,
        }
      )
    ).rejects.toThrow(retryModule.BalanceConflictError)

    await expect(
      retryModule.withSerializableRetry(
        alwaysFailingClient,
        async () => "unreachable",
        {
          baseDelayMs: 0,
          jitterRatio: 0,
          maxRetries: 0,
        }
      )
    ).rejects.toThrow(
      "Account balance conflict could not be resolved after 1 attempt(s)"
    )
    expect(attempts).toBe(5)
  })

  test("parallel idempotency replay across retry boundary creates one row and one versioned balance mutation", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Idempotent account",
    })
    const category = await factories.createCategory({
      familyId: owner.family.id,
      name: "Idempotent category",
      type: "expense",
    })
    const transactionId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()
    const payload = {
      id: transactionId,
      idempotencyKey,
      accountId: account.id,
      amount: 12_500n,
      categoryId: category.id,
      currency: "IDR",
      date: new Date("2026-05-30T00:02:00.000Z"),
      description: "Parallel idempotent retry",
      isSplit: false,
      status: "CLEARED",
      type: "expense" as const,
    }

    const [first, second] = await Promise.all([
      createTransactionForFamily({
        data: payload,
        familyId: owner.family.id,
        user: owner.user,
      }),
      createTransactionForFamily({
        data: payload,
        familyId: owner.family.id,
        user: owner.user,
      }),
    ])

    expect(first.id).toBe(transactionId)
    expect(second.id).toBe(transactionId)

    const [transactions, snapshots] = await Promise.all([
      harness.withFamily(owner.family.id, (tx) =>
        tx.transaction.findMany({
          where: { familyId: owner.family.id, idempotencyKey },
        })
      ),
      readAccountSnapshots(owner.family.id, [account.id]),
    ])

    expect(transactions).toHaveLength(1)
    expect(snapshots.get(account.id)).toMatchObject({
      balance: 87_500n,
      version: 1,
    })
  })

  test("concurrent transfer update and delete settle without deadlock or restrict violation", async () => {
    const fixture = await createTransferFixture()
    const transfer = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: fixture.source.id,
        amount: 100_000n,
        currency: "IDR",
        date: new Date("2026-05-30T00:03:00.000Z"),
        description: "Transfer to race",
        isSplit: false,
        status: "CLEARED",
        toAccountId: fixture.destinationOne.id,
        type: "transfer",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    const results = await withTimeout(
      Promise.allSettled([
        updateTransactionForFamily({
          data: {
            id: transfer.id,
            accountId: fixture.source.id,
            amount: 150_000n,
            currency: "IDR",
            date: new Date("2026-05-30T00:03:01.000Z"),
            description: "Updated transfer during delete",
            idempotencyKey: factories.createIdempotencyKey(),
            isSplit: false,
            status: "CLEARED",
            toAccountId: fixture.destinationTwo.id,
            type: "transfer",
          },
          familyId: fixture.owner.family.id,
          user: fixture.owner.user,
        }),
        deleteTransactionForFamily({
          id: transfer.id,
          idempotencyKey: factories.createIdempotencyKey(),
          familyId: fixture.owner.family.id,
          user: fixture.owner.user,
        }),
      ]),
      5_000
    )

    const rejectedMessages = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            String(
              (result.reason as Error | undefined)?.message ?? result.reason
            ),
          ]
        : []
    )
    expect(rejectedMessages).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/deadlock|restrict|foreign key/i),
      ])
    )
    expect(results.some((result) => result.status === "fulfilled")).toBe(true)

    const snapshots = await readAccountSnapshots(fixture.owner.family.id, [
      fixture.source.id,
      fixture.destinationOne.id,
      fixture.destinationTwo.id,
    ])
    const balances = [
      snapshots.get(fixture.source.id)?.balance,
      snapshots.get(fixture.destinationOne.id)?.balance,
      snapshots.get(fixture.destinationTwo.id)?.balance,
    ]
    expect([
      [1_000_000n, 100_000n, 100_000n],
      [850_000n, 100_000n, 250_000n],
    ]).toContainEqual(balances)
  })

  test("bulk create of 50 rows concurrent with single create applies one atomic aggregate delta", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Bulk concurrent account",
    })
    const category = await factories.createCategory({
      familyId: owner.family.id,
      name: "Bulk category",
      type: "income",
    })

    await Promise.all([
      bulkCreateTransactionsForFamily({
        data: {
          idempotencyKey: factories.createIdempotencyKey(),
          transactions: Array.from({ length: 50 }, (_, index) => ({
            id: factories.createIdempotencyKey(),
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: account.id,
            amount: 1_000n,
            categoryId: category.id,
            date: new Date(
              `2026-05-30T00:04:${String(index).padStart(2, "0")}.000Z`
            ),
            description: `Bulk income ${index + 1}`,
            merchantId: null,
            notes: null,
            status: "CLEARED" as const,
            type: "income" as const,
          })),
        },
        familyId: owner.family.id,
        user: owner.user,
      }),
      createTransactionForFamily({
        data: {
          id: factories.createIdempotencyKey(),
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: account.id,
          amount: 7_000n,
          categoryId: category.id,
          currency: "IDR",
          date: new Date("2026-05-30T00:05:00.000Z"),
          description: "Single expense racing bulk",
          isSplit: false,
          status: "CLEARED",
          type: "expense",
        },
        familyId: owner.family.id,
        user: owner.user,
      }),
    ])

    const [transactionCount, snapshots] = await Promise.all([
      harness.withFamily(owner.family.id, (tx) =>
        tx.transaction.count({
          where: { accountId: account.id, familyId: owner.family.id },
        })
      ),
      readAccountSnapshots(owner.family.id, [account.id]),
    ])

    expect(transactionCount).toBe(51)
    expect(snapshots.get(account.id)).toMatchObject({
      balance: 143_000n,
      version: 2,
    })
  })

  async function createTransferFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [source, destinationOne, destinationTwo] = await Promise.all([
      factories.createAccount({
        balance: 1_000_000n,
        familyId: owner.family.id,
        name: "Source account",
      }),
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "Destination one",
      }),
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "Destination two",
      }),
    ])

    return { destinationOne, destinationTwo, owner, source }
  }

  async function readAccountSnapshots(
    familyId: string,
    accountIds: string[]
  ): Promise<Map<string, AccountSnapshot>> {
    const rows = await harness.withFamily(familyId, (tx) =>
      tx.account.findMany({
        where: { id: { in: accountIds }, familyId },
        select: { balance: true, id: true, version: true },
      })
    )

    return new Map(rows.map((row) => [row.id, row]))
  }
})

async function loadRetryModule(): Promise<WithRetryModule> {
  const retryModulePath = new URL(
    "../../src/server/middleware/with-retry.ts",
    import.meta.url
  ).href
  return (await import(retryModulePath)) as unknown as WithRetryModule
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${ms}ms`))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
