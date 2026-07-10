import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  ACCOUNT_TYPE_VALUES,
  allowsNegativeAssetBalance,
} from "../../src/lib/accounts"
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

    expect(rows.map((row) => row.code)).toEqual(
      Object.keys(CURRENCIES).sort((left, right) => left.localeCompare(right))
    )
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
            kind: "funds_movement",
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
            kind: "funds_movement",
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
            accountClass: "ASSET",
            accountSubtype: "checking",
            accountType: "VAULT",
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
            accountClass: "ASSET",
            accountSubtype: "checking",
            accountType: "DEPOSITORY",
          },
        })
      )
    )
  })

  test("rejects malformed account taxonomy and normal-balance drift", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    await expectDatabaseRejection(() =>
      harness.withFamily(
        owner.family.id,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "Account" (
            id,
            name,
            "accountClass",
            "accountType",
            "accountSubtype",
            balance,
            currency,
            color,
            status,
            "familyId"
          )
          VALUES (
            'invalid-account-class',
            'Invalid account class',
            'EXPENSE',
            'DEPOSITORY',
            'checking',
            0,
            'IDR',
            '#2563eb',
            'active',
            ${owner.family.id}
          )
        `
      )
    )

    await expectDatabaseRejection(() =>
      harness.withFamily(
        owner.family.id,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "Account" (
            id,
            name,
            "accountClass",
            "accountType",
            "accountSubtype",
            balance,
            currency,
            color,
            status,
            "familyId"
          )
          VALUES (
            'invalid-account-class-type-pair',
            'Invalid account class type pair',
            'ASSET',
            'CREDIT',
            'credit_card',
            0,
            'IDR',
            '#2563eb',
            'active',
            ${owner.family.id}
          )
        `
      )
    )

    await expectDatabaseRejection(() =>
      harness.withFamily(
        owner.family.id,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "Account" (
            id,
            name,
            "accountClass",
            "accountType",
            "accountSubtype",
            balance,
            currency,
            color,
            status,
            "familyId"
          )
          VALUES (
            'invalid-positive-liability-balance',
            'Invalid positive liability balance',
            'LIABILITY',
            'LOAN',
            'personal_loan',
            100,
            'IDR',
            '#2563eb',
            'active',
            ${owner.family.id}
          )
        `
      )
    )
  })

  test("rejects negative balances for asset account classes outside the ADR-0045 carve-out", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    // CASH: a physical wallet cannot be negative — always a data error, never
    // legitimate (ADR-0045 §1). DEPOSITORY/E_WALLET are the only carve-out
    // types; every other ASSET type keeps the original unconditional rule.
    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: -100n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Invalid negative cash wallet",
            status: "active",
            accountClass: "ASSET",
            accountSubtype: "cash",
            accountType: "CASH",
          },
        })
      )
    )

    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: -100n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Invalid negative receivable",
            status: "active",
            accountClass: "ASSET",
            accountSubtype: "receivable",
            accountType: "RECEIVABLE",
          },
        })
      )
    )
  })

  test("ADR-0045: allows a final-negative balance for DEPOSITORY/E_WALLET (real overdraft)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    const depository = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.create({
        data: {
          balance: -164298n,
          color: "#2563eb",
          currency: "IDR",
          familyId: owner.family.id,
          name: "Overdrawn checking",
          status: "active",
          accountClass: "ASSET",
          accountSubtype: "checking",
          accountType: "DEPOSITORY",
        },
      })
    )
    expect(depository.balance).toBe(-164298n)

    const eWallet = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.create({
        data: {
          balance: -164298n,
          color: "#2563eb",
          currency: "IDR",
          familyId: owner.family.id,
          name: "Dana",
          status: "active",
          accountClass: "ASSET",
          accountSubtype: "cash",
          accountType: "E_WALLET",
        },
      })
    )
    expect(eWallet.balance).toBe(-164298n)
  })

  test("ADR-0045: app_allows_negative_asset() and allowsNegativeAssetBalance() agree for every accountType", async () => {
    interface AllowedRow {
      allowed: boolean
    }

    for (const accountType of ACCOUNT_TYPE_VALUES) {
      const [row] = await harness.prisma.$queryRaw<AllowedRow[]>`
        SELECT app_allows_negative_asset(${accountType}) AS allowed
      `
      expect(row?.allowed, `mismatch for accountType=${accountType}`).toBe(
        allowsNegativeAssetBalance(accountType)
      )
    }
  })

  test("ADR-0044 §8: app.bulk_ledger_replay bypass is transaction-scoped and covers both directions", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    // Without the GUC, a strict-type negative ASSET balance is rejected —
    // the live-path baseline every wrapped bulk-replay call relies on.
    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: -1n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Strict type, no bypass",
            status: "active",
            accountClass: "ASSET",
            accountSubtype: "cash",
            accountType: "CASH",
          },
        })
      )
    )

    // With the GUC set (mirroring runBulkLedgerReplayTransaction), the same
    // otherwise-illegal write succeeds inside that transaction only — proving
    // the bypass clause disables BOTH directions (ASSET and LIABILITY) while
    // active, exactly as ADR-0044 §8 documents (the pre-flight validator +
    // un-bypassed rebuild are what keep this safe in production, not this
    // clause alone).
    await harness.withFamily(owner.family.id, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bulk_ledger_replay', 'on', true)`
      const cash = await tx.account.create({
        data: {
          balance: -1n,
          color: "#2563eb",
          currency: "IDR",
          familyId: owner.family.id,
          name: "Strict type, bypassed",
          status: "active",
          accountClass: "ASSET",
          accountSubtype: "cash",
          accountType: "CASH",
        },
      })
      expect(cash.balance).toBe(-1n)

      const loan = await tx.account.create({
        data: {
          balance: 1n,
          color: "#2563eb",
          currency: "IDR",
          familyId: owner.family.id,
          name: "Liability, bypassed",
          status: "active",
          accountClass: "LIABILITY",
          accountSubtype: "personal_loan",
          accountType: "LOAN",
        },
      })
      expect(loan.balance).toBe(1n)
    })

    // Bypass never leaks across transactions — a fresh transaction on the
    // same connection pool is strictly enforced again.
    await expectDatabaseRejection(() =>
      harness.withFamily(owner.family.id, (tx) =>
        tx.account.create({
          data: {
            balance: -1n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Strict type, no bypass again",
            status: "active",
            accountClass: "ASSET",
            accountSubtype: "cash",
            accountType: "CASH",
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
            accountClass: "ASSET",
            accountSubtype: "checking",
            accountType: "DEPOSITORY",
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
        accountType: "DEPOSITORY",
        balance: 10_000n,
        familyId: owner.family.id,
        name: "Valid asset account",
      }),
      factories.createAccount({
        accountType: "CREDIT",
        balance: -10_000n,
        familyId: owner.family.id,
        name: "Valid credit account",
      }),
    ])

    const [expense, income, validSplit] = await Promise.all([
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

    // PER-103: a transfer is a pair of transfer-typed Transactions linked by a
    // Transfer row; the deferred pairing trigger fires at COMMIT, so both legs
    // and the Transfer are created in one transaction. Run sequentially (not in
    // the Promise.all above) so the multi-account writes do not serialize-
    // conflict with the concurrent fixtures touching the same asset account.
    const transfer = await harness.withFamily(owner.family.id, async (tx) => {
      const outflow = await tx.transaction.create({
        data: {
          accountId: assetAccount.id,
          amount: -1_000n,
          currency: "IDR",
          description: "Valid multi-currency transfer",
          destinationAmount: 100n,
          destinationCurrency: "USD",
          familyId: owner.family.id,
          kind: "cc_payment",
          toAccountId: creditAccount.id,
          type: "transfer",
          userId: owner.user.id,
        },
      })
      const inflow = await tx.transaction.create({
        data: {
          accountId: creditAccount.id,
          amount: 100n,
          currency: "USD",
          description: "Valid multi-currency transfer",
          familyId: owner.family.id,
          kind: "cc_payment",
          toAccountId: assetAccount.id,
          type: "transfer",
          userId: owner.user.id,
        },
      })
      await tx.transfer.create({
        data: {
          inflowTransactionId: inflow.id,
          outflowTransactionId: outflow.id,
        },
      })
      return outflow
    })

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
