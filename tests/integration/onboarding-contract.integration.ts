import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { randomUUID } from "node:crypto"
import { auth } from "../../src/server/auth.server"
import { initializeOnboardingForUser } from "../../src/server/onboarding-service"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("onboarding contract", () => {
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

  test("newly signed-up users are created without a family", async () => {
    const email = "signup-contract@permoney.local"
    const signupCredential = `PermoneyTest-${randomUUID()}`

    const result = await auth.api.signUpEmail({
      body: {
        email,
        name: "Signup Contract",
        password: signupCredential,
      },
      headers: new Headers(),
    })

    const [user, familyCount] = await Promise.all([
      harness.prisma.user.findUniqueOrThrow({
        where: { id: result.user.id },
      }),
      harness.prisma.family.count(),
    ])

    expect(user.email).toBe(email)
    expect(user.familyId).toBeNull()
    expect(familyCount).toBe(0)
  })

  test("onboarding initialization creates one family and replay returns it", async () => {
    const idempotencyKey = factories.createIdempotencyKey()
    const user = await factories.createUser({
      email: "onboarding-replay@permoney.local",
      familyId: null,
      name: "Onboarding Replay",
    })

    const first = await initializeOnboardingForUser(harness.prisma, user.id, {
      idempotencyKey,
    })
    const storedAfterFirst = await harness.prisma.user.findFirstOrThrow({
      where: { familyId: first.familyId, id: user.id },
    })
    const second = await initializeOnboardingForUser(
      harness.prisma,
      storedAfterFirst.id,
      { idempotencyKey }
    )

    const storedUser = await harness.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    })
    const families = await harness.prisma.family.findMany()
    const scopedRows = await harness.withFamily(first.familyId, async (tx) => {
      const accounts = await tx.account.findMany({
        where: { familyId: first.familyId },
      })
      const transactions = await tx.transaction.findMany({
        where: { familyId: first.familyId },
      })
      const auditLogs = await tx.auditLog.findMany({
        where: { familyId: first.familyId },
        orderBy: { entityType: "asc" },
      })
      const idempotencyRecords = await tx.idempotencyRecord.findMany({
        where: {
          endpoint: "initializeOnboardingForUser",
          familyId: first.familyId,
          key: idempotencyKey,
        },
      })
      return { accounts, auditLogs, idempotencyRecords, transactions }
    })

    expect(first.created).toBe(true)
    expect(second).toEqual(first)
    expect(storedUser.familyId).toBe(first.familyId)
    expect(families).toHaveLength(1)
    expect(families[0]?.name).toBe("Onboarding Replay's Family")

    expect(scopedRows.accounts).toHaveLength(1)
    expect(scopedRows.transactions).toHaveLength(1)
    expect(scopedRows.idempotencyRecords).toHaveLength(1)

    const account = scopedRows.accounts[0]!
    const transaction = scopedRows.transactions[0]!

    expect(first.accountId).toBe(account.id)
    expect(first.sampleTransactionId).toBe(transaction.id)
    expect(account.familyId).toBe(first.familyId)
    expect(transaction.familyId).toBe(first.familyId)
    expect(transaction.accountId).toBe(account.id)
    expect(transaction.userId).toBe(user.id)
    expect(transaction.type).toBe("expense")
    expect(transaction.amount).toBeLessThan(0n)
    expect(transaction.idempotencyKey).toBe(idempotencyKey)
    expect(transaction.accountBalanceAfter).toBe(account.balance)

    const replayRows = await harness.withFamily(first.familyId, async (tx) => {
      const accountAfterReplay = await tx.account.findUniqueOrThrow({
        where: { id: account.id },
      })
      const transactionCount = await tx.transaction.count({
        where: { familyId: first.familyId },
      })
      const auditCount = await tx.auditLog.count({
        where: { familyId: first.familyId },
      })
      return { accountAfterReplay, auditCount, transactionCount }
    })

    expect(replayRows.accountAfterReplay.balance).toBe(account.balance)
    expect(replayRows.transactionCount).toBe(1)
    expect(replayRows.auditCount).toBe(3)

    expect(
      scopedRows.auditLogs.map((log) => ({
        action: log.action,
        entityId: log.entityId,
        entityType: log.entityType,
        idempotencyKey: log.idempotencyKey,
      }))
    ).toEqual([
      {
        action: "create",
        entityId: account.id,
        entityType: "Account",
        idempotencyKey,
      },
      {
        action: "create",
        entityId: first.familyId,
        entityType: "Family",
        idempotencyKey,
      },
      {
        action: "create",
        entityId: transaction.id,
        entityType: "Transaction",
        idempotencyKey,
      },
    ])
  })

  test("concurrent onboarding initialization does not duplicate families", async () => {
    const idempotencyKey = factories.createIdempotencyKey()
    const user = await factories.createUser({
      email: "onboarding-concurrent@permoney.local",
      familyId: null,
      name: "Onboarding Concurrent",
    })

    const [first, second] = await Promise.all([
      initializeOnboardingForUser(harness.prisma, user.id, {
        idempotencyKey,
      }),
      initializeOnboardingForUser(harness.prisma, user.id, {
        idempotencyKey,
      }),
    ])

    const storedUser = await harness.prisma.user.findFirstOrThrow({
      where: { familyId: first.familyId, id: user.id },
    })
    const familyCount = await harness.prisma.family.count()
    const scopedCounts = await harness.withFamily(
      first.familyId,
      async (tx) => {
        const accountCount = await tx.account.count({
          where: { familyId: first.familyId },
        })
        const transactionCount = await tx.transaction.count({
          where: { familyId: first.familyId },
        })
        const auditCount = await tx.auditLog.count({
          where: { familyId: first.familyId },
        })
        const idempotencyRecordCount = await tx.idempotencyRecord.count({
          where: {
            endpoint: "initializeOnboardingForUser",
            familyId: first.familyId,
            key: idempotencyKey,
          },
        })
        return {
          accountCount,
          auditCount,
          idempotencyRecordCount,
          transactionCount,
        }
      }
    )

    expect(second).toEqual(first)
    expect(storedUser.familyId).toBe(first.familyId)
    expect(familyCount).toBe(1)
    expect(scopedCounts.accountCount).toBe(1)
    expect(scopedCounts.transactionCount).toBe(1)
    expect(scopedCounts.auditCount).toBe(3)
    expect(scopedCounts.idempotencyRecordCount).toBe(1)
  })
})
