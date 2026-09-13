import { Client as PgClient } from "pg"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  bulkDeleteTransactionsForFamily,
  createTransactionForFamily,
  deleteTransactionForFamily,
  findLedgerTransactionsForFamily,
  updateTransactionForFamily,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

const TEST_DATE = new Date("2026-04-01T00:00:00.000Z")

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("PER-20 — Transfer soft-delete symmetry", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await getHarness().reset()
  })

  afterAll(async () => {
    await harness?.teardown()
  })

  test("Postgres rejects hard DELETE on a Transfer-referenced Transaction with restrict_violation", async () => {
    const fixture = await createTransferFixture()

    await expect(
      withPrivilegedDatabase(getHarness().databaseName, async (client) => {
        await client.query(`DELETE FROM "Transaction" WHERE id = $1`, [
          fixture.outflowTransactionId,
        ])
      })
    ).rejects.toThrow(/violates foreign key|restrict|ON DELETE RESTRICT/i)

    await expect(
      withPrivilegedDatabase(getHarness().databaseName, async (client) => {
        await client.query(`DELETE FROM "Transaction" WHERE id = $1`, [
          fixture.inflowTransactionId,
        ])
      })
    ).rejects.toThrow(/violates foreign key|restrict|ON DELETE RESTRICT/i)
  })

  test("soft-deleting the outflow leg sets Transfer.deletedAt and the opposite leg in the same transaction", async () => {
    const fixture = await createTransferFixture()

    await deleteTransactionForFamily({
      familyId: fixture.owner.family.id,
      id: fixture.outflowTransactionId,
      idempotencyKey: getFactories().createIdempotencyKey(),
      user: fixture.owner.user,
    })

    const after = await readTransferState(fixture)
    expect(after.outflowDeletedAt).not.toBeNull()
    expect(after.inflowDeletedAt).not.toBeNull()
    expect(after.transferDeletedAt).not.toBeNull()

    const auditRows = await getHarness().withFamily(
      fixture.owner.family.id,
      (tx) =>
        tx.auditLog.findMany({
          orderBy: { createdAt: "asc" },
          where: {
            action: "soft_delete",
            entityId: {
              in: [
                fixture.outflowTransactionId,
                fixture.inflowTransactionId,
                fixture.transferId,
              ],
            },
          },
          select: { entityType: true, entityId: true, action: true },
        })
    )

    const auditEntities = auditRows.map((row) => row.entityType).sort()
    expect(auditEntities).toEqual(["Transaction", "Transaction", "Transfer"])
    const transferAudit = auditRows.find((row) => row.entityType === "Transfer")
    expect(transferAudit?.entityId).toBe(fixture.transferId)
  })

  test("soft-deleting the inflow leg also marks the outflow leg and Transfer.deletedAt", async () => {
    const fixture = await createTransferFixture()

    await deleteTransactionForFamily({
      familyId: fixture.owner.family.id,
      id: fixture.inflowTransactionId,
      idempotencyKey: getFactories().createIdempotencyKey(),
      user: fixture.owner.user,
    })

    const after = await readTransferState(fixture)
    expect(after.outflowDeletedAt).not.toBeNull()
    expect(after.inflowDeletedAt).not.toBeNull()
    expect(after.transferDeletedAt).not.toBeNull()
  })

  test("findLedgerTransactionsForFamily excludes a soft-deleted transfer from the user list", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const [sourceA, destA, sourceB, destB] = await Promise.all([
      getFactories().createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "A source",
      }),
      getFactories().createAccount({
        balance: 0n,
        familyId: owner.family.id,
        name: "A destination",
      }),
      getFactories().createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "B source",
      }),
      getFactories().createAccount({
        balance: 0n,
        familyId: owner.family.id,
        name: "B destination",
      }),
    ])

    const transferA = await placeTransfer({
      accountId: sourceA.id,
      amount: 25_000n,
      description: "Transfer A (will be soft-deleted)",
      ownerFamilyId: owner.family.id,
      ownerUser: owner.user,
      toAccountId: destA.id,
    })
    const transferB = await placeTransfer({
      accountId: sourceB.id,
      amount: 30_000n,
      description: "Transfer B (alive)",
      ownerFamilyId: owner.family.id,
      ownerUser: owner.user,
      toAccountId: destB.id,
    })

    await deleteTransactionForFamily({
      familyId: owner.family.id,
      id: transferA.outflowTransactionId,
      idempotencyKey: getFactories().createIdempotencyKey(),
      user: owner.user,
    })

    const list = await getHarness().withFamily(owner.family.id, (tx) =>
      findLedgerTransactionsForFamily(tx, owner.family.id)
    )
    const ids = list.map((row) => row.id)
    expect(ids).not.toContain(transferA.outflowTransactionId)
    expect(ids).not.toContain(transferA.inflowTransactionId)
    expect(ids).toContain(transferB.outflowTransactionId)
    // Inflow leg is excluded by the existing display-dedup filter.
    expect(ids).not.toContain(transferB.inflowTransactionId)
  })

  test("soft-delete is idempotent: replay does not double-reverse balances", async () => {
    const fixture = await createTransferFixture()
    const idempotencyKey = getFactories().createIdempotencyKey()

    await deleteTransactionForFamily({
      familyId: fixture.owner.family.id,
      id: fixture.outflowTransactionId,
      idempotencyKey,
      user: fixture.owner.user,
    })
    const balancesAfterFirstDelete = await readBalances(fixture)

    await expect(
      deleteTransactionForFamily({
        familyId: fixture.owner.family.id,
        id: fixture.outflowTransactionId,
        idempotencyKey,
        user: fixture.owner.user,
      })
    ).resolves.toBeDefined()

    const balancesAfterReplay = await readBalances(fixture)
    expect(balancesAfterReplay.source).toBe(balancesAfterFirstDelete.source)
    expect(balancesAfterReplay.destination).toBe(
      balancesAfterFirstDelete.destination
    )
  })

  test("bulk delete soft-deletes both legs and the Transfer row for every selected transfer", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const transfers = await Promise.all([
      placeTransfer({
        accountId: (
          await getFactories().createAccount({
            balance: 100_000n,
            familyId: owner.family.id,
            name: "Bulk A source",
          })
        ).id,
        amount: 10_000n,
        description: "Bulk A",
        ownerFamilyId: owner.family.id,
        ownerUser: owner.user,
        toAccountId: (
          await getFactories().createAccount({
            balance: 0n,
            familyId: owner.family.id,
            name: "Bulk A dest",
          })
        ).id,
      }),
      placeTransfer({
        accountId: (
          await getFactories().createAccount({
            balance: 100_000n,
            familyId: owner.family.id,
            name: "Bulk B source",
          })
        ).id,
        amount: 12_000n,
        description: "Bulk B",
        ownerFamilyId: owner.family.id,
        ownerUser: owner.user,
        toAccountId: (
          await getFactories().createAccount({
            balance: 0n,
            familyId: owner.family.id,
            name: "Bulk B dest",
          })
        ).id,
      }),
    ])

    await bulkDeleteTransactionsForFamily({
      familyId: owner.family.id,
      idempotencyKey: getFactories().createIdempotencyKey(),
      ids: transfers.map((tr) => tr.outflowTransactionId),
      user: owner.user,
    })

    for (const transfer of transfers) {
      const state = await readTransferState({
        owner: { family: owner.family, user: owner.user },
        outflowTransactionId: transfer.outflowTransactionId,
        inflowTransactionId: transfer.inflowTransactionId,
        transferId: transfer.transferId,
      })
      expect(state.outflowDeletedAt).not.toBeNull()
      expect(state.inflowDeletedAt).not.toBeNull()
      expect(state.transferDeletedAt).not.toBeNull()
    }
  })

  test("updateTransactionForFamily transfer reversal-and-replace still works after Cascade→Restrict switch", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const sourceAccount = await getFactories().createAccount({
      balance: 200_000n,
      familyId: owner.family.id,
      name: "Reversal source",
    })
    const originalDest = await getFactories().createAccount({
      balance: 0n,
      familyId: owner.family.id,
      name: "Reversal dest A",
    })
    const replacementDest = await getFactories().createAccount({
      balance: 0n,
      familyId: owner.family.id,
      name: "Reversal dest B",
    })
    const fixture = await placeTransfer({
      accountId: sourceAccount.id,
      amount: 50_000n,
      description: "Pre-update transfer",
      ownerFamilyId: owner.family.id,
      ownerUser: owner.user,
      toAccountId: originalDest.id,
    })

    const updated = await updateTransactionForFamily({
      data: {
        accountId: sourceAccount.id,
        amount: 75_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Updated transfer",
        id: fixture.outflowTransactionId,
        idempotencyKey: getFactories().createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: replacementDest.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // PER-93 keeps the old Transfer as soft-deleted history and creates a new
    // Transfer row for the replacement legs.
    const transfersAfter = await getHarness().withFamily(
      owner.family.id,
      (tx) => tx.transfer.findMany({})
    )
    expect(transfersAfter).toHaveLength(2)
    const oldTransfer = transfersAfter.find(
      (row) => row.id === fixture.transferId
    )
    const newTransfer = transfersAfter.find(
      (row) => row.id !== fixture.transferId
    )
    expect(oldTransfer?.deletedAt).not.toBeNull()
    expect(newTransfer?.outflowTransactionId).toBe(updated.id)
    expect(newTransfer?.inflowTransactionId).not.toBe(
      fixture.inflowTransactionId
    )

    // Balances reflect the updated transfer (200k - 75k = 125k on source).
    const sourceAfter = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({
        where: { id: sourceAccount.id },
        select: { balance: true },
      })
    )
    const replacementAfter = await getHarness().withFamily(
      owner.family.id,
      (tx) =>
        tx.account.findUniqueOrThrow({
          where: { id: replacementDest.id },
          select: { balance: true },
        })
    )
    expect(sourceAfter.balance).toBe(125_000n)
    expect(replacementAfter.balance).toBe(75_000n)
  })
})

