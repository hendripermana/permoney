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
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

const TENANT_FK_REJECTION =
  /violates foreign key|cross-tenant|integrity constraint|P2003|P2004|tenant|policy|family/i

interface SeedSystemCategoryInput {
  id: string
  name: string
}

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("Tenant composite FK invariants (PER-104)", () => {
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

  test("rejects Transaction.accountId pointing to a different family's Account", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const intruderAccount = await getFactories().createAccount({
      familyId: intruder.family.id,
      name: "Intruder Cash",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: intruderAccount.id,
            amount: -10_000n,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Cross-tenant accountId",
            familyId: owner.family.id,
            status: "CLEARED",
            type: "expense",
            userId: owner.user.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects Transaction.toAccountId pointing to a different family's Account", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Cash",
    })
    const intruderAccount = await getFactories().createAccount({
      familyId: intruder.family.id,
      name: "Intruder Savings",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: ownerAccount.id,
            amount: -25_000n,
            currency: "IDR",
            date: new Date("2026-02-02T00:00:00.000Z"),
            description: "Cross-tenant transfer destination",
            familyId: owner.family.id,
            status: "CLEARED",
            toAccountId: intruderAccount.id,
            type: "transfer",
            userId: owner.user.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects Transaction.merchantId pointing to a different family's Merchant", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Wallet",
    })
    const intruderMerchant = await getFactories().createMerchant({
      familyId: intruder.family.id,
      name: "Intruder Coffee",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: ownerAccount.id,
            amount: -3_500n,
            currency: "IDR",
            date: new Date("2026-02-03T00:00:00.000Z"),
            description: "Cross-tenant merchantId",
            familyId: owner.family.id,
            merchantId: intruderMerchant.id,
            status: "CLEARED",
            type: "expense",
            userId: owner.user.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects Transaction.categoryId pointing to a different family's tenant Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Wallet",
    })
    const intruderCategory = await getFactories().createCategory({
      familyId: intruder.family.id,
      name: "Intruder Tenant Category",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: ownerAccount.id,
            amount: -7_500n,
            categoryId: intruderCategory.id,
            currency: "IDR",
            date: new Date("2026-02-04T00:00:00.000Z"),
            description: "Cross-tenant categoryId",
            familyId: owner.family.id,
            status: "CLEARED",
            type: "expense",
            userId: owner.user.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("allows Transaction.categoryId pointing to a global system Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Daily",
    })
    const systemCategoryId = await seedSystemCategory({
      id: "per-104-system-allowed",
      name: "PER-104 Global System",
    })

    const created = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.transaction.create({
        data: {
          accountId: ownerAccount.id,
          amount: -1_000n,
          categoryId: systemCategoryId,
          currency: "IDR",
          date: new Date("2026-02-05T00:00:00.000Z"),
          description: "System category permitted",
          familyId: owner.family.id,
          status: "CLEARED",
          type: "expense",
          userId: owner.user.id,
        },
      })
    )

    expect(created.categoryId).toBe(systemCategoryId)
  })

  test("rejects Transaction.userId pointing to a User from a different family", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Daily",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: ownerAccount.id,
            amount: -2_000n,
            currency: "IDR",
            date: new Date("2026-02-06T00:00:00.000Z"),
            description: "Cross-tenant actor",
            familyId: owner.family.id,
            status: "CLEARED",
            type: "expense",
            userId: intruder.user.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects Transaction.userId pointing to an unonboarded User", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Daily",
    })
    const orphan = await getFactories().createAuthenticatedUserWithoutFamily()

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: ownerAccount.id,
            amount: -1_500n,
            currency: "IDR",
            date: new Date("2026-02-07T00:00:00.000Z"),
            description: "Unonboarded actor",
            familyId: owner.family.id,
            status: "CLEARED",
            type: "expense",
            userId: orphan.user.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects SplitEntry.categoryId pointing to a different family's tenant Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Daily",
    })
    const ownerTransaction = await getFactories().createTransaction({
      accountId: ownerAccount.id,
      amount: -50_000n,
      familyId: owner.family.id,
      type: "expense",
      userId: owner.user.id,
    })
    const intruderCategory = await getFactories().createCategory({
      familyId: intruder.family.id,
      name: "Intruder Tenant Category",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.splitEntry.create({
          data: {
            amount: 25_000n,
            categoryId: intruderCategory.id,
            description: "Cross-tenant split category",
            transactionId: ownerTransaction.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects SplitEntry.merchantId pointing to a different family's Merchant", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Daily",
    })
    const ownerTransaction = await getFactories().createTransaction({
      accountId: ownerAccount.id,
      amount: -50_000n,
      familyId: owner.family.id,
      type: "expense",
      userId: owner.user.id,
    })
    const intruderMerchant = await getFactories().createMerchant({
      familyId: intruder.family.id,
      name: "Intruder Coffee",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.splitEntry.create({
          data: {
            amount: 25_000n,
            description: "Cross-tenant split merchant",
            merchantId: intruderMerchant.id,
            transactionId: ownerTransaction.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects SmartRule.merchantId pointing to a different family's Merchant", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const intruderMerchant = await getFactories().createMerchant({
      familyId: intruder.family.id,
      name: "Intruder Coffee",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.smartRule.create({
          data: {
            familyId: owner.family.id,
            keyword: "coffee, fore",
            merchantId: intruderMerchant.id,
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects SmartRule.categoryId pointing to a different family's tenant Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const intruderCategory = await getFactories().createCategory({
      familyId: intruder.family.id,
      name: "Intruder Tenant Category",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.smartRule.create({
          data: {
            categoryId: intruderCategory.id,
            familyId: owner.family.id,
            keyword: "subscription",
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("allows SmartRule.categoryId pointing to a global system Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const systemCategoryId = await seedSystemCategory({
      id: "per-104-system-rule-allowed",
      name: "PER-104 Rule System Cat",
    })

    const created = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.smartRule.create({
        data: {
          categoryId: systemCategoryId,
          familyId: owner.family.id,
          keyword: "salary",
        },
      })
    )

    expect(created.categoryId).toBe(systemCategoryId)
  })

  test("rejects Transfer whose two legs belong to different families", async () => {
    const familyA = await getFactories().createAuthenticatedOnboardedUser()
    const familyB = await getFactories().createAuthenticatedOnboardedUser()
    const accountA = await getFactories().createAccount({
      familyId: familyA.family.id,
      name: "A Cash",
    })
    const accountB = await getFactories().createAccount({
      familyId: familyB.family.id,
      name: "B Cash",
    })

    const outflowTransaction = await getFactories().createTransaction({
      accountId: accountA.id,
      amount: -10_000n,
      familyId: familyA.family.id,
      type: "transfer",
      userId: familyA.user.id,
    })
    const inflowTransaction = await getFactories().createTransaction({
      accountId: accountB.id,
      amount: 10_000n,
      familyId: familyB.family.id,
      type: "transfer",
      userId: familyB.user.id,
    })

    await expect(
      withPrivilegedDatabase(getHarness().databaseName, async (client) => {
        await client.query(
          `INSERT INTO "Transfer" (id, "outflowTransactionId", "inflowTransactionId")
           VALUES ($1, $2, $3)`,
          [
            "per-104-cross-family-transfer",
            outflowTransaction.id,
            inflowTransaction.id,
          ]
        )
      })
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("rejects Category.parentId pointing to a different family's tenant Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const intruder = await getFactories().createAuthenticatedOnboardedUser()
    const intruderCategory = await getFactories().createCategory({
      familyId: intruder.family.id,
      name: "Intruder Parent",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.category.create({
          data: {
            color: "#0ea5e9",
            familyId: owner.family.id,
            icon: "shapes",
            name: "Owner Child Category",
            parentId: intruderCategory.id,
            type: "expense",
          },
        })
      )
    ).rejects.toThrow(TENANT_FK_REJECTION)
  })

  test("allows Category.parentId pointing to a global system Category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const systemParentId = await seedSystemCategory({
      id: "per-104-system-parent",
      name: "System Parent Allowed",
    })

    const child = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.category.create({
        data: {
          color: "#0ea5e9",
          familyId: owner.family.id,
          icon: "shapes",
          name: "Tenant Child Of System",
          parentId: systemParentId,
          type: "expense",
        },
      })
    )

    expect(child.parentId).toBe(systemParentId)
  })

  test("happy path: same-family Transaction with tenant references and same-family SplitEntry succeeds", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const ownerAccount = await getFactories().createAccount({
      familyId: owner.family.id,
      name: "Owner Wallet",
    })
    const ownerMerchant = await getFactories().createMerchant({
      familyId: owner.family.id,
      name: "Owner Coffee",
    })
    const ownerCategory = await getFactories().createCategory({
      familyId: owner.family.id,
      name: "Owner Food",
    })

    const created = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.transaction.create({
        data: {
          accountId: ownerAccount.id,
          amount: -42_000n,
          categoryId: ownerCategory.id,
          currency: "IDR",
          date: new Date("2026-02-08T00:00:00.000Z"),
          description: "Same-family happy path",
          familyId: owner.family.id,
          merchantId: ownerMerchant.id,
          status: "CLEARED",
          type: "expense",
          userId: owner.user.id,
        },
      })
    )
    const split = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.splitEntry.create({
        data: {
          amount: 21_000n,
          categoryId: ownerCategory.id,
          description: "Same-family split",
          merchantId: ownerMerchant.id,
          transactionId: created.id,
        },
      })
    )

    expect(created.familyId).toBe(owner.family.id)
    expect(split.transactionId).toBe(created.id)
  })
})

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getFactories(): TestFactories {
  if (!factories) throw new Error("Integration factories are not initialized")
  return factories
}

async function seedSystemCategory(
  input: SeedSystemCategoryInput
): Promise<string> {
  await withPrivilegedDatabase(getHarness().databaseName, async (client) => {
    await client.query(
      `INSERT INTO "Category"
       (id, name, type, color, icon, "isSystem", "familyId", "parentId")
       VALUES ($1, $2, 'expense', '#6172F3', 'shapes', true, NULL, NULL)`,
      [input.id, input.name]
    )
  })
  return input.id
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
