import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  createTransactionForFamily,
  IdempotencyConflictError,
} from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("transaction idempotency", () => {
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

  test("same idempotency key fired in parallel creates one ledger row and one balance mutation", async () => {
    const { account, category, owner } = await createLedgerFixture()
    const transactionId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()
    const payload = {
      id: transactionId,
      idempotencyKey,
      accountId: account.id,
      amount: 12_345n,
      categoryId: category.id,
      date: new Date("2026-05-23T00:00:00.000Z"),
      description: "Parallel idempotent expense",
      type: "expense",
    }

    const responses = await Promise.all([
      createTransactionForFamily({
        data: payload,
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      }),
      createTransactionForFamily({
        data: payload,
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      }),
      createTransactionForFamily({
        data: payload,
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      }),
    ])

    const [transactions, storedAccount] = await Promise.all([
      harness.withFamily(owner.family.id, (tx) =>
        tx.transaction.findMany({
          where: { familyId: owner.family.id, idempotencyKey },
          orderBy: { createdAt: "asc" },
        })
      ),
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: account.id } })
      ),
    ])

    expect(responses.map((response) => response.id)).toEqual([
      transactionId,
      transactionId,
      transactionId,
    ])
    expect(transactions).toHaveLength(1)
    expect(transactions[0]?.amount).toBe(-12_345n)
    expect(storedAccount.balance).toBe(87_655n)
  })

  test("same idempotency key with a different payload fails with conflict", async () => {
    const { account, category, owner } = await createLedgerFixture()
    const idempotencyKey = factories.createIdempotencyKey()

    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey,
        accountId: account.id,
        amount: 12_345n,
        categoryId: category.id,
        date: new Date("2026-05-23T00:00:00.000Z"),
        description: "Original idempotent expense",
        type: "expense",
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withMember,
      user: owner.user,
    })

    await expect(
      createTransactionForFamily({
        data: {
          id: factories.createIdempotencyKey(),
          idempotencyKey,
          accountId: account.id,
          amount: 22_000n,
          categoryId: category.id,
          date: new Date("2026-05-23T00:00:00.000Z"),
          description: "Different idempotent expense",
          type: "expense",
        },
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  test("missing idempotency key on createTransactionForFamily is rejected", async () => {
    const { account, category, owner } = await createLedgerFixture()
    const payloadWithoutKey: Record<string, unknown> = {
      id: factories.createIdempotencyKey(),
      accountId: account.id,
      amount: 12_345n,
      categoryId: category.id,
      date: new Date("2026-05-23T00:00:00.000Z"),
      description: "Missing idempotency key expense",
      type: "expense",
    }

    await expect(
      createTransactionForFamily({
        data: payloadWithoutKey,
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).rejects.toThrow(/idempotency/i)
  })

  test("expired IdempotencyRecord rows can be purged so the same scoped key is reusable", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const key = factories.createIdempotencyKey()
    const endpoint = "createTransactionFn"

    await harness.withFamily(owner.family.id, async (tx) => {
      await tx.idempotencyRecord.create({
        data: {
          endpoint,
          expiresAt: new Date("2026-05-22T00:00:00.000Z"),
          familyId: owner.family.id,
          key,
          requestHash: "expired-hash",
          responseJson: { ok: true },
          statusCode: 200,
        },
      })

      await tx.$executeRaw`
        DELETE FROM "IdempotencyRecord"
        WHERE "expiresAt" < ${new Date("2026-05-23T00:00:00.000Z")}
      `

      await tx.idempotencyRecord.create({
        data: {
          endpoint,
          expiresAt: new Date("2026-05-24T00:00:00.000Z"),
          familyId: owner.family.id,
          key,
          requestHash: "fresh-hash",
          responseJson: { ok: true },
          statusCode: 200,
        },
      })
    })

    const records = await harness.withFamily(owner.family.id, (tx) =>
      tx.idempotencyRecord.findMany({
        where: { endpoint, familyId: owner.family.id, key },
      })
    )

    expect(records).toHaveLength(1)
    expect(records[0]?.requestHash).toBe("fresh-hash")
  })

  async function createLedgerFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, category] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "Idempotency checking",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "Idempotency category",
        type: "expense",
      }),
    ])

    return { account, category, owner }
  }
})