interface TransferFixture {
  owner: Awaited<ReturnType<TestFactories["createAuthenticatedOnboardedUser"]>>
  outflowTransactionId: string
  inflowTransactionId: string
  transferId: string
  sourceAccountId: string
  destinationAccountId: string
}

async function createTransferFixture(): Promise<TransferFixture> {
  const owner = await getFactories().createAuthenticatedOnboardedUser()
  const sourceAccount = await getFactories().createAccount({
    balance: 100_000n,
    familyId: owner.family.id,
    name: "Source",
  })
  const destinationAccount = await getFactories().createAccount({
    balance: 0n,
    familyId: owner.family.id,
    name: "Destination",
  })
  const placed = await placeTransfer({
    accountId: sourceAccount.id,
    amount: 25_000n,
    description: "Standalone transfer fixture",
    ownerFamilyId: owner.family.id,
    ownerUser: owner.user,
    toAccountId: destinationAccount.id,
  })
  return {
    destinationAccountId: destinationAccount.id,
    inflowTransactionId: placed.inflowTransactionId,
    outflowTransactionId: placed.outflowTransactionId,
    owner,
    sourceAccountId: sourceAccount.id,
    transferId: placed.transferId,
  }
}

interface PlaceTransferInput {
  accountId: string
  amount: bigint
  description: string
  ownerFamilyId: string
  ownerUser: { id: string; familyId?: string | null }
  toAccountId: string
}

