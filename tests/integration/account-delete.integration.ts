import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  createAccountForFamily,
  deleteAccountForFamily,
  getAccountDeletionImpactForFamily,
  getAccountsForFamily,
} from "@/server/accounts"
import { createTransactionForFamily } from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-183 — account deletion must be canonical, tenant-scoped, idempotent,
// balance-correct, and audited, mirroring the same invariants the ledger
// mutation contract already enforces for transactions. Two branches:
//   - a never-transacted account (and its opening Valuation) is hard-deleted
//   - an account with transaction history — including a transfer leg that
//     touches a SECOND account — is cascade soft-deleted, reusing the
//     canonical, transfer-symmetric per-transaction soft delete.
describe("deleteAccountForFamily (PER-183)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories
  const TEST_DATE = new Date("2026-07-18T00:00:00.000Z")

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

  test("hard-deletes a never-transacted account and its opening valuation", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    const created = await createAccountForFamily({
      data: {
        name: "Never Used Wallet",
        accountType: "E_WALLET",
        openingBalance: "50000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const impactBefore = await getAccountDeletionImpactForFamily({
      data: { id: created.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(impactBefore.isEmpty).toBe(true)
    expect(impactBefore.valuationCount).toBe(1)

    const result = await deleteAccountForFamily({
      data: {
        id: created.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result).toEqual({
      accountId: created.id,
      deleted: true,
      hardDeleted: true,
    })

    const [accountRow, valuationRows, auditRows] = await harness.withFamily(
      owner.family.id,
      async (tx) => {
        return await Promise.all([
          tx.account.findFirst({ where: { id: created.id } }),
          tx.valuation.findMany({ where: { accountId: created.id } }),
          tx.auditLog.findMany({
            where: {
              entityType: { in: ["Account", "Valuation"] },
              action: "delete",
            },
            orderBy: { entityType: "asc" },
          }),
        ])
      }
    )

    expect(accountRow).toBeNull()
    expect(valuationRows).toHaveLength(0)
    expect(
      auditRows.map((row) => ({
        action: row.action,
        entityType: row.entityType,
      }))
    ).toEqual([
      { action: "delete", entityType: "Account" },
      { action: "delete", entityType: "Valuation" },
    ])

    const remaining = await getAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(
      remaining.find((account) => account.id === created.id)
    ).toBeUndefined()
  })

  test("replays the same idempotency key without a second delete, and a fresh key against an already-gone account is a quiet success", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const created = await createAccountForFamily({
      data: {
        name: "Replay Wallet",
        accountType: "E_WALLET",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const key = factories.createIdempotencyKey()

    const first = await deleteAccountForFamily({
      data: { id: created.id, idempotencyKey: key },
      familyId: owner.family.id,
      user: owner.user,
    })
    const replay = await deleteAccountForFamily({
      data: { id: created.id, idempotencyKey: key },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(replay).toEqual(first)

    // A different key against the now-gone account is idempotent toward the
    // END STATE — a quiet success, not AccountNotFoundError.
    const secondAttempt = await deleteAccountForFamily({
      data: {
        id: created.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(secondAttempt).toEqual({
      accountId: created.id,
      deleted: true,
      hardDeleted: true,
    })
  })

  test("cascade soft-deletes an account with a standard transaction, reversing its balance", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Has History",
    })
    const category = await factories.createCategory({
      familyId: owner.family.id,
    })

    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: account.id,
        amount: 20_000n,
        categoryId: category.id,
        date: TEST_DATE,
        description: "Coffee",
        type: "expense" as const,
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withMember,
      user: owner.user,
    })

    const impact = await getAccountDeletionImpactForFamily({
      data: { id: account.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(impact.isEmpty).toBe(false)
    expect(impact.transactionCount).toBe(1)
    expect(impact.transferCount).toBe(0)

    const result = await deleteAccountForFamily({
      data: {
        id: account.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result).toEqual({
      accountId: account.id,
      deleted: true,
      hardDeleted: false,
    })

    const [accountRow, transactions] = await harness.withFamily(
      owner.family.id,
      async (tx) => {
        return await Promise.all([
          tx.account.findFirstOrThrow({ where: { id: account.id } }),
          tx.transaction.findMany({ where: { accountId: account.id } }),
        ])
      }
    )

    // Row still physically exists (Restrict FK from the transaction row) —
    // never hard-deleted once it had real history.
    expect(accountRow.deletedAt).not.toBeNull()
    expect(accountRow.status).toBe("closed")
    expect(transactions).toHaveLength(1)
    expect(transactions[0]?.deletedAt).not.toBeNull()
    // The expense was reversed back onto the account before it closed.
    expect(accountRow.balance).toBe(100_000n)

    const remaining = await getAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(remaining.find((row) => row.id === account.id)).toBeUndefined()
  })

  test("cascade delete on a transfer's source account reverses the OTHER account's balance too", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [sourceAccount, destinationAccount] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "Transfer Source",
      }),
      factories.createAccount({
        balance: 50_000n,
        familyId: owner.family.id,
        name: "Transfer Destination",
      }),
    ])

    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: sourceAccount.id,
        amount: 30_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Move to savings",
        isSplit: false,
        status: "CLEARED" as const,
        toAccountId: destinationAccount.id,
        type: "transfer" as const,
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withMember,
      user: owner.user,
    })

    const impact = await getAccountDeletionImpactForFamily({
      data: { id: sourceAccount.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(impact.transferCount).toBe(1)
    expect(impact.otherAccountNames).toEqual(["Transfer Destination"])

    await deleteAccountForFamily({
      data: {
        id: sourceAccount.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const [sourceRow, destinationRow, transfer] = await harness.withFamily(
      owner.family.id,
      async (tx) => {
        return await Promise.all([
          tx.account.findFirstOrThrow({ where: { id: sourceAccount.id } }),
          tx.account.findFirstOrThrow({ where: { id: destinationAccount.id } }),
          tx.transfer.findFirstOrThrow({
            where: { outflowTransaction: { accountId: sourceAccount.id } },
          }),
        ])
      }
    )

    expect(sourceRow.deletedAt).not.toBeNull()
    expect(sourceRow.balance).toBe(100_000n)
    // The destination account is untouched by the delete itself, but its
    // balance is reversed because the transfer that funded it is gone.
    expect(destinationRow.deletedAt).toBeNull()
    expect(destinationRow.balance).toBe(50_000n)
    expect(transfer.deletedAt).not.toBeNull()
  })
})
