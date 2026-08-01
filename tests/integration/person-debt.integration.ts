import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { getAccountsForFamily } from "../../src/server/accounts"
import {
  createPersonForFamily,
  getPersonDebtsForFamily,
  getPersonsForFamily,
  recordBorrowForFamily,
  recordLendForFamily,
  recordRepaymentForFamily,
} from "../../src/server/debts"
import { normalizeNetWorthAt, type PointBalance } from "../../src/lib/net-worth"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-212 / ADR-0049 — person-to-person debt (Utang-Piutang). A person-debt is
// an ordinary RECEIVABLE/LOAN account flagged by a person Merchant, and every
// flow is a plain transfer through `createTransactionForFamily`. These tests
// prove the real boundary: balances, net position aggregation, the net-worth
// TOTAL invariant (grouping is presentation-only), tenant isolation, and
// idempotency replay — all against real Postgres.

describe("PER-212 person-to-person debt", () => {
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

  test("lend creates a RECEIVABLE that grows while cash drops", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Cash",
    })
    const budi = await createPersonForFamily({
      data: { name: "Budi", idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    await recordLendForFamily({
      data: {
        personMerchantId: budi.id,
        fromAccountId: cash.id,
        amount: "40000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    const accounts = await readAccounts(owner.family.id)
    const cashRow = accounts.find((a) => a.id === cash.id)
    const receivable = accounts.find(
      (a) => a.counterpartyMerchantId === budi.id
    )
    expect(cashRow?.balance).toBe(60_000n)
    expect(receivable?.accountType).toBe("RECEIVABLE")
    expect(receivable?.balance).toBe(40_000n)

    const debts = await getPersonDebtsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(debts).toHaveLength(1)
    expect(debts[0].personId).toBe(budi.id)
    expect(debts[0].settled).toBe(false)
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "40000" }])
  })

  test("borrow creates a LOAN + cash grows (liability_draw)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 0n,
      familyId: owner.family.id,
      name: "Cash",
    })
    const abah = await createPersonForFamily({
      data: { name: "Abah", idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    const draw = await recordBorrowForFamily({
      data: {
        personMerchantId: abah.id,
        toAccountId: cash.id,
        amount: "30000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    expect(draw.kind).toBe("liability_draw")

    const accounts = await readAccounts(owner.family.id)
    const cashRow = accounts.find((a) => a.id === cash.id)
    const loan = accounts.find((a) => a.counterpartyMerchantId === abah.id)
    expect(cashRow?.balance).toBe(30_000n)
    expect(loan?.accountType).toBe("LOAN")
    expect(loan?.balance).toBe(-30_000n)

    const debts = await getPersonDebtsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "-30000" }])
    expect(debts[0].settled).toBe(false)
  })

  test("net position aggregates a person's accounts; repay to zero settles", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Cash",
    })
    const budi = await createPersonForFamily({
      data: { name: "Budi", idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    // Lend 50k (receivable +50k) AND borrow 20k from the same person
    // (loan -20k). Net across the two linked accounts = +30k.
    await recordLendForFamily({
      data: {
        personMerchantId: budi.id,
        fromAccountId: cash.id,
        amount: "50000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })
    await recordBorrowForFamily({
      data: {
        personMerchantId: budi.id,
        toAccountId: cash.id,
        amount: "20000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    let debts = await getPersonDebtsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(debts[0].accounts).toHaveLength(2)
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "30000" }])
    expect(debts[0].settled).toBe(false)

    // Repay both sides fully → net 0 → settled (Lunas).
    await recordRepaymentForFamily({
      data: {
        personMerchantId: budi.id,
        direction: "receivable",
        cashAccountId: cash.id,
        amount: "50000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })
    await recordRepaymentForFamily({
      data: {
        personMerchantId: budi.id,
        direction: "loan",
        cashAccountId: cash.id,
        amount: "20000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    debts = await getPersonDebtsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "0" }])
    expect(debts[0].settled).toBe(true)

    // Cash is back where it started: -50k lend +20k borrow +50k repaid -20k repaid.
    const accounts = await readAccounts(owner.family.id)
    expect(accounts.find((a) => a.id === cash.id)?.balance).toBe(100_000n)
  })

  test("net-worth TOTAL is identical whether or not debts are counterparty-linked", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Cash",
    })
    const budi = await createPersonForFamily({
      data: { name: "Budi", idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    await recordLendForFamily({
      data: {
        personMerchantId: budi.id,
        fromAccountId: cash.id,
        amount: "40000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })
    await recordBorrowForFamily({
      data: {
        personMerchantId: budi.id,
        toAccountId: cash.id,
        amount: "30000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    // While linked: the main list (includeCounterparty:false) excludes the two
    // debt accounts, but the net-worth math (includeCounterparty:true) keeps them.
    const listedOnly = await getAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      includeCounterparty: false,
      runInTenantTransaction: harness.withMember,
    })
    expect(listedOnly).toHaveLength(1)
    expect(listedOnly[0].id).toBe(cash.id)

    const withDebtsLinked = await getAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(withDebtsLinked).toHaveLength(3)
    const totalLinked = netWorthOf(withDebtsLinked)

    // Unlink the debt accounts: now plain RECEIVABLE/LOAN accounts, no flag.
    await harness.withMember(owner.family.id, owner.user.id, async (tx) => {
      await tx.account.updateMany({
        where: { familyId: owner.family.id, counterpartyMerchantId: budi.id },
        data: { counterpartyMerchantId: null },
      })
    })
    const afterUnlink = await getAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(afterUnlink).toHaveLength(3)
    const totalUnlinked = netWorthOf(afterUnlink)

    // The flag is presentation only: the grand total NEVER moves.
    expect(totalLinked).toBe(totalUnlinked)
    // Sanity: net worth = 100k (lending/borrowing nets to a wash on net worth).
    expect(totalLinked).toBe(100_000n)
  })

  test("tenant isolation: family B cannot see family A's persons or debts", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    const ownerB = await factories.createAuthenticatedOnboardedUser()
    const cashA = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 100_000n,
      familyId: ownerA.family.id,
      name: "A Cash",
    })
    const budi = await createPersonForFamily({
      data: { name: "Budi", idempotencyKey: factories.createIdempotencyKey() },
      familyId: ownerA.family.id,
      user: ownerA.user,
      runInTenantTransaction: harness.withMember,
    })
    await recordLendForFamily({
      data: {
        personMerchantId: budi.id,
        fromAccountId: cashA.id,
        amount: "40000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: ownerA.family.id,
      user: ownerA.user,
      runInTenantTransaction: harness.withMember,
    })

    const debtsB = await getPersonDebtsForFamily({
      familyId: ownerB.family.id,
      userId: ownerB.user.id,
      runInTenantTransaction: harness.withMember,
    })
    const personsB = await getPersonsForFamily({
      familyId: ownerB.family.id,
      userId: ownerB.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(debtsB).toEqual([])
    expect(personsB).toEqual([])

    // And family A still sees its own.
    const debtsA = await getPersonDebtsForFamily({
      familyId: ownerA.family.id,
      userId: ownerA.user.id,
      runInTenantTransaction: harness.withMember,
    })
    expect(debtsA).toHaveLength(1)
  })

  test("idempotency replay of a lend is a no-op", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 100_000n,
      familyId: owner.family.id,
      name: "Cash",
    })
    const budi = await createPersonForFamily({
      data: { name: "Budi", idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      user: owner.user,
      runInTenantTransaction: harness.withMember,
    })

    const key = factories.createIdempotencyKey()
    // A genuine replay re-sends the IDENTICAL request, date included (the client
    // stamps the date once, so a network retry carries the same bytes).
    const date = new Date("2026-06-05T00:00:00.000Z")
    const lendOnce = () =>
      recordLendForFamily({
        data: {
          personMerchantId: budi.id,
          fromAccountId: cash.id,
          amount: "40000",
          date,
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        user: owner.user,
        runInTenantTransaction: harness.withMember,
      })

    await lendOnce()
    await lendOnce() // replay: same key, same payload

    const accounts = await readAccounts(owner.family.id)
    const receivables = accounts.filter(
      (a) => a.counterpartyMerchantId === budi.id
    )
    // Exactly one receivable account, balance applied exactly once.
    expect(receivables).toHaveLength(1)
    expect(receivables[0].balance).toBe(40_000n)
    expect(accounts.find((a) => a.id === cash.id)?.balance).toBe(60_000n)

    // Exactly two transaction legs total (one transfer, replayed = no new rows).
    const txCount = await harness.withMember(
      owner.family.id,
      owner.user.id,
      (tx) => tx.transaction.count({ where: { familyId: owner.family.id } })
    )
    expect(txCount).toBe(2)
  })

  async function readAccounts(familyId: string) {
    return await harness.withFamily(familyId, (tx) =>
      tx.account.findMany({
        select: {
          id: true,
          accountType: true,
          accountClass: true,
          balance: true,
          currency: true,
          counterpartyMerchantId: true,
        },
        where: { familyId, deletedAt: null },
      })
    )
  }

  function netWorthOf(
    accounts: ReadonlyArray<{
      accountClass: string
      currency: string
      balance: string
    }>
  ): bigint {
    const balances: PointBalance[] = accounts.map((a) => ({
      accountClass: a.accountClass,
      currency: a.currency,
      native: BigInt(a.balance),
    }))
    // Single-currency (IDR) fixture, base = IDR: the rate resolver is never
    // consulted (identity path), so it can safely return null.
    return normalizeNetWorthAt(balances, () => null, "IDR").netWorth
  }
})
