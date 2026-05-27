import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { Client as PgClient } from "pg"
import {
  bulkCreateTransactionsForFamily,
  bulkUpdateTransactionsForFamily,
  createTransactionForFamily,
  updateTransactionForFamily,
} from "@/server/transactions"
import { createSmartRuleForFamily } from "@/server/smart-rules"
import { TenantReferenceError } from "@/server/validation/tenant-references"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

interface SeedSystemCategoryInput {
  id: string
  name: string
}

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("App-level tenant reference validation (PER-94)", () => {
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

  describe("createTransactionForFamily", () => {
    test("rejects accountId that belongs to a different family with TenantReferenceError", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const intruderAccount = await getFactories().createAccount({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createTransactionForFamily({
          data: {
            idempotencyKey: getFactories().createIdempotencyKey(),
            accountId: intruderAccount.id,
            amount: 12_000n,
            currency: "IDR",
            date: new Date("2026-03-01T00:00:00.000Z"),
            description: "Cross-tenant accountId via app",
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      const err = captured as TenantReferenceError
      expect(err.field).toBe("accountId")
      expect(err.referenceId).toBe(intruderAccount.id)
      expect(err.familyId).toBe(owner.family.id)

      // No mutation must have occurred
      const txCount = await getHarness().prisma.transaction.count({
        where: { familyId: owner.family.id },
      })
      expect(txCount).toBe(0)
    })

    test("rejects toAccountId that belongs to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 100_000n,
      })
      const intruderAccount = await getFactories().createAccount({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createTransactionForFamily({
          data: {
            idempotencyKey: getFactories().createIdempotencyKey(),
            accountId: ownerAccount.id,
            amount: 50_000n,
            currency: "IDR",
            date: new Date("2026-03-02T00:00:00.000Z"),
            description: "Cross-tenant transfer destination via app",
            toAccountId: intruderAccount.id,
            type: "transfer",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("toAccountId")

      const ownerAccountAfter = await getHarness().withFamily(
        owner.family.id,
        (tx) =>
          tx.account.findUnique({
            where: { id: ownerAccount.id },
            select: { balance: true },
          })
      )
      expect(ownerAccountAfter?.balance).toBe(100_000n)
    })

    test("rejects merchantId that belongs to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 50_000n,
      })
      const intruderMerchant = await getFactories().createMerchant({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createTransactionForFamily({
          data: {
            idempotencyKey: getFactories().createIdempotencyKey(),
            accountId: ownerAccount.id,
            amount: 5_000n,
            currency: "IDR",
            date: new Date("2026-03-03T00:00:00.000Z"),
            description: "Cross-tenant merchantId via app",
            merchantId: intruderMerchant.id,
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("merchantId")

      const ownerAccountAfter = await getHarness().withFamily(
        owner.family.id,
        (tx) =>
          tx.account.findUnique({
            where: { id: ownerAccount.id },
            select: { balance: true },
          })
      )
      expect(ownerAccountAfter?.balance).toBe(50_000n)
    })

    test("rejects categoryId that belongs to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 50_000n,
      })
      const intruderCategory = await getFactories().createCategory({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createTransactionForFamily({
          data: {
            idempotencyKey: getFactories().createIdempotencyKey(),
            accountId: ownerAccount.id,
            amount: 7_000n,
            categoryId: intruderCategory.id,
            currency: "IDR",
            date: new Date("2026-03-04T00:00:00.000Z"),
            description: "Cross-tenant categoryId via app",
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("categoryId")
    })

    test("allows categoryId that points to a global system Category", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 25_000n,
      })
      const systemCategoryId = await seedSystemCategory({
        id: "per-94-system-category-allowed",
        name: "PER-94 System OK",
      })

      const result = await createTransactionForFamily({
        data: {
          idempotencyKey: getFactories().createIdempotencyKey(),
          accountId: ownerAccount.id,
          amount: 1_000n,
          categoryId: systemCategoryId,
          currency: "IDR",
          date: new Date("2026-03-05T00:00:00.000Z"),
          description: "System category via app",
          type: "expense",
        },
        familyId: owner.family.id,
        user: { id: owner.user.id },
      })

      expect(result.categoryId).toBe(systemCategoryId)
    })

    test("rejects splitEntries[i].categoryId pointing to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 100_000n,
      })
      const ownerCategory = await getFactories().createCategory({
        familyId: owner.family.id,
      })
      const intruderCategory = await getFactories().createCategory({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createTransactionForFamily({
          data: {
            idempotencyKey: getFactories().createIdempotencyKey(),
            accountId: ownerAccount.id,
            amount: 30_000n,
            currency: "IDR",
            date: new Date("2026-03-06T00:00:00.000Z"),
            description: "Cross-tenant split categoryId",
            isSplit: true,
            splitEntries: [
              {
                amount: 10_000n,
                categoryId: ownerCategory.id,
                description: "leg one",
              },
              {
                amount: 20_000n,
                categoryId: intruderCategory.id,
                description: "leg two",
              },
            ],
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe(
        "splitEntries[1].categoryId"
      )
      expect((captured as TenantReferenceError).referenceId).toBe(
        intruderCategory.id
      )
    })
  })

  describe("updateTransactionForFamily", () => {
    test("rejects updating a transaction with another family's accountId", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 50_000n,
      })
      const intruderAccount = await getFactories().createAccount({
        familyId: intruder.family.id,
      })
      const original = await getFactories().createTransaction({
        accountId: ownerAccount.id,
        amount: -10_000n,
        familyId: owner.family.id,
        userId: owner.user.id,
      })

      let captured: unknown
      try {
        await updateTransactionForFamily({
          data: {
            id: original.id,
            accountId: intruderAccount.id,
            amount: 10_000n,
            currency: "IDR",
            date: new Date("2026-03-07T00:00:00.000Z"),
            description: "Cross-tenant accountId on update",
            isSplit: false,
            status: "CLEARED",
            type: "expense",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("accountId")
    })
  })

  describe("bulkCreateTransactionsForFamily", () => {
    test("rejects entire batch when any row carries a cross-tenant reference", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 200_000n,
      })
      const intruderMerchant = await getFactories().createMerchant({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await bulkCreateTransactionsForFamily({
          data: {
            transactions: [
              {
                accountId: ownerAccount.id,
                amount: 5_000n,
                date: new Date("2026-03-08T00:00:00.000Z"),
                description: "Legitimate row",
                id: "per-94-bulk-ok",
                status: "CLEARED",
                type: "expense",
              },
              {
                accountId: ownerAccount.id,
                amount: 7_000n,
                date: new Date("2026-03-08T00:00:00.000Z"),
                description: "Cross-tenant merchant row",
                id: "per-94-bulk-bad",
                merchantId: intruderMerchant.id,
                status: "CLEARED",
                type: "expense",
              },
            ],
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toContain("merchantId")
      expect((captured as TenantReferenceError).referenceId).toBe(
        intruderMerchant.id
      )

      const txCount = await getHarness().prisma.transaction.count({
        where: { familyId: owner.family.id },
      })
      expect(txCount).toBe(0)
    })
  })

  describe("bulkUpdateTransactionsForFamily", () => {
    test("rejects bulk patch that re-points categoryId to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 100_000n,
      })
      const intruderCategory = await getFactories().createCategory({
        familyId: intruder.family.id,
      })
      const targetTx = await getFactories().createTransaction({
        accountId: ownerAccount.id,
        amount: -5_000n,
        familyId: owner.family.id,
        userId: owner.user.id,
      })

      let captured: unknown
      try {
        await bulkUpdateTransactionsForFamily({
          data: {
            ids: [targetTx.id],
            categoryId: intruderCategory.id,
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("categoryId")
    })
  })

  describe("createSmartRuleForFamily", () => {
    test("rejects categoryId that belongs to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const intruderCategory = await getFactories().createCategory({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createSmartRuleForFamily({
          data: {
            categoryId: intruderCategory.id,
            keyword: "starbucks",
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("categoryId")
    })

    test("rejects merchantId that belongs to a different family", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const intruder = await getFactories().createAuthenticatedOnboardedUser()
      const intruderMerchant = await getFactories().createMerchant({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createSmartRuleForFamily({
          data: {
            keyword: "fore",
            merchantId: intruderMerchant.id,
          },
          familyId: owner.family.id,
          user: { id: owner.user.id, familyId: owner.family.id },
        })
        expect.fail("Expected TenantReferenceError")
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TenantReferenceError)
      expect((captured as TenantReferenceError).field).toBe("merchantId")
    })

    test("allows categoryId pointing to a global system Category", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const systemCategoryId = await seedSystemCategory({
        id: "per-94-rule-system-allowed",
        name: "PER-94 Rule System Cat",
      })

      const created = await createSmartRuleForFamily({
        data: {
          categoryId: systemCategoryId,
          keyword: "salary",
        },
        familyId: owner.family.id,
        user: { id: owner.user.id, familyId: owner.family.id },
      })

      expect(created.categoryId).toBe(systemCategoryId)
    })
  })

  describe("happy path: same-family references succeed via app validator", () => {
    test("createTransactionForFamily with all same-family references", async () => {
      const owner = await getFactories().createAuthenticatedOnboardedUser()
      const ownerAccount = await getFactories().createAccount({
        familyId: owner.family.id,
        balance: 1_000_000n,
      })
      const ownerMerchant = await getFactories().createMerchant({
        familyId: owner.family.id,
      })
      const ownerCategory = await getFactories().createCategory({
        familyId: owner.family.id,
      })

      const created = await createTransactionForFamily({
        data: {
          idempotencyKey: getFactories().createIdempotencyKey(),
          accountId: ownerAccount.id,
          amount: 9_000n,
          categoryId: ownerCategory.id,
          currency: "IDR",
          date: new Date("2026-03-09T00:00:00.000Z"),
          description: "Same-family happy path",
          merchantId: ownerMerchant.id,
          type: "expense",
        },
        familyId: owner.family.id,
        user: { id: owner.user.id },
      })

      expect(created.familyId).toBe(owner.family.id)
      expect(created.accountId).toBe(ownerAccount.id)
      expect(created.categoryId).toBe(ownerCategory.id)
      expect(created.merchantId).toBe(ownerMerchant.id)
    })
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
