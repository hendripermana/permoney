import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  AccountBalanceSignError,
  createTransactionForFamily,
} from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// ADR-0045 — the DB check `account_normal_balance_sign` is the durable last
// line of defense, but a write that trips it must surface to the user as a
// readable 422 (AccountBalanceSignError), never as a raw Postgres 23514
// Prisma error. Production evidence: 18× 23514 out of createTransactionFn in
// 15 minutes on a single family (2026-09-27), each one a broken save with no
// actionable message. These are real-Postgres boundary tests for the guard
// raised from the `applyAccountBalanceDelta` choke point.
describe("balance sign guard (ADR-0045) — readable 422 before the DB 23514", () => {
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

  async function createOwnerWithAccount(accountType: string, balance: bigint) {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [account, category] = await Promise.all([
      factories.createAccount({
        accountType: accountType as "CASH",
        balance,
        familyId: owner.family.id,
        name: `Guard ${accountType}`,
      }),
      factories.createCategory({
        familyId: owner.family.id,
        name: "Guard category",
        type: "expense",
      }),
    ])
    return { account, category, owner }
  }

  function balancePayload(
    accountId: string,
    type: "expense" | "income",
    amount: bigint
  ) {
    return {
      idempotencyKey: factories.createIdempotencyKey(),
      accountId,
      amount,
      categoryId: null,
      date: new Date("2026-09-27T00:00:00.000Z"),
      description: "Balance sign guard probe",
      type,
    }
  }

  test("an expense taking a CASH account below zero is rejected with a readable 422 and leaves the balance untouched", async () => {
    const { account, owner } = await createOwnerWithAccount("CASH", 100n)

    await expect(
      createTransactionForFamily({
        data: balancePayload(account.id, "expense", 150n),
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).rejects.toThrow(AccountBalanceSignError)

    const after = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(after.balance).toBe(100n)
    const rows = await harness.withFamily(owner.family.id, (tx) =>
      tx.transaction.count({ where: { accountId: account.id } })
    )
    expect(rows).toBe(0)
  })

  test("an expense that takes a CASH account to exactly zero is allowed (boundary)", async () => {
    const { account, owner } = await createOwnerWithAccount("CASH", 100n)

    await expect(
      createTransactionForFamily({
        data: balancePayload(account.id, "expense", 100n),
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).resolves.toEqual(expect.anything())

    const after = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(after.balance).toBe(0n)
  })

  test("a DEPOSITORY overdraft is allowed (ADR-0045 carve-out)", async () => {
    const { account, owner } = await createOwnerWithAccount("DEPOSITORY", 0n)

    await expect(
      createTransactionForFamily({
        data: balancePayload(account.id, "expense", 50n),
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).resolves.toEqual(expect.anything())

    const after = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(after.balance).toBe(-50n)
  })

  test("an income pushing a zero-balance credit card positive is rejected with a readable 422", async () => {
    const { account, owner } = await createOwnerWithAccount("CREDIT", 0n)

    await expect(
      createTransactionForFamily({
        data: balancePayload(account.id, "income", 50n),
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).rejects.toThrow(AccountBalanceSignError)

    const after = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(after.balance).toBe(0n)
  })

  test("an income that pays a credit card off to exactly zero is allowed", async () => {
    const { account, owner } = await createOwnerWithAccount("CREDIT", -100n)

    await expect(
      createTransactionForFamily({
        data: balancePayload(account.id, "income", 100n),
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    ).resolves.toEqual(expect.anything())

    const after = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(after.balance).toBe(0n)
  })
})
