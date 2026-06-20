import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { IdempotencyConflictError } from "../../src/server/idempotency"
import { initializeOnboardingForUser } from "../../src/server/onboarding-service"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("onboarding idempotency replay", () => {
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

  test("same idempotency key replays sequentially and in parallel without duplicate demo ledger state", async () => {
    const signedUpUser = await factories.createAuthenticatedUserWithoutFamily()
    const idempotencyKey = factories.createIdempotencyKey()

    expect(signedUpUser.serverContext.familyId).toBeNull()
    expect(signedUpUser.session.userId).toBe(signedUpUser.user.id)

    const first = await initializeOnboardingForUser(
      harness.prisma,
      signedUpUser.user.id,
      { idempotencyKey, currency: "USD" }
    )
    const sequentialReplay = await initializeOnboardingForUser(
      harness.prisma,
      signedUpUser.user.id,
      { idempotencyKey, currency: "USD" }
    )
    const parallelReplays = await Promise.all([
      initializeOnboardingForUser(harness.prisma, signedUpUser.user.id, {
        idempotencyKey,
        currency: "USD",
      }),
      initializeOnboardingForUser(harness.prisma, signedUpUser.user.id, {
        idempotencyKey,
        currency: "USD",
      }),
    ])

    expect([sequentialReplay, ...parallelReplays]).toEqual([
      first,
      first,
      first,
    ])

    const state = await readOnboardingLedgerState(
      first.familyId,
      idempotencyKey
    )
    const storedUser = await harness.prisma.user.findUniqueOrThrow({
      where: { id: signedUpUser.user.id },
    })

    expect(first.created).toBe(true)
    expect(storedUser.familyId).toBe(first.familyId)
    expect(state.families).toHaveLength(1)
    expect(state.accounts).toHaveLength(1)
    expect(state.transactions).toHaveLength(1)
    expect(state.auditLogs).toHaveLength(3)
    expect(state.idempotencyRecords).toHaveLength(1)

    const family = state.families[0]!
    const account = state.accounts[0]!
    const transaction = state.transactions[0]!
    const idempotencyRecord = state.idempotencyRecords[0]!

    expect(family.id).toBe(first.familyId)
    expect(account.id).toBe(first.accountId)
    expect(transaction.id).toBe(first.sampleTransactionId)
    expect(account.balance).toBe(8_750_000n)
    expect(transaction.amount).toBe(-1_250_000n)
    expect(transaction.accountBalanceAfter).toBe(account.balance)
    expect(transaction.familyId).toBe(first.familyId)
    expect(transaction.accountId).toBe(account.id)
    expect(transaction.userId).toBe(signedUpUser.user.id)
    expect(transaction.idempotencyKey).toBe(idempotencyKey)
    expect(idempotencyRecord.endpoint).toBe("initializeOnboardingForUser")
    expect(idempotencyRecord.key).toBe(idempotencyKey)
    expect(idempotencyRecord.responseJson).toEqual(first)
    expect(idempotencyRecord.statusCode).toBe(200)

    expect(
      state.auditLogs.map((log) => ({
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
        entityId: family.id,
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

    const conflictingUser = await factories.createUser({
      email: "onboarding-replay-conflict@permoney.local",
      familyId: first.familyId,
      name: "Onboarding Replay Conflict",
    })
    // ADR-0036: a user pointing at a family must be an active member for the
    // onboarding replay/conflict path to read its IdempotencyRecord under the
    // membership guard. Without this the guard hides the record and the
    // same-key/different-payload conflict can't be detected.
    await factories.createFamilyMember({
      familyId: first.familyId,
      userId: conflictingUser.id,
      role: "member",
    })
    const beforeConflictSummary = summarizeState(state)

    await expect(
      initializeOnboardingForUser(harness.prisma, conflictingUser.id, {
        idempotencyKey,
        currency: "USD",
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    const afterConflictState = await readOnboardingLedgerState(
      first.familyId,
      idempotencyKey
    )

    expect(summarizeState(afterConflictState)).toEqual(beforeConflictSummary)
  })

  async function readOnboardingLedgerState(
    familyId: string,
    idempotencyKey: string
  ) {
    const families = await harness.prisma.family.findMany({
      orderBy: { id: "asc" },
    })
    const scopedRows = await harness.withFamily(familyId, async (tx) => {
      const accounts = await tx.account.findMany({
        orderBy: { id: "asc" },
        where: { familyId },
      })
      const transactions = await tx.transaction.findMany({
        orderBy: { id: "asc" },
        where: { familyId },
      })
      const auditLogs = await tx.auditLog.findMany({
        orderBy: [{ entityType: "asc" }, { entityId: "asc" }],
        where: { familyId },
      })
      const idempotencyRecords = await tx.idempotencyRecord.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: {
          endpoint: "initializeOnboardingForUser",
          familyId,
          key: idempotencyKey,
        },
      })

      return { accounts, auditLogs, idempotencyRecords, transactions }
    })

    return { families, ...scopedRows }
  }

  function summarizeState(
    state: Awaited<ReturnType<typeof readOnboardingLedgerState>>
  ) {
    const account = state.accounts[0]
    const transaction = state.transactions[0]

    return {
      accountBalance: account?.balance,
      accountCount: state.accounts.length,
      accountIds: state.accounts.map((row) => row.id),
      auditLogSignatures: state.auditLogs.map((row) => ({
        action: row.action,
        entityId: row.entityId,
        entityType: row.entityType,
        idempotencyKey: row.idempotencyKey,
      })),
      auditLogCount: state.auditLogs.length,
      familyCount: state.families.length,
      familyIds: state.families.map((row) => row.id),
      idempotencyRecordCount: state.idempotencyRecords.length,
      idempotencyRecords: state.idempotencyRecords.map((row) => ({
        endpoint: row.endpoint,
        key: row.key,
        responseJson: row.responseJson,
        statusCode: row.statusCode,
      })),
      transactionAmount: transaction?.amount,
      transactionBalanceAfter: transaction?.accountBalanceAfter,
      transactionCount: state.transactions.length,
      transactionIds: state.transactions.map((row) => row.id),
    }
  }
})
