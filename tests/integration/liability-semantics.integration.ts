import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  isLiabilityCostKind,
  isOrdinarySpendingTransaction,
} from "../../src/lib/liability-semantics"
import { createTransactionForFamily } from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

const LEDGER_TEST_DATE = new Date("2026-06-05T00:00:00.000Z")
const DATABASE_CONSTRAINT_REJECTION =
  /constraint|foreign key|violates|P2003|P2004|23503|23514|PER-74/i

describe("PER-74 liability semantics", () => {
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

  test("credit-card payment is a liability transfer, not ordinary spending", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [cashAccount, creditAccount] = await Promise.all([
      factories.createAccount({
        accountType: "DEPOSITORY",
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-74 checking",
      }),
      factories.createAccount({
        accountType: "CREDIT",
        balance: -50_000n,
        familyId: owner.family.id,
        name: "PER-74 credit card",
      }),
    ])

    const payment = await createTransactionForFamily({
      data: {
        accountId: cashAccount.id,
        amount: 20_000n,
        date: LEDGER_TEST_DATE,
        description: "PER-74 credit-card payment",
        idempotencyKey: factories.createIdempotencyKey(),
        toAccountId: creditAccount.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    const [balances, rows] = await Promise.all([
      readBalances(owner.family.id, [cashAccount.id, creditAccount.id]),
      readTransactions(owner.family.id),
    ])

    expect(payment.kind).toBe("cc_payment")
    expect(balances).toEqual(
      new Map([
        [cashAccount.id, 80_000n],
        [creditAccount.id, -30_000n],
      ])
    )
    expect(rows.filter((row) => row.kind === "cc_payment")).toHaveLength(2)
    expect(rows.filter((row) => row.type === "expense")).toHaveLength(0)
    expect(
      rows.every(
        (row) =>
          !isOrdinarySpendingTransaction({
            kind: row.kind,
            type: row.type,
          })
      )
    ).toBe(true)
  })

  test("loan draw is new borrowing, not a normal asset transfer", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [loanAccount, cashAccount] = await Promise.all([
      factories.createAccount({
        accountSubtype: "personal_loan",
        accountType: "LOAN",
        balance: 0n,
        familyId: owner.family.id,
        name: "PER-74 loan",
      }),
      factories.createAccount({
        accountType: "DEPOSITORY",
        balance: 0n,
        familyId: owner.family.id,
        name: "PER-74 draw destination",
      }),
    ])

    const draw = await createTransactionForFamily({
      data: {
        accountId: loanAccount.id,
        amount: 100_000n,
        date: LEDGER_TEST_DATE,
        description: "PER-74 loan disbursement",
        idempotencyKey: factories.createIdempotencyKey(),
        toAccountId: cashAccount.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    const [balances, rows] = await Promise.all([
      readBalances(owner.family.id, [loanAccount.id, cashAccount.id]),
      readTransactions(owner.family.id),
    ])

    expect(draw.kind).toBe("liability_draw")
    expect(balances).toEqual(
      new Map([
        [loanAccount.id, -100_000n],
        [cashAccount.id, 100_000n],
      ])
    )
    expect(rows.filter((row) => row.kind === "liability_draw")).toHaveLength(2)
  })

  test("loan payment separates principal transfer from interest and fee expenses", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [cashAccount, loanAccount, financeChargeCategory] = await Promise.all(
      [
        factories.createAccount({
          accountType: "DEPOSITORY",
          balance: 150_000n,
          familyId: owner.family.id,
          name: "PER-74 payment source",
        }),
        factories.createAccount({
          accountSubtype: "bnpl",
          accountType: "LOAN",
          balance: -100_000n,
          familyId: owner.family.id,
          name: "PER-74 BNPL loan",
        }),
        factories.createCategory({
          familyId: owner.family.id,
          name: "PER-74 finance charges",
          type: "expense",
        }),
      ]
    )

    const principal = await createTransactionForFamily({
      data: {
        accountId: cashAccount.id,
        amount: 70_000n,
        date: LEDGER_TEST_DATE,
        description: "PER-74 loan principal payment",
        idempotencyKey: factories.createIdempotencyKey(),
        toAccountId: loanAccount.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })
    const interest = await createTransactionForFamily({
      data: {
        accountId: cashAccount.id,
        amount: 5_000n,
        categoryId: financeChargeCategory.id,
        date: LEDGER_TEST_DATE,
        description: "PER-74 loan interest",
        idempotencyKey: factories.createIdempotencyKey(),
        kind: "liability_interest",
        toAccountId: loanAccount.id,
        type: "expense",
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })
    const fee = await createTransactionForFamily({
      data: {
        accountId: cashAccount.id,
        amount: 2_000n,
        categoryId: financeChargeCategory.id,
        date: LEDGER_TEST_DATE,
        description: "PER-74 loan fee",
        idempotencyKey: factories.createIdempotencyKey(),
        kind: "liability_fee",
        toAccountId: loanAccount.id,
        type: "expense",
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withFamily,
      user: owner.user,
    })

    const [balances, rows] = await Promise.all([
      readBalances(owner.family.id, [cashAccount.id, loanAccount.id]),
      readTransactions(owner.family.id),
    ])
    const liabilityCostRows = rows.filter((row) =>
      isLiabilityCostKind(row.kind)
    )

    expect(principal.kind).toBe("loan_payment")
    expect(interest.kind).toBe("liability_interest")
    expect(fee.kind).toBe("liability_fee")
    expect(balances).toEqual(
      new Map([
        [cashAccount.id, 73_000n],
        [loanAccount.id, -30_000n],
      ])
    )
    expect(rows.filter((row) => row.kind === "loan_payment")).toHaveLength(2)
    expect(liabilityCostRows).toHaveLength(2)
    expect(
      liabilityCostRows.every(
        (row) =>
          row.type === "expense" &&
          row.accountId === cashAccount.id &&
          row.toAccountId === loanAccount.id &&
          !isOrdinarySpendingTransaction({
            kind: row.kind,
            type: row.type,
          })
      )
    ).toBe(true)
  })

  test("database rejects liability cost rows that do not point at a liability account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [cashAccount, otherAssetAccount] = await Promise.all([
      factories.createAccount({
        accountType: "DEPOSITORY",
        balance: 100_000n,
        familyId: owner.family.id,
        name: "PER-74 invalid source",
      }),
      factories.createAccount({
        accountType: "E_WALLET",
        balance: 0n,
        familyId: owner.family.id,
        name: "PER-74 invalid liability target",
      }),
    ])

    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: cashAccount.id,
            amount: -1_000n,
            currency: "IDR",
            description: "PER-74 invalid liability interest",
            familyId: owner.family.id,
            kind: "liability_interest",
            toAccountId: otherAssetAccount.id,
            type: "expense",
            userId: owner.user.id,
          },
        })
      )
    )
  })

  async function readBalances(familyId: string, accountIds: string[]) {
    const rows = await harness.withFamily(familyId, (tx) =>
      tx.account.findMany({
        orderBy: { id: "asc" },
        select: { balance: true, id: true },
        where: { familyId, id: { in: accountIds } },
      })
    )
    return new Map(rows.map((row) => [row.id, row.balance]))
  }

  async function readTransactions(familyId: string) {
    return await harness.withFamily(familyId, (tx) =>
      tx.transaction.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          accountId: true,
          amount: true,
          id: true,
          kind: true,
          toAccountId: true,
          type: true,
        },
        where: { familyId },
      })
    )
  }

  async function expectDatabaseRejection(operation: () => Promise<unknown>) {
    await expect(operation()).rejects.toThrow(DATABASE_CONSTRAINT_REJECTION)
  }
})
