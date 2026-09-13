import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  ReconcileTransactionNotFoundError,
  setTransactionReconciledForFamily,
  TransactionNotClearedError,
} from "@/server/transaction-reconciliation"
import {
  bulkDeleteTransactionsForFamily,
  createTransactionForFamily,
  deleteTransactionForFamily,
  ReconciledStatusNotDirectlyEditableError,
  ReconciledTransactionLockedError,
  updateTransactionForFamily,
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

// PER-83 Slice 1 — "Manual reconciliation workflow foundation". Proves the
// TRANSACTION-LEVEL reconcile state machine end to end against real Postgres:
// the PENDING guard, the CLEARED<->RECONCILED toggle, audit evidence in both
// directions, tenant isolation, idempotency-key replay, and — the single
// most important ledger-correctness invariant for this feature — that
// reconciling NEVER touches `amount` or the account's balance. Orthogonal to
// the account-level ground_truth anchor mechanism (ADR-0043); this suite
// never touches Valuation.

describe("Transaction reconciliation (PER-83 Slice 1)", () => {
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

  const seedTransaction = async (
    actor: AuthenticatedOnboardedUser,
    opts: { status?: "PENDING" | "CLEARED" | "RECONCILED" } = {}
  ) => {
    const account = await factories.createAccount({
      familyId: actor.family.id,
    })
    const trx = await factories.createTransaction({
      familyId: actor.family.id,
      accountId: account.id,
      userId: actor.user.id,
      status: opts.status,
    })
    return { account, trx }
  }

  const reconcile = (
    actor: AuthenticatedOnboardedUser,
    transactionId: string,
    reconciled: boolean
  ) =>
    setTransactionReconciledForFamily({
      data: {
        transactionId,
        reconciled,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: actor.family.id,
      userId: actor.user.id,
    })

  const readTransaction = (
    actor: AuthenticatedOnboardedUser,
    transactionId: string
  ) =>
    harness.withFamily(actor.family.id, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    )

  const readAccountBalance = (
    actor: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness
      .withFamily(actor.family.id, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: accountId } })
      )
      .then((a) => a.balance)

  describe("the PENDING guard", () => {
    test("rejects reconciling a PENDING transaction with a typed error", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "PENDING" })

      let captured: unknown
      try {
        await reconcile(owner, trx.id, true)
        expect.fail("Expected TransactionNotClearedError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(TransactionNotClearedError)

      const row = await readTransaction(owner, trx.id)
      expect(row.status).toBe("PENDING")
      expect(row.reconciledAt).toBeNull()
      expect(row.reconciledById).toBeNull()
    })

    test("un-reconciling a PENDING transaction is a harmless no-op, not an error", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "PENDING" })

      const result = await reconcile(owner, trx.id, false)

      expect(result.status).toBe("PENDING")
      expect(result.reconciledAt).toBeNull()
    })
  })

  describe("the CLEARED <-> RECONCILED toggle", () => {
    test("marks a CLEARED transaction RECONCILED with a timestamp and actor", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      const result = await reconcile(owner, trx.id, true)

      expect(result.status).toBe("RECONCILED")
      expect(result.reconciledAt).not.toBeNull()
      expect(result.reconciledById).toBe(owner.user.id)

      const row = await readTransaction(owner, trx.id)
      expect(row.status).toBe("RECONCILED")
      expect(row.reconciledById).toBe(owner.user.id)
    })

    test("un-reconciles a RECONCILED transaction back to CLEARED, clearing the metadata", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })
      await reconcile(owner, trx.id, true)

      const result = await reconcile(owner, trx.id, false)

      expect(result.status).toBe("CLEARED")
      expect(result.reconciledAt).toBeNull()
      expect(result.reconciledById).toBeNull()

      const row = await readTransaction(owner, trx.id)
      expect(row.status).toBe("CLEARED")
      expect(row.reconciledAt).toBeNull()
      expect(row.reconciledById).toBeNull()
    })

    test("un-reconciling an already-CLEARED transaction is a no-op success", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      const result = await reconcile(owner, trx.id, false)

      expect(result.status).toBe("CLEARED")
      expect(result.reconciledAt).toBeNull()
    })

    test('re-reconciling an already-RECONCILED row is idempotent on status but refreshes the timestamp ("last reconciliation wins")', async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      const first = await reconcile(owner, trx.id, true)
      // Force a strictly later wall-clock read.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const second = await reconcile(owner, trx.id, true)

      expect(second.status).toBe("RECONCILED")
      expect(first.reconciledAt).not.toBeNull()
      expect(second.reconciledAt).not.toBeNull()
      expect(new Date(second.reconciledAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(first.reconciledAt!).getTime()
      )
    })
  })

  describe("audit evidence", () => {
    test("captures a CLEARED -> RECONCILED transition", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      await reconcile(owner, trx.id, true)

      const audits = await harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Transaction", entityId: trx.id },
          orderBy: { createdAt: "asc" },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("update")
      const before = audits[0]?.beforeJson as { status?: string } | null
      const after = audits[0]?.afterJson as { status?: string } | null
      expect(before?.status).toBe("CLEARED")
      expect(after?.status).toBe("RECONCILED")
    })

    test("captures the reverse RECONCILED -> CLEARED transition as a second audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })
      await reconcile(owner, trx.id, true)

      await reconcile(owner, trx.id, false)

      const audits = await harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Transaction", entityId: trx.id },
          orderBy: { createdAt: "asc" },
        })
      )
      expect(audits).toHaveLength(2)
      const before = audits[1]?.beforeJson as { status?: string } | null
      const after = audits[1]?.afterJson as { status?: string } | null
      expect(before?.status).toBe("RECONCILED")
      expect(after?.status).toBe("CLEARED")
    })

    test("a genuine no-op (un-reconciling an already-CLEARED row) writes no audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      await reconcile(owner, trx.id, false)

      const audits = await harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Transaction", entityId: trx.id },
        })
      )
      expect(audits).toHaveLength(0)
    })
  })

  describe("tenant isolation", () => {
    test("family A cannot reconcile family B's transaction", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      let captured: unknown
      try {
        await reconcile(intruder, trx.id, true)
        expect.fail("Expected ReconcileTransactionNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(ReconcileTransactionNotFoundError)

      const row = await readTransaction(owner, trx.id)
      expect(row.status).toBe("CLEARED")
      expect(row.reconciledAt).toBeNull()
    })
  })

  describe("idempotency-key replay", () => {
    test("replaying the same key returns the same response without a second audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })
      const key = factories.createIdempotencyKey()
      const payload = {
        data: { transactionId: trx.id, reconciled: true, idempotencyKey: key },
        familyId: owner.family.id,
        userId: owner.user.id,
      }

      const first = await setTransactionReconciledForFamily(payload)
      const second = await setTransactionReconciledForFamily(payload)

      expect(second).toEqual(first)
      const audits = await harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Transaction", entityId: trx.id },
        })
      )
      expect(audits).toHaveLength(1)
    })
  })

  describe("ledger correctness — never touches amount or balance", () => {
    test("reconciling then un-reconciling leaves amount and account balance byte-identical", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { account, trx } = await seedTransaction(owner, {
        status: "CLEARED",
      })
      const balanceBefore = await readAccountBalance(owner, account.id)
      const rowBefore = await readTransaction(owner, trx.id)

      await reconcile(owner, trx.id, true)
      await reconcile(owner, trx.id, false)

      const balanceAfter = await readAccountBalance(owner, account.id)
      const rowAfter = await readTransaction(owner, trx.id)

      expect(balanceAfter).toBe(balanceBefore)
      expect(rowAfter.amount).toBe(rowBefore.amount)
      expect(rowAfter.accountBalanceAfter).toBe(rowBefore.accountBalanceAfter)
    })
  })

  describe("surviving a transaction edit (row replacement)", () => {
    // Mirrors setTransactionTagsForFamily's identical race (PER-145): editing
    // ANY OTHER field on a transaction soft-deletes it and writes a new,
    // `supersededBy`-linked row. A reconcile call racing that edit must land
    // on whichever row is live, never silently no-op on a superseded one.
    const editTransaction = (
      actor: AuthenticatedOnboardedUser,
      opts: { id: string; accountId: string; categoryId: string }
    ) =>
      updateTransactionForFamily({
        data: {
          id: opts.id,
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: opts.accountId,
          amount: 20_000n,
          categoryId: opts.categoryId,
          date: new Date("2026-02-01T00:00:00.000Z"),
          description: "Edited description",
          currency: "IDR",
          isSplit: false,
          status: "CLEARED" as const,
          type: "expense" as const,
        },
        familyId: actor.family.id,
        user: { id: actor.user.id, familyId: actor.family.id },
      }) as Promise<{ id: string }>

    test("reconciling via a since-superseded transactionId resolves onto the current live row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const category = await factories.createCategory({
        familyId: owner.family.id,
        type: "expense",
      })
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      // 1. Edit FIRST — the original id is now soft-deleted/superseded.
      const { id: newTransactionId } = await editTransaction(owner, {
        id: trx.id,
        accountId: trx.accountId,
        categoryId: category.id,
      })

      // 2. Reconcile using the ORIGINAL, now-stale id.
      const result = await reconcile(owner, trx.id, true)

      expect(result.transactionId).toBe(newTransactionId)
      const row = await readTransaction(owner, newTransactionId)
      expect(row.status).toBe("RECONCILED")
    })
  })

  describe("PER-279 — the generic manual form cannot bypass the audit trail", () => {
    test("createTransactionForFamily rejects status: RECONCILED before writing anything", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await factories.createAccount({
        familyId: owner.family.id,
      })

      await expect(
        createTransactionForFamily({
          data: {
            accountId: account.id,
            amount: 10_000n,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Attempted direct reconcile via create",
            idempotencyKey: factories.createIdempotencyKey(),
            isSplit: false,
            status: "RECONCILED",
            type: "expense",
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(ReconciledStatusNotDirectlyEditableError)

      const transactions = await harness.withFamily(owner.family.id, (tx) =>
        tx.transaction.findMany()
      )
      expect(transactions).toHaveLength(0)
    })

    test("updateTransactionForFamily rejects an edit that sets status: RECONCILED", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const category = await factories.createCategory({
        familyId: owner.family.id,
        type: "expense",
      })
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      await expect(
        updateTransactionForFamily({
          data: {
            accountId: trx.accountId,
            amount: 20_000n,
            categoryId: category.id,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Attempted direct reconcile via edit",
            id: trx.id,
            idempotencyKey: factories.createIdempotencyKey(),
            isSplit: false,
            status: "RECONCILED",
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
      ).rejects.toBeInstanceOf(ReconciledStatusNotDirectlyEditableError)

      const row = await readTransaction(owner, trx.id)
      expect(row.status).toBe("CLEARED")
      expect(row.deletedAt).toBeNull()
      expect(row.supersededBy).toBeNull()
    })

    test("updateTransactionForFamily locks any edit of an already-RECONCILED transaction", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const category = await factories.createCategory({
        familyId: owner.family.id,
        type: "expense",
      })
      const { trx } = await seedTransaction(owner, { status: "RECONCILED" })

      // Deliberately sends status: "CLEARED" (never "RECONCILED") — this
      // isolates the OTHER guard: even an edit that never touches status at
      // all must still be blocked because the row it targets is ALREADY
      // reconciled, since reversal-and-replace would silently drop the
      // audit trail on the new row otherwise (see
      // `ReconciledTransactionLockedError`'s doc comment).
      await expect(
        updateTransactionForFamily({
          data: {
            accountId: trx.accountId,
            amount: 12_345n,
            categoryId: category.id,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Only the description changed",
            id: trx.id,
            idempotencyKey: factories.createIdempotencyKey(),
            isSplit: false,
            status: "CLEARED",
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
      ).rejects.toBeInstanceOf(ReconciledTransactionLockedError)

      // Unreplaced: the reconciled row is untouched, not superseded.
      const row = await readTransaction(owner, trx.id)
      expect(row.status).toBe("RECONCILED")
      expect(row.deletedAt).toBeNull()
      expect(row.supersededBy).toBeNull()
    })

    test("deleteTransactionForFamily locks an already-RECONCILED transaction", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "RECONCILED" })

      await expect(
        deleteTransactionForFamily({
          id: trx.id,
          idempotencyKey: factories.createIdempotencyKey(),
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
      ).rejects.toBeInstanceOf(ReconciledTransactionLockedError)

      const row = await readTransaction(owner, trx.id)
      expect(row.deletedAt).toBeNull()
    })

    test("bulkDeleteTransactionsForFamily rolls back the whole batch when one target is RECONCILED", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx: clearedTrx } = await seedTransaction(owner, {
        status: "CLEARED",
      })
      const { trx: reconciledTrx } = await seedTransaction(owner, {
        status: "RECONCILED",
      })

      await expect(
        bulkDeleteTransactionsForFamily({
          ids: [clearedTrx.id, reconciledTrx.id],
          idempotencyKey: factories.createIdempotencyKey(),
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
      ).rejects.toBeInstanceOf(ReconciledTransactionLockedError)

      // Atomic: the CLEARED sibling processed earlier in the loop must not
      // have been deleted either — one bad target fails the whole batch.
      const clearedRow = await readTransaction(owner, clearedTrx.id)
      const reconciledRow = await readTransaction(owner, reconciledTrx.id)
      expect(clearedRow.deletedAt).toBeNull()
      expect(reconciledRow.deletedAt).toBeNull()
    })
  })

  describe("database is the law — CHECK constraint backstop", () => {
    test("a raw write setting reconciledAt without reconciledById is rejected", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Transaction" SET "reconciledAt" = now() WHERE id = $1`,
            trx.id
          )
        )
      ).rejects.toThrow()
    })

    test("a raw write setting reconciledAt on a non-RECONCILED status is rejected", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const { trx } = await seedTransaction(owner, { status: "CLEARED" })

      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Transaction" SET "reconciledAt" = now(), "reconciledById" = $2 WHERE id = $1`,
            trx.id,
            owner.user.id
          )
        )
      ).rejects.toThrow()
    })
  })
})
