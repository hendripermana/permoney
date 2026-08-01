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

type Owner = Awaited<
  ReturnType<TestFactories["createAuthenticatedOnboardedUser"]>
>

// Pure net-worth reducer (module scope: no harness dependency). Single-currency
// (IDR) fixtures, base = IDR: the rate resolver is never consulted (identity
// path), so it can safely return null.
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
  return normalizeNetWorthAt(balances, () => null, "IDR").netWorth
}

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

  // --- Arrange/act helpers: collapse the repeated
  // `{ data, familyId, user, runInTenantTransaction }` ceremony so each test
  // reads as intent, not boilerplate. ---

  const memberCtx = (owner: Owner) => ({
    familyId: owner.family.id,
    user: owner.user,
    runInTenantTransaction: harness.withMember,
  })

  const readerCtx = (owner: Owner) => ({
    familyId: owner.family.id,
    userId: owner.user.id,
    runInTenantTransaction: harness.withMember,
  })

  async function setup(
    cashBalance: bigint,
    personName = "Budi"
  ): Promise<{ owner: Owner; cash: { id: string }; person: { id: string } }> {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: cashBalance,
      familyId: owner.family.id,
      name: "Cash",
    })
    const person = await createPersonForFamily({
      data: {
        name: personName,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      ...memberCtx(owner),
    })
    return { owner, cash, person }
  }

  const lend = (
    owner: Owner,
    personMerchantId: string,
    fromAccountId: string,
    amount: string,
    opts?: { date?: Date; idempotencyKey?: string }
  ) =>
    recordLendForFamily({
      data: {
        personMerchantId,
        fromAccountId,
        amount,
        idempotencyKey:
          opts?.idempotencyKey ?? factories.createIdempotencyKey(),
        ...(opts?.date ? { date: opts.date } : {}),
      },
      ...memberCtx(owner),
    })

  const borrow = (
    owner: Owner,
    personMerchantId: string,
    toAccountId: string,
    amount: string
  ) =>
    recordBorrowForFamily({
      data: {
        personMerchantId,
        toAccountId,
        amount,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      ...memberCtx(owner),
    })

  const repay = (
    owner: Owner,
    personMerchantId: string,
    direction: "receivable" | "loan",
    cashAccountId: string,
    amount: string
  ) =>
    recordRepaymentForFamily({
      data: {
        personMerchantId,
        direction,
        cashAccountId,
        amount,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      ...memberCtx(owner),
    })

  const debtsOf = (owner: Owner) => getPersonDebtsForFamily(readerCtx(owner))
  const personsOf = (owner: Owner) => getPersonsForFamily(readerCtx(owner))
  const listAccounts = (owner: Owner, includeCounterparty?: boolean) =>
    getAccountsForFamily({
      ...readerCtx(owner),
      ...(includeCounterparty === undefined ? {} : { includeCounterparty }),
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

  test("lend creates a RECEIVABLE that grows while cash drops", async () => {
    const { owner, cash, person: budi } = await setup(100_000n)

    await lend(owner, budi.id, cash.id, "40000")

    const accounts = await readAccounts(owner.family.id)
    const cashRow = accounts.find((a) => a.id === cash.id)
    const receivable = accounts.find(
      (a) => a.counterpartyMerchantId === budi.id
    )
    expect(cashRow?.balance).toBe(60_000n)
    expect(receivable?.accountType).toBe("RECEIVABLE")
    expect(receivable?.balance).toBe(40_000n)

    const debts = await debtsOf(owner)
    expect(debts).toHaveLength(1)
    expect(debts[0].personId).toBe(budi.id)
    expect(debts[0].settled).toBe(false)
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "40000" }])
  })

  test("borrow creates a LOAN + cash grows (liability_draw)", async () => {
    const { owner, cash, person: abah } = await setup(0n, "Abah")

    const draw = await borrow(owner, abah.id, cash.id, "30000")
    expect(draw.kind).toBe("liability_draw")

    const accounts = await readAccounts(owner.family.id)
    const cashRow = accounts.find((a) => a.id === cash.id)
    const loan = accounts.find((a) => a.counterpartyMerchantId === abah.id)
    expect(cashRow?.balance).toBe(30_000n)
    expect(loan?.accountType).toBe("LOAN")
    expect(loan?.balance).toBe(-30_000n)

    const debts = await debtsOf(owner)
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "-30000" }])
    expect(debts[0].settled).toBe(false)
  })

  test("net position aggregates a person's accounts; repay to zero settles", async () => {
    const { owner, cash, person: budi } = await setup(100_000n)

    // Lend 50k (receivable +50k) AND borrow 20k from the same person
    // (loan -20k). Net across the two linked accounts = +30k.
    await lend(owner, budi.id, cash.id, "50000")
    await borrow(owner, budi.id, cash.id, "20000")

    let debts = await debtsOf(owner)
    expect(debts[0].accounts).toHaveLength(2)
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "30000" }])
    expect(debts[0].settled).toBe(false)

    // Repay both sides fully → net 0 → settled (Lunas).
    await repay(owner, budi.id, "receivable", cash.id, "50000")
    await repay(owner, budi.id, "loan", cash.id, "20000")

    debts = await debtsOf(owner)
    expect(debts[0].positions).toEqual([{ currency: "IDR", net: "0" }])
    expect(debts[0].settled).toBe(true)

    // Cash is back where it started: -50k lend +20k borrow +50k repaid -20k repaid.
    const accounts = await readAccounts(owner.family.id)
    expect(accounts.find((a) => a.id === cash.id)?.balance).toBe(100_000n)
  })

  test("net-worth TOTAL is identical whether or not debts are counterparty-linked", async () => {
    const { owner, cash, person: budi } = await setup(100_000n)

    await lend(owner, budi.id, cash.id, "40000")
    await borrow(owner, budi.id, cash.id, "30000")

    // While linked: the main list (includeCounterparty:false) excludes the two
    // debt accounts, but the net-worth math (includeCounterparty:true) keeps them.
    const listedOnly = await listAccounts(owner, false)
    expect(listedOnly).toHaveLength(1)
    expect(listedOnly[0].id).toBe(cash.id)

    const withDebtsLinked = await listAccounts(owner)
    expect(withDebtsLinked).toHaveLength(3)
    const totalLinked = netWorthOf(withDebtsLinked)

    // Unlink the debt accounts: now plain RECEIVABLE/LOAN accounts, no flag.
    await harness.withMember(owner.family.id, owner.user.id, async (tx) => {
      await tx.account.updateMany({
        where: { familyId: owner.family.id, counterpartyMerchantId: budi.id },
        data: { counterpartyMerchantId: null },
      })
    })
    const afterUnlink = await listAccounts(owner)
    expect(afterUnlink).toHaveLength(3)
    const totalUnlinked = netWorthOf(afterUnlink)

    // The flag is presentation only: the grand total NEVER moves.
    expect(totalLinked).toBe(totalUnlinked)
    // Sanity: net worth = 100k (lending/borrowing nets to a wash on net worth).
    expect(totalLinked).toBe(100_000n)
  })

  test("tenant isolation: family B cannot see family A's persons or debts", async () => {
    const { owner: ownerA, cash: cashA, person: budi } = await setup(100_000n)
    const ownerB = await factories.createAuthenticatedOnboardedUser()

    await lend(ownerA, budi.id, cashA.id, "40000")

    expect(await debtsOf(ownerB)).toEqual([])
    expect(await personsOf(ownerB)).toEqual([])

    // And family A still sees its own.
    expect(await debtsOf(ownerA)).toHaveLength(1)
  })

  test("idempotency replay of a lend is a no-op", async () => {
    const { owner, cash, person: budi } = await setup(100_000n)

    const key = factories.createIdempotencyKey()
    // A genuine replay re-sends the IDENTICAL request, date included (the client
    // stamps the date once, so a network retry carries the same bytes).
    const date = new Date("2026-06-05T00:00:00.000Z")
    const lendOnce = () =>
      lend(owner, budi.id, cash.id, "40000", { date, idempotencyKey: key })

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
})
