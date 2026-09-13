import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createTransactionForFamily } from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-210: a split PARENT keeps its single merchant (merchant = whole receipt);
// only categoryId is nulled on the parent (categories live on the children).
// These tests prove the relaxed split_parent_details_live_on_children CHECK no
// longer rejects a split-with-merchant, that the parent persists the merchant,
// and that the idempotency canonicalization twins stayed symmetric so replay
// still collapses to a single row and a single balance mutation.
describe("PER-210 split parent keeps its merchant", () => {
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

  async function createSplitFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, merchant, categoryOne, categoryTwo] = await Promise.all([
      factories.createAccount({
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-210 account",
      }),
      factories.createMerchant({
        familyId: owner.family.id,
        name: "Indomaret",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-210 groceries",
        type: "expense",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "PER-210 household",
        type: "expense",
      }),
    ])
    return { account, categoryOne, categoryTwo, merchant, owner }
  }

  test("accepts a split expense with a merchant and persists merchant on the parent (category null), with children", async () => {
    const fixture = await createSplitFixture()

    const created = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: fixture.account.id,
        amount: 15_000n,
        currency: "IDR",
        date: new Date("2026-06-01T01:00:00.000Z"),
        description: "Indomaret run",
        isSplit: true,
        merchantId: fixture.merchant.id,
        splitEntries: [
          {
            amount: 7_000n,
            categoryId: fixture.categoryOne.id,
            description: "Groceries line",
          },
          {
            amount: 8_000n,
            categoryId: fixture.categoryTwo.id,
            description: "Household line",
          },
        ],
        status: "CLEARED",
        type: "expense",
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    const parent = await harness.withFamily(fixture.owner.family.id, (tx) =>
      tx.transaction.findUniqueOrThrow({
        select: {
          amount: true,
          categoryId: true,
          isSplit: true,
          merchantId: true,
        },
        where: { id: created.id },
      })
    )
    // Merchant preserved on the parent; category nulled (lives on children).
    expect(parent).toMatchObject({
      amount: -15_000n,
      categoryId: null,
      isSplit: true,
      merchantId: fixture.merchant.id,
    })

    const children = await harness.withFamily(fixture.owner.family.id, (tx) =>
      tx.splitEntry.findMany({
        orderBy: { amount: "asc" },
        select: { amount: true, categoryId: true },
        where: { transactionId: created.id },
      })
    )
    expect(children).toEqual([
      { amount: 7_000n, categoryId: fixture.categoryOne.id },
      { amount: 8_000n, categoryId: fixture.categoryTwo.id },
    ])
  })

  test("replaying the same split-with-merchant idempotency key yields exactly one row and one balance mutation", async () => {
    const fixture = await createSplitFixture()

    const idempotencyKey = factories.createIdempotencyKey()
    const buildPayload = () => ({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey,
        accountId: fixture.account.id,
        amount: 15_000n,
        currency: "IDR",
        date: new Date("2026-06-01T01:00:00.000Z"),
        description: "Indomaret run",
        isSplit: true,
        merchantId: fixture.merchant.id,
        splitEntries: [
          {
            amount: 7_000n,
            categoryId: fixture.categoryOne.id,
            description: "Groceries line",
          },
          {
            amount: 8_000n,
            categoryId: fixture.categoryTwo.id,
            description: "Household line",
          },
        ],
        status: "CLEARED" as const,
        type: "expense" as const,
      },
      familyId: fixture.owner.family.id,
      user: fixture.owner.user,
    })

    const first = await createTransactionForFamily(buildPayload())
    const replay = await createTransactionForFamily(buildPayload())

    // Symmetric canonicalization twins keep replay detection working: same key
    // returns the same id and does not create a second row.
    expect(replay.id).toBe(first.id)

    const rows = await harness.withFamily(fixture.owner.family.id, (tx) =>
      tx.transaction.findMany({
        select: { id: true },
        where: { accountId: fixture.account.id, deletedAt: null },
      })
    )
    expect(rows).toHaveLength(1)

    // Balance mutated exactly once: 100_000 - 15_000 = 85_000.
    const account = await harness.withFamily(fixture.owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({
        select: { balance: true },
        where: { id: fixture.account.id },
      })
    )
    expect(account.balance).toBe(85_000n)
  })
})