interface PlacedTransfer {
  outflowTransactionId: string
  inflowTransactionId: string
  transferId: string
}

async function placeTransfer(
  input: PlaceTransferInput
): Promise<PlacedTransfer> {
  const outflowTransactionId = getFactories().createIdempotencyKey()
  const idempotencyKey = getFactories().createIdempotencyKey()

  await createTransactionForFamily({
    data: {
      accountId: input.accountId,
      amount: input.amount,
      currency: "IDR",
      date: TEST_DATE,
      description: input.description,
      id: outflowTransactionId,
      idempotencyKey,
      isSplit: false,
      status: "CLEARED",
      toAccountId: input.toAccountId,
      type: "transfer",
    },
    familyId: input.ownerFamilyId,
    user: input.ownerUser,
  })

  const transfer = await getHarness().withFamily(input.ownerFamilyId, (tx) =>
    tx.transfer.findFirstOrThrow({
      where: { outflowTransactionId },
    })
  )
  if (!transfer.inflowTransactionId) {
    throw new Error("Expected a classic dual-leg transfer fixture")
  }

  return {
    inflowTransactionId: transfer.inflowTransactionId,
    outflowTransactionId,
    transferId: transfer.id,
  }
}

interface TransferStateRefs {
  owner: { family: { id: string }; user: { id: string } }
  outflowTransactionId: string
  inflowTransactionId: string
  transferId: string
}

async function readTransferState(refs: TransferStateRefs) {
  return await getHarness().withFamily(refs.owner.family.id, async (tx) => {
    const [outflow, inflow, transfer] = await Promise.all([
      tx.transaction.findUniqueOrThrow({
        where: { id: refs.outflowTransactionId },
        select: { deletedAt: true },
      }),
      tx.transaction.findUniqueOrThrow({
        where: { id: refs.inflowTransactionId },
        select: { deletedAt: true },
      }),
      tx.transfer.findUniqueOrThrow({
        where: { id: refs.transferId },
        select: { deletedAt: true },
      }),
    ])
    return {
      outflowDeletedAt: outflow.deletedAt,
      inflowDeletedAt: inflow.deletedAt,
      transferDeletedAt: transfer.deletedAt,
    }
  })
}

async function readBalances(fixture: TransferFixture) {
  return await getHarness().withFamily(fixture.owner.family.id, async (tx) => {
    const [source, destination] = await Promise.all([
      tx.account.findUniqueOrThrow({
        select: { balance: true },
        where: { id: fixture.sourceAccountId },
      }),
      tx.account.findUniqueOrThrow({
        select: { balance: true },
        where: { id: fixture.destinationAccountId },
      }),
    ])
    return { source: source.balance, destination: destination.balance }
  })
}

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getFactories(): TestFactories {
  if (!factories) throw new Error("Integration factories are not initialized")
  return factories
}

async function withPrivilegedDatabase<T>(
  databaseName: string,
  callback: (client: PgClient) => Promise<T>
): Promise<T> {
  const client = new PgClient({
    connectionString: privilegedDatabaseUrl(databaseName),
  })
  await client.connect()
  try {
    return await callback(client)
  } finally {
    await client.end()
  }
}

function privilegedDatabaseUrl(databaseName: string): string {
  const rawAdminDatabaseUrl =
    process.env.PERMONEY_TEST_ADMIN_DATABASE_URL ??
    "postgres://permoney@localhost:5433/postgres"
  const parsedUrl = new URL(rawAdminDatabaseUrl)
  const password = process.env.PERMONEY_TEST_ADMIN_PASSWORD
  if (password) parsedUrl.password = password
  parsedUrl.pathname = `/${databaseName}`
  return parsedUrl.toString()
}
