import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  assertTestDatabaseUrl,
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("M2 integration harness", () => {
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

  test("rejects non-test database URLs", () => {
    expect(() =>
      assertTestDatabaseUrl("postgres://permoney@localhost:5433/permoney")
    ).toThrow(/refusing to run integration tests/i)
  })

  test("rejects an ambient non-test DATABASE_URL", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = "postgres://permoney@localhost:5433/permoney"

    try {
      await expect(createIntegrationHarness()).rejects.toThrow(
        /non-test database_url/i
      )
    } finally {
      if (originalDatabaseUrl) {
        process.env.DATABASE_URL = originalDatabaseUrl
      } else {
        delete process.env.DATABASE_URL
      }
    }
  })

  test("creates authenticated users with and without family onboarding", async () => {
    const [onboarded, unonboarded] = await Promise.all([
      factories.createAuthenticatedOnboardedUser(),
      factories.createAuthenticatedUserWithoutFamily(),
    ])

    expect(onboarded.user.familyId).toBe(onboarded.family.id)
    expect(onboarded.serverContext.familyId).toBe(onboarded.family.id)
    expect(onboarded.request.headers.get("cookie")).toContain(
      "permoney.session_token="
    )

    expect(unonboarded.user.familyId).toBeNull()
    expect(unonboarded.serverContext.user.familyId).toBeNull()
    expect(unonboarded.request.headers.get("cookie")).toContain(
      "permoney.session_token="
    )
  })

  test("uses real Postgres RLS with deterministic tenant isolation", async () => {
    const [firstFixture, secondFixture] = await Promise.all([
      createAccountFixture("Primary checking"),
      createAccountFixture("Second family checking"),
    ])
    const first = firstFixture.owner
    const second = secondFixture.owner
    const firstAccount = firstFixture.account

    const [visibleToFirst, visibleToSecond] = await Promise.all([
      harness.withFamily(first.family.id, (tx) =>
        tx.account.findMany({ orderBy: { name: "asc" } })
      ),
      harness.withFamily(second.family.id, (tx) =>
        tx.account.findMany({
          where: { id: firstAccount.id },
        })
      ),
    ])

    expect(visibleToFirst).toHaveLength(1)
    expect(visibleToFirst[0]?.familyId).toBe(first.family.id)
    expect(visibleToSecond).toHaveLength(0)
  })

  test("creates M2 ledger fixture rows through factories", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, category, merchant] = await Promise.all([
      factories.createAccount({
        familyId: owner.family.id,
        name: "Ledger account",
      }),
      factories.createCategory({
        familyId: owner.family.id,
        type: "expense",
      }),
      factories.createMerchant({
        familyId: owner.family.id,
      }),
    ])
    const transaction = await factories.createTransaction({
      accountId: account.id,
      categoryId: category.id,
      familyId: owner.family.id,
      merchantId: merchant.id,
      userId: owner.user.id,
    })
    const idempotencyKey = factories.createIdempotencyKey()

    const persisted = await harness.withFamily(owner.family.id, (tx) =>
      tx.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
      })
    )

    expect(persisted.familyId).toBe(owner.family.id)
    expect(persisted.amount).toBe(-12_345n)
    expect(idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  async function createAccountFixture(name: string) {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      familyId: owner.family.id,
      name,
    })

    return { account, owner }
  }
})
