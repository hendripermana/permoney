import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AuditLog } from "@prisma/client"
type JsonObj = Record<string, unknown>
import {
  bulkCreateTransactionsForFamily,
  bulkDeleteTransactionsForFamily,
  bulkUpdateTransactionsForFamily,
  createTransactionForFamily,
  deleteTransactionForFamily,
  updateTransactionForFamily,
} from "../../src/server/transactions"
import {
  createSmartRuleForFamily,
  deleteSmartRuleForFamily,
} from "../../src/server/smart-rules"
import { initializeOnboardingForUser } from "../../src/server/onboarding-service"
import { getAuditLogFn, getAuditLogForFamily } from "../../src/server/audit-log"
import { auditLog, createAuditContext } from "../../src/server/middleware/audit"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("AuditLog Integration & Security Tests", () => {
  let harness: IntegrationHarness
  let factories: TestFactories
  const AUDIT_TEST_DATE = new Date("2026-05-24T00:00:00.000Z")

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

  // Fixture helper
  async function createFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, category] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "Test Account",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "Test Category",
        type: "expense",
      }),
    ])
    return { owner, account, category }
  }

  async function auditLogBaseline(familyId: string): Promise<Set<string>> {
    const baselineLogs = await harness.withFamily(familyId, (tx) =>
      tx.auditLog.findMany({ select: { id: true } })
    )
    return new Set(baselineLogs.map((log) => log.id))
  }

  function logsSince<T extends { id: string }>(
    logs: readonly T[],
    baselineIds: ReadonlySet<string>
  ): T[] {
    return logs.filter((log) => !baselineIds.has(log.id))
  }

  async function orderedAuditLogsSince(
    familyId: string,
    baselineIds: ReadonlySet<string>
  ): Promise<AuditLog[]> {
    const logs = await harness.withFamily(familyId, (tx) =>
      tx.auditLog.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    )
    return logsSince(logs, baselineIds)
  }

  function expenseCreatePayload({
    accountId,
    amount,
    categoryId,
    description,
    id,
    idempotencyKey,
  }: {
    accountId: string
    amount: bigint
    categoryId: string
    description: string
    id: string
    idempotencyKey: string
  }) {
    return {
      id,
      idempotencyKey,
      accountId,
      amount,
      categoryId,
      date: AUDIT_TEST_DATE,
      description,
      type: "expense" as const,
    }
  }

  function expenseUpdatePayload({
    accountId,
    amount,
    categoryId,
    description,
    id,
  }: {
    accountId: string
    amount: bigint
    categoryId: string
    description: string
    id: string
  }) {
    return {
      id,
      accountId,
      amount,
      categoryId,
      date: AUDIT_TEST_DATE,
      description,
      currency: "IDR",
      isSplit: false,
      status: "CLEARED" as const,
      type: "expense" as const,
    }
  }

  function transferPayload({
    accountId,
    amount,
    description,
    id,
    idempotencyKey,
    toAccountId,
  }: {
    accountId: string
    amount: bigint
    description: string
    id: string
    idempotencyKey?: string
    toAccountId: string
  }) {
    return {
      id,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      accountId,
      amount,
      currency: "IDR",
      date: AUDIT_TEST_DATE,
      description,
      isSplit: false,
      status: "CLEARED" as const,
      toAccountId,
      type: "transfer" as const,
    }
  }

  async function createTransferFixture({
    amount,
    description,
    destinationBalance,
    destinationName,
    sourceName,
  }: {
    amount: bigint
    description: string
    destinationBalance: bigint
    destinationName: string
    sourceName: string
  }) {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [sourceAccount, destinationAccount] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: sourceName,
      }),
      factories.createAccount({
        balance: destinationBalance,
        familyId: owner.family.id,
        name: destinationName,
      }),
    ])
    const transferTransactionId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()

    await createTransactionForFamily({
      data: transferPayload({
        id: transferTransactionId,
        idempotencyKey,
        accountId: sourceAccount.id,
        amount,
        description,
        toAccountId: destinationAccount.id,
      }),
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    const transfer = await harness.withFamily(owner.family.id, (tx) =>
      tx.transfer.findFirstOrThrow({
        where: { outflowTransactionId: transferTransactionId },
      })
    )

    return {
      owner,
      sourceAccount,
      destinationAccount,
      transfer,
      transferTransactionId,
    }
  }

  function bulkExpensePayload({
    accountId,
    amount,
    categoryId,
    description,
    id,
  }: {
    accountId: string
    amount: bigint
    categoryId: string
    description: string
    id: string
  }) {
    return {
      id,
      accountId,
      amount,
      categoryId,
      date: AUDIT_TEST_DATE,
      description,
      status: "CLEARED" as const,
      type: "expense" as const,
    }
  }

  async function writeCustomAuditLog({
    entityId,
    owner,
  }: {
    entityId: string
    owner: Awaited<ReturnType<typeof createFixture>>["owner"]
  }): Promise<void> {
    const auditCtx = await createAuditContext({
      user: { id: owner.user.id, familyId: owner.family.id },
    })

    await harness.withFamily(owner.family.id, async (tx) => {
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "CustomTest",
        entityId,
        after: { val: 1 },
      })
    })
  }

  test("1. createTransactionForFamily writes expected AuditLog rows including Account/update", async () => {
    const { owner, account, category } = await createFixture()
    const txId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()

    await createTransactionForFamily({
      data: expenseCreatePayload({
        id: txId,
        idempotencyKey,
        accountId: account.id,
        amount: 10_000n,
        categoryId: category.id,
        description: "Audit test expense",
      }),
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    const logs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    )

    // Ekspektasikan 2 audit log: 1 untuk Account/update dan 1 untuk Transaction/create
    expect(logs).toHaveLength(2)

    const accountLog = logs[0]!
    expect(accountLog.entityType).toBe("Account")
    expect(accountLog.entityId).toBe(account.id)
    expect(accountLog.action).toBe("update")
    expect((accountLog.beforeJson as JsonObj).balance).toBe("100000")
    expect((accountLog.afterJson as JsonObj).balance).toBe("90000") // 100,000 - 10,000 expense

    const transactionLog = logs[1]!
    expect(transactionLog.entityType).toBe("Transaction")
    expect(transactionLog.entityId).toBe(txId)
    expect(transactionLog.action).toBe("create")
    expect(transactionLog.beforeJson).toBeNull()
    expect((transactionLog.afterJson as JsonObj).amount).toBe("-10000")
  })

  test("2. updateTransactionFn writes full before/after audit snapshots", async () => {
    const { owner, account, category } = await createFixture()
    const txId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()

    // 1. Buat transaksi awal
    await createTransactionForFamily({
      data: expenseCreatePayload({
        id: txId,
        idempotencyKey,
        accountId: account.id,
        amount: 10_000n,
        categoryId: category.id,
        description: "Initial expense",
      }),
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    // Catat ID log yang sudah ada untuk memisahkan log baru
    const baselineIds = await auditLogBaseline(owner.family.id)

    // 2. Jalankan updateTransactionForFamily secara langsung
    await updateTransactionForFamily({
      data: expenseUpdatePayload({
        id: txId,
        accountId: account.id,
        amount: 15_000n, // Naikkan amount
        categoryId: category.id,
        description: "Updated expense",
      }),
      familyId: owner.family.id,
      user: owner.user,
    })

    const logs = await orderedAuditLogsSince(owner.family.id, baselineIds)

    // Ekspektasikan 2 audit log: 1 untuk Account/update dan 1 untuk Transaction/update
    expect(logs).toHaveLength(2)

    const accountLog = logs[0]!
    expect(accountLog.entityType).toBe("Account")
    expect(accountLog.action).toBe("update")
    expect((accountLog.beforeJson as JsonObj).balance).toBe("90000")
    expect((accountLog.afterJson as JsonObj).balance).toBe("85000") // reversal + new amount = 100k - 15k = 85k

    const transactionLog = logs[1]!
    expect(transactionLog.entityType).toBe("Transaction")
    expect(transactionLog.action).toBe("update")
    expect((transactionLog.beforeJson as JsonObj).amount).toBe("-10000")
    expect((transactionLog.afterJson as JsonObj).amount).toBe("-15000")
  })

  test("3. deleteTransactionFn writes soft_delete audit logs and Account balance revert", async () => {
    const { owner, account, category } = await createFixture()
    const txId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()

    await createTransactionForFamily({
      data: expenseCreatePayload({
        id: txId,
        idempotencyKey,
        accountId: account.id,
        amount: 20_000n,
        categoryId: category.id,
        description: "To be deleted",
      }),
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    // Catat ID log yang sudah ada untuk memisahkan log baru
    const baselineIds = await auditLogBaseline(owner.family.id)

    // Jalankan soft delete secara langsung
    await deleteTransactionForFamily({
      id: txId,
      familyId: owner.family.id,
      user: owner.user,
    })

    const logs = await orderedAuditLogsSince(owner.family.id, baselineIds)

    expect(logs).toHaveLength(2)

    const accountLog = logs[0]!
    expect(accountLog.entityType).toBe("Account")
    expect(accountLog.action).toBe("update")
    expect((accountLog.beforeJson as JsonObj).balance).toBe("80000")
    expect((accountLog.afterJson as JsonObj).balance).toBe("100000") // Kembali ke 100k setelah soft delete

    const transactionLog = logs[1]!
    expect(transactionLog.entityType).toBe("Transaction")
    expect(transactionLog.action).toBe("soft_delete")
    expect((transactionLog.beforeJson as JsonObj).deletedAt).toBeNull()
    expect((transactionLog.afterJson as JsonObj).deletedAt).not.toBeNull()
  })

  test("transfer create and delete audit the Transfer graph without hard-deleting it", async () => {
    const { owner, transfer, transferTransactionId } =
      await createTransferFixture({
        amount: 15_000n,
        description: "Audited transfer",
        destinationBalance: 25_000n,
        destinationName: "Transfer destination",
        sourceName: "Transfer source",
      })

    await deleteTransactionForFamily({
      id: transferTransactionId,
      familyId: owner.family.id,
      user: owner.user,
    })

    const [transferAfterDelete, transferLogs] = await Promise.all([
      harness.withFamily(owner.family.id, (tx) =>
        tx.transfer.findUniqueOrThrow({
          where: { id: transfer.id },
          include: {
            inflowTransaction: true,
            outflowTransaction: true,
          },
        })
      ),
      harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: {
            entityId: transfer.id,
            entityType: "Transfer",
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      ),
    ])

    expect(transferAfterDelete.outflowTransaction.deletedAt).not.toBeNull()
    expect(transferAfterDelete.inflowTransaction.deletedAt).not.toBeNull()
    expect(transferLogs.map((log) => log.action).sort()).toEqual([
      "create",
      "soft_delete",
    ])
    const softDeleteLog = transferLogs.find(
      (log) => log.action === "soft_delete"
    )
    expect(softDeleteLog).toBeDefined()
    const afterJson = softDeleteLog!.afterJson as JsonObj
    expect((afterJson.outflowTransaction as JsonObj).deletedAt).not.toBeNull()
    expect((afterJson.inflowTransaction as JsonObj).deletedAt).not.toBeNull()
  })

  test("transfer update keeps Transfer audit identity stable", async () => {
    const {
      destinationAccount,
      owner,
      sourceAccount,
      transfer,
      transferTransactionId,
    } = await createTransferFixture({
      amount: 10_000n,
      description: "Transfer before update",
      destinationBalance: 10_000n,
      destinationName: "Transfer update destination",
      sourceName: "Transfer update source",
    })
    const baselineIds = await auditLogBaseline(owner.family.id)

    await updateTransactionForFamily({
      data: transferPayload({
        id: transferTransactionId,
        accountId: sourceAccount.id,
        amount: 12_500n,
        description: "Transfer after update",
        toAccountId: destinationAccount.id,
      }),
      familyId: owner.family.id,
      user: owner.user,
    })

    const [transferAfterUpdate, logsAfterUpdate] = await Promise.all([
      harness.withFamily(owner.family.id, (tx) =>
        tx.transfer.findFirstOrThrow({
          where: { outflowTransactionId: transferTransactionId },
        })
      ),
      harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: {
            action: "update",
            entityId: transfer.id,
            entityType: "Transfer",
          },
        })
      ),
    ])
    const newLogs = logsSince(logsAfterUpdate, baselineIds)

    expect(transferAfterUpdate.id).toBe(transfer.id)
    expect(newLogs).toHaveLength(1)
    expect((newLogs[0]!.beforeJson as JsonObj).id).toBe(transfer.id)
    expect((newLogs[0]!.afterJson as JsonObj).id).toBe(transfer.id)
  })

  test("bulk transaction helpers audit create, update, and soft_delete paths", async () => {
    const { owner, account, category } = await createFixture()
    const secondCategory = await factories.createCategory({
      familyId: owner.family.id,
      name: "Bulk updated category",
      type: "expense",
    })
    const [firstId, secondId] = [
      factories.createIdempotencyKey(),
      factories.createIdempotencyKey(),
    ]

    await bulkCreateTransactionsForFamily({
      data: {
        transactions: [
          bulkExpensePayload({
            id: firstId,
            accountId: account.id,
            amount: 1_000n,
            categoryId: category.id,
            description: "Bulk first",
          }),
          bulkExpensePayload({
            id: secondId,
            accountId: account.id,
            amount: 2_000n,
            categoryId: category.id,
            description: "Bulk second",
          }),
        ],
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const createLogs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { action: "create", entityType: "Transaction" },
      })
    )
    expect(createLogs).toHaveLength(2)

    const baselineAfterCreateIds = await auditLogBaseline(owner.family.id)

    await bulkUpdateTransactionsForFamily({
      data: {
        ids: [firstId, secondId],
        categoryId: secondCategory.id,
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const updateLogs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { action: "update" },
      })
    )
    const newUpdateLogs = logsSince(updateLogs, baselineAfterCreateIds)
    expect(
      newUpdateLogs.filter((log) => log.entityType === "Transaction")
    ).toHaveLength(2)
    expect(newUpdateLogs.some((log) => log.entityType === "Account")).toBe(
      false
    )

    const baselineAfterUpdateIds = await auditLogBaseline(owner.family.id)

    await bulkDeleteTransactionsForFamily({
      ids: [firstId, secondId],
      familyId: owner.family.id,
      user: owner.user,
    })

    const logsAfterDelete = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany()
    )
    const newDeleteLogs = logsSince(logsAfterDelete, baselineAfterUpdateIds)
    expect(
      newDeleteLogs.filter(
        (log) =>
          log.action === "soft_delete" && log.entityType === "Transaction"
      )
    ).toHaveLength(2)
    expect(
      newDeleteLogs.filter(
        (log) => log.action === "update" && log.entityType === "Account"
      )
    ).toHaveLength(1)
  })

  test("smart rule create and delete write audit rows", async () => {
    const { owner, category } = await createFixture()

    const rule = await createSmartRuleForFamily({
      data: {
        categoryId: category.id,
        keyword: "Coffee",
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await deleteSmartRuleForFamily({
      id: rule.id,
      familyId: owner.family.id,
      user: owner.user,
    })

    const logs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: rule.id, entityType: "SmartRule" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    )

    expect(logs.map((log) => log.action)).toEqual(["create", "delete"])
    expect(logs[0]!.beforeJson).toBeNull()
    expect((logs[0]!.afterJson as JsonObj).keyword).toBe("coffee")
    expect((logs[1]!.beforeJson as JsonObj).keyword).toBe("coffee")
    expect(logs[1]!.afterJson).toBeNull()
  })

  test("4. Failed transaction rolls back (rollback) audit log writing", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const auditCtx = await createAuditContext({
      user: { id: owner.user.id, familyId: owner.family.id },
    })

    await expect(
      harness.withFamily(owner.family.id, async (tx) => {
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "CustomTest",
          entityId: "test-rollback",
          after: { val: 42 },
        })
        // Buat error database yang memicu rollback otomatis
        throw new Error("Force transactional rollback")
      })
    ).rejects.toThrow("Force transactional rollback")

    const logs = await harness.prisma.auditLog.findMany({
      where: { entityType: "CustomTest" },
    })
    expect(logs).toHaveLength(0)
  })

  test("5. Idempotency replay does not write duplicate audit logs", async () => {
    const { owner, account, category } = await createFixture()
    const txId = factories.createIdempotencyKey()
    const idempotencyKey = factories.createIdempotencyKey()

    const payload = expenseCreatePayload({
      id: txId,
      idempotencyKey,
      accountId: account.id,
      amount: 5_000n,
      categoryId: category.id,
      description: "Idempotency audit check",
    })

    // Call 1
    await createTransactionForFamily({
      data: payload,
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    // Call 2 (Replay)
    await createTransactionForFamily({
      data: payload,
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    const logs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { idempotencyKey },
      })
    )

    // Hanya boleh ada 2 entri (1 Account/update dan 1 Transaction/create) bukan berlipat ganda
    expect(logs).toHaveLength(2)
  })

  test("6. UPDATE on AuditLog by runtime role is blocked (Postgres constraint)", async () => {
    const { owner } = await createFixture()
    await writeCustomAuditLog({ entityId: "test-update-block", owner })

    await expect(
      harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.updateMany({
          where: { entityType: "CustomTest" },
          data: { action: "update" },
        })
      )
    ).rejects.toThrow(/permission denied/i)
  })

  test("7. DELETE on AuditLog by runtime role is blocked (Postgres constraint)", async () => {
    const { owner } = await createFixture()
    await writeCustomAuditLog({ entityId: "test-delete-block", owner })

    await expect(
      harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.deleteMany({
          where: { entityType: "CustomTest" },
        })
      )
    ).rejects.toThrow(/permission denied/i)
  })

  test("runtime role cannot TRUNCATE AuditLog", async () => {
    const { owner } = await createFixture()
    await writeCustomAuditLog({ entityId: "test-truncate-block", owner })

    await expect(
      harness.withFamily(owner.family.id, (tx) =>
        tx.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')
      )
    ).rejects.toThrow(/permission denied|must be owner/i)
  })

  test("8. Cross-tenant access is blocked by RLS policy", async () => {
    const [familyA, familyB] = await Promise.all([
      factories.createAuthenticatedOnboardedUser(),
      factories.createAuthenticatedOnboardedUser(),
    ])

    const auditCtxB = await createAuditContext({
      user: { id: familyB.user.id, familyId: familyB.family.id },
    })
    await harness.withFamily(familyB.family.id, async (tx) => {
      await auditLog(tx, auditCtxB, {
        action: "create",
        entityType: "CustomTest",
        entityId: "secret-tenant-B",
        after: { val: 999 },
      })
    })

    // Coba baca dari Family A
    const logsForA = await harness.withFamily(familyA.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityType: "CustomTest" },
      })
    )
    expect(logsForA).toHaveLength(0)
  })

  test("9. getAuditLogFn works with pagination and filtering", async () => {
    expect(getAuditLogFn).toBeDefined()
    const owner = await factories.createAuthenticatedOnboardedUser()
    const auditCtx = await createAuditContext({
      user: { id: owner.user.id, familyId: owner.family.id },
    })

    // Buat 5 entri buatan dengan jeda waktu buatan agar urutan stabil
    await harness.withFamily(owner.family.id, async (tx) => {
      for (let i = 1; i <= 5; i++) {
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: i % 2 === 0 ? "TypeEven" : "TypeOdd",
          entityId: `id-${i}`,
          after: { index: i },
        })
        // Sedikit jeda
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    })

    // Coba query halaman 1 (limit: 3)
    const page1 = await getAuditLogForFamily({
      data: { limit: 3 },
      familyId: owner.family.id,
    })

    expect(page1.items).toHaveLength(3)
    expect(page1.hasNextPage).toBe(true)
    expect(page1.nextCursor).not.toBeNull()

    // Coba query halaman 2 menggunakan cursor dari halaman 1
    const page2 = await getAuditLogForFamily({
      data: {
        limit: 3,
        cursor: page1.nextCursor!,
      },
      familyId: owner.family.id,
    })

    expect(page2.items).toHaveLength(2) // Total 5 data, page 1 ambil 3, page 2 ambil sisa 2
    expect(page2.hasNextPage).toBe(false)
    expect(page2.nextCursor).toBeNull()

    // Coba filter by entityType
    const filtered = await getAuditLogForFamily({
      data: {
        limit: 10,
        entityType: "TypeEven",
      },
      familyId: owner.family.id,
    })
    expect(filtered.items).toHaveLength(2) // item 2 & 4
    expect(
      filtered.items.every((item: AuditLog) => item.entityType === "TypeEven")
    ).toBe(true)
  })

  test("10. onboarding writes a family create audit log", async () => {
    const user = await factories.createUser({
      email: "onboard-audit@permoney.local",
      familyId: null,
      name: "Audit Onboarding",
    })

    const result = await initializeOnboardingForUser(harness.prisma, user.id)

    // Cari audit log yang dicatat saat onboarding dengan scoped GUC familyId
    const logs = await harness.withFamily(result.familyId, (tx) =>
      tx.auditLog.findMany({
        where: { familyId: result.familyId },
      })
    )

    expect(logs).toHaveLength(1)
    const log = logs[0]!
    expect(log.entityType).toBe("Family")
    expect(log.action).toBe("create")
    expect(log.entityId).toBe(result.familyId)
  })
})
