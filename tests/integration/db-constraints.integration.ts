import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { CURRENCIES } from "../../src/lib/data/currencies"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

const DATABASE_CONSTRAINT_REJECTION =
  /constraint|foreign key|violates|P2003|P2004|23503|23514|SplitEntries sum/i

interface CurrencyCodeRow {
  code: string
}

describe("M2 data-integrity database constraints", () => {
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

  test("seeds supported currencies from the TypeScript currency registry", async () => {
    const rows = await harness.prisma.$queryRaw<CurrencyCodeRow[]>`
      SELECT code
      FROM iso_4217_currency
      WHERE is_active = true
      ORDER BY code ASC
    `

    expect(rows.map((row) => row.code)).toEqual(Object.keys(CURRENCIES).sort())
  })

  test("rejects expense transactions with positive signed amounts", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: 1n,
            currency: "IDR",
            description: "Invalid positive expense",
            familyId: context.familyId,
            type: "expense",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects income transactions with negative signed amounts", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1n,
            currency: "IDR",
            description: "Invalid negative income",
            familyId: context.familyId,
            type: "income",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects transaction domain values outside the supported lifecycle contract", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "IDR",
            description: "Invalid transaction status",
            familyId: context.familyId,
            status: "VOIDED",
            type: "expense",
            userId: context.userId,
          },
        })
      )
    )

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "IDR",
            description: "Invalid transaction kind",
            familyId: context.familyId,
            kind: "wire_reversal",
            type: "expense",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects unsupported transaction currency codes", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "ZZZ",
            description: "Invalid transaction currency",
            familyId: context.familyId,
            type: "expense",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects unsupported destination currency codes", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "IDR",
            description: "Invalid destination currency",
            destinationAmount: 1_000n,
            destinationCurrency: "ZZZ",
            familyId: context.familyId,
            type: "transfer",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects unsupported family currency codes", async () => {
    await expectDatabaseRejection(() =>
      harness.prisma.family.create({
        data: {
          currency: "ZZZ",
          name: "Invalid family currency",
        },
      })
    )
  })

  test("rejects one-sided destination amount and currency pairs", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "IDR",
            description: "Missing destination currency",
            destinationAmount: 1_000n,
            destinationCurrency: null,
            familyId: context.familyId,
            type: "transfer",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects account domain values outside the supported account contract", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: 0n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Invalid account type",
            status: "active",
            type: "VAULT",
          },
        })
      )
    )

    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: 0n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Invalid account status",
            status: "archived",
            type: "DEPOSITORY",
          },
        })
      )
    )
  })

  test("rejects negative balances for non-credit account types", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: -100n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Invalid negative depository",
            status: "active",
            type: "DEPOSITORY",
          },
        })
      )
    )
  })

  test("rejects unsupported account currency codes", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: 0n,
            color: "#2563eb",
            currency: "ZZZ",
            familyId: owner.family.id,
            name: "Invalid account currency",
            status: "active",
            type: "DEPOSITORY",
          },
        })
      )
    )
  })

  test("rejects non-positive split entry amounts", async () => {
    const context = await createLedgerContext()
    const transaction = await factories.createTransaction({
      accountId: context.accountId,
      amount: -1_000n,
      familyId: context.familyId,
      userId: context.userId,
    })

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.splitEntry.create({
          data: {
            amount: 0n,
            description: "Invalid zero split amount",
            transactionId: transaction.id,
          },
        })
      )
    )
  })

  test("rejects split parents with category or merchant stored on the parent row", async () => {
    const context = await createLedgerContext()
    const [category, merchant] = await Promise.all([
      factories.createCategory({
        familyId: context.familyId,
      }),
      factories.createMerchant({
        familyId: context.familyId,
      }),
    ])

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            categoryId: category.id,
            currency: "IDR",
            description: "Invalid split parent category",
            familyId: context.familyId,
            isSplit: true,
            type: "expense",
            userId: context.userId,
          },
        })
      )
    )

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, (tx) =>
        tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "IDR",
            description: "Invalid split parent merchant",
            familyId: context.familyId,
            isSplit: true,
            merchantId: merchant.id,
            type: "expense",
            userId: context.userId,
          },
        })
      )
    )
  })

  test("rejects split transactions whose entries do not match the parent amount", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(context.familyId, async (tx) => {
        const transaction = await tx.transaction.create({
          data: {
            accountId: context.accountId,
            amount: -1_000n,
            currency: "IDR",
            description: "Invalid split parity",
            familyId: context.familyId,
            isSplit: true,
            type: "expense",
            userId: context.userId,
          },
        })

        await tx.splitEntry.createMany({
          data: [
            {
              amount: 400n,
              description: "First unmatched split line",
              transactionId: transaction.id,
            },
            {
              amount: 500n,
              description: "Second unmatched split line",
              transactionId: transaction.id,
            },
          ],
        })
      })
    )
  })

  test("rejects direct SQL writes that bypass application validators", async () => {
    const context = await createLedgerContext()

    await expectDatabaseRejection(() =>
      harness.withFamily(
        context.familyId,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "Transaction" (
            id,
            amount,
            type,
            kind,
            currency,
            status,
            description,
            "accountId",
            "userId",
            "familyId"
          )
          VALUES (
            'direct-invalid-tx',
            -1000,
            'expense',
            'standard',
            'IDR',
            'VOIDED',
            'Direct invalid transaction status',
            ${context.accountId},
            ${context.userId},
            ${context.familyId}
          )
        `
      )
    )
  })

  test("allows valid happy-path ledger rows", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const [assetAccount, creditAccount] = await Promise.all([
      factories.createAccount({
        balance: 10_000n,
        familyId: owner.family.id,
        name: "Valid asset account",
        type: "DEPOSITORY",
      }),
      factories.createAccount({
        balance: -10_000n,
        familyId: owner.family.id,
        name: "Valid credit account",
        type: "CREDIT",
      }),
    ])

    const [expense, income, transfer, validSplit] = await Promise.all([
      factories.createTransaction({
        accountId: assetAccount.id,
        amount: -1_000n,
        familyId: owner.family.id,
        type: "expense",
        userId: owner.user.id,
      }),
      factories.createTransaction({
        accountId: assetAccount.id,
        amount: 1_000n,
        familyId: owner.family.id,
        type: "income",
        userId: owner.user.id,
      }),
      harness.withFamily(owner.family.id, (tx) =>
        tx.transaction.create({
          data: {
            accountId: assetAccount.id,
            amount: -1_000n,
            currency: "IDR",
            description: "Valid multi-currency transfer",
            destinationAmount: 100n,
            destinationCurrency: "USD",
            familyId: owner.family.id,
            toAccountId: creditAccount.id,
            type: "transfer",
            userId: owner.user.id,
          },
        })
      ),
      harness.withFamily(owner.family.id, async (tx) => {
        const transaction = await tx.transaction.create({
          data: {
            accountId: assetAccount.id,
            amount: -1_000n,
            currency: "IDR",
            description: "Valid split expense",
            familyId: owner.family.id,
            isSplit: true,
            type: "expense",
            userId: owner.user.id,
          },
        })

        await tx.splitEntry.createMany({
          data: [
            {
              amount: 400n,
              description: "Valid first split line",
              transactionId: transaction.id,
            },
            {
              amount: 600n,
              description: "Valid second split line",
              transactionId: transaction.id,
            },
          ],
        })

        return transaction
      }),
    ])

    expect(expense.amount).toBe(-1_000n)
    expect(income.amount).toBe(1_000n)
    expect(transfer.destinationCurrency).toBe("USD")
    expect(validSplit.isSplit).toBe(true)
    expect(creditAccount.balance).toBe(-10_000n)
  })

  async function createLedgerContext() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })

    return {
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    }
  }
})

async function expectDatabaseRejection(
  operation: () => Promise<unknown>
): Promise<void> {
  await expect(operation()).rejects.toThrow(DATABASE_CONSTRAINT_REJECTION)
}
