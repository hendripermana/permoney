import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createAccountForFamily } from "@/server/accounts"
import { createTransactionForFamily } from "@/server/transactions"
import {
  createValuationForFamily,
  detectBalanceDriftForFamily,
  getAccountBalanceForFamily,
  rebuildAccountBalanceForFamily,
  rebuildFamilyBalances,
  ValuationError,
} from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("valuation primitive + balance rebuild & drift (PER-146 / ADR-0034)", () => {
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

  // Helper: read the live opening valuation for an account.
  const openingValuation = async (familyId: string, accountId: string) =>
    await harness.withFamily(familyId, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId, type: "opening", deletedAt: null },
      })
    )

  const accountRow = async (familyId: string, accountId: string) =>
    await harness.withFamily(familyId, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  // --------------------------------------------------------------------------
  // Opening balance recorded as the first valuation inside account create
  // --------------------------------------------------------------------------
  describe("opening valuation on account create", () => {
    test("cash account create writes exactly one signed opening valuation", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "BCA Checking",
          accountType: "DEPOSITORY",
          currency: "IDR",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const opening = await openingValuation(owner.family.id, account.id)
      expect(opening).not.toBeNull()
      expect(opening?.value).toBe(150000n)
      expect(opening?.type).toBe("opening")
      expect(opening?.normalBalance).toBe("POSITIVE")
      expect(opening?.currency).toBe("IDR")
    })

    test("liability account opening valuation is signed non-positive", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Visa",
          accountType: "CREDIT",
          openingBalance: "500000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const opening = await openingValuation(owner.family.id, account.id)
      expect(opening?.value).toBe(-500000n)
      expect(opening?.normalBalance).toBe("NEGATIVE")
    })

    test("tracked asset opening valuation drives its balance source", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Family Car",
          accountType: "TRACKED_ASSET",
          accountSubtype: "vehicle",
          openingBalance: "200000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(account.balanceSource).toBe("valuation")
      const opening = await openingValuation(owner.family.id, account.id)
      expect(opening?.value).toBe(200000000n)
    })

    test("opening valuation rides the account-create idempotency key (no duplicate on replay)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const payload = {
        data: {
          name: "Replay Wallet",
          accountType: "E_WALLET" as const,
          openingBalance: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      }
      const first = await createAccountForFamily(payload)
      await createAccountForFamily(payload)

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.count({ where: { accountId: first.id, type: "opening" } })
      )
      expect(count).toBe(1)
    })
  })

  // --------------------------------------------------------------------------
  // createValuationForFamily
  // --------------------------------------------------------------------------
  describe("createValuationForFamily", () => {
    const trackedAccount = async (owner: {
      family: { id: string }
      user: unknown
    }) =>
      await createAccountForFamily({
        data: {
          name: "Gold",
          accountType: "TRACKED_ASSET",
          accountSubtype: "collectible",
          openingBalance: "100000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user as never,
      })

    test("tracked valuation re-materializes the account balance and audits both rows", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await trackedAccount(owner)

      const valuation = await createValuationForFamily({
        data: {
          accountId: account.id,
          value: "125000000",
          type: "market",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(valuation.value).toBe("125000000")
      expect(valuation.type).toBe("market")

      const row = await accountRow(owner.family.id, account.id)
      expect(row.balance).toBe(125000000n)

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Valuation", entityId: valuation.id },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("create")
    })

    test("cash valuation is an observation only: it does NOT move the balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      await createValuationForFamily({
        data: {
          accountId: account.id,
          value: "175000",
          type: "reconciliation",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const row = await accountRow(owner.family.id, account.id)
      expect(row.balance).toBe(150000n) // unchanged
    })

    test("rejects a valuation whose currency differs from the account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await trackedAccount(owner)

      await expect(
        createValuationForFamily({
          data: {
            accountId: account.id,
            value: "1",
            currency: "USD",
            type: "market",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(ValuationError)
    })

    test("rejects creating an 'opening' valuation through the public path", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await trackedAccount(owner)

      await expect(
        createValuationForFamily({
          data: {
            accountId: account.id,
            value: "1",
            type: "opening" as never,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(ValuationError)
    })

    test("replaying the same idempotency key returns the same valuation and moves balance once", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await trackedAccount(owner)
      const payload = {
        data: {
          accountId: account.id,
          value: "140000000",
          type: "market" as const,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      }

      const first = await createValuationForFamily(payload)
      const second = await createValuationForFamily(payload)
      expect(second.id).toBe(first.id)

      const row = await accountRow(owner.family.id, account.id)
      expect(row.balance).toBe(140000000n) // applied exactly once

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.count({ where: { accountId: account.id, type: "market" } })
      )
      expect(count).toBe(1)
    })

    test("cannot create a valuation on another family's account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await trackedAccount(intruder)

      await expect(
        createValuationForFamily({
          data: {
            accountId: intruderAccount.id,
            value: "1",
            type: "market",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toThrow()

      // Intruder balance untouched.
      const row = await accountRow(intruder.family.id, intruderAccount.id)
      expect(row.balance).toBe(100000000n)
    })
  })

  // --------------------------------------------------------------------------
  // Balance rebuild
  // --------------------------------------------------------------------------
  describe("rebuildAccountBalanceForFamily", () => {
    test("is a no-op when the materialized balance already matches the canonical rows", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await createTransactionForFamily({
        data: {
          type: "expense",
          amount: "50000",
          description: "Groceries",
          accountId: account.id,
          date: new Date(),
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // Baseline: the expense already wrote one Account balance-update audit.
      const auditsBefore = await harness.withFamily(
        owner.family.id,
        async (tx) =>
          tx.auditLog.count({
            where: {
              entityType: "Account",
              entityId: account.id,
              action: "update",
            },
          })
      )

      const result = await rebuildAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(result.changed).toBe(false)
      expect(result.rebuiltBalance).toBe("100000")

      const auditsAfter = await harness.withFamily(
        owner.family.id,
        async (tx) =>
          tx.auditLog.count({
            where: {
              entityType: "Account",
              entityId: account.id,
              action: "update",
            },
          })
      )
      expect(auditsAfter).toBe(auditsBefore) // no-op rebuild writes no audit noise
    })

    test("repairs materialization drift for a cash account and audits the correction", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // Corrupt the materialized cache directly (simulating a missed delta).
      await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.update({
          where: { id: account.id },
          data: { balance: 999999n },
        })
      )

      const result = await rebuildAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(result.changed).toBe(true)
      expect(result.previousBalance).toBe("999999")
      expect(result.rebuiltBalance).toBe("150000")

      const row = await accountRow(owner.family.id, account.id)
      expect(row.balance).toBe(150000n)

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.count({
          where: {
            entityType: "Account",
            entityId: account.id,
            action: "update",
          },
        })
      )
      expect(audits).toBe(1)
    })

    test("tracked account rebuild restores balance to the latest valuation", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Gold",
          accountType: "TRACKED_ASSET",
          accountSubtype: "collectible",
          openingBalance: "100000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await createValuationForFamily({
        data: {
          accountId: account.id,
          value: "130000000",
          type: "market",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.update({ where: { id: account.id }, data: { balance: 1n } })
      )

      const result = await rebuildAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(result.rebuiltBalance).toBe("130000000")
    })

    test("family batch rebuild covers every account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const a = await createAccountForFamily({
        data: {
          name: "A",
          accountType: "DEPOSITORY",
          openingBalance: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      const b = await createAccountForFamily({
        data: {
          name: "B",
          accountType: "E_WALLET",
          openingBalance: "2000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await harness.withFamily(owner.family.id, async (tx) => {
        await tx.account.update({ where: { id: a.id }, data: { balance: 0n } })
        await tx.account.update({ where: { id: b.id }, data: { balance: 0n } })
      })

      const results = await rebuildFamilyBalances({
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(results.filter((r) => r.changed)).toHaveLength(2)
    })
  })

  // --------------------------------------------------------------------------
  // Drift detector (read-only)
  // --------------------------------------------------------------------------
  describe("detectBalanceDriftForFamily", () => {
    test("reports no drift for a clean family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const report = await detectBalanceDriftForFamily({
        familyId: owner.family.id,
      })
      expect(report).toHaveLength(0)
    })

    test("flags materialization drift as an error without mutating anything", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.update({
          where: { id: account.id },
          data: { balance: 100000n },
        })
      )

      const report = await detectBalanceDriftForFamily({
        familyId: owner.family.id,
      })
      const entry = report.find(
        (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
      )
      expect(entry).toBeDefined()
      expect(entry?.severity).toBe("error")
      expect(entry?.drift).toBe("50000") // expected 150000 - actual 100000

      // Read-only: the balance is still wrong after detection.
      const row = await accountRow(owner.family.id, account.id)
      expect(row.balance).toBe(100000n)
    })

    test("flags cash reconciliation drift as a warning, cleared by a balance_adjustment", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "100000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // Real-world statement says 120,000; transaction-derived balance is 100,000.
      await createValuationForFamily({
        data: {
          accountId: account.id,
          value: "120000",
          type: "reconciliation",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const before = await detectBalanceDriftForFamily({
        familyId: owner.family.id,
      })
      const recon = before.find(
        (r) => r.accountId === account.id && r.kind === "RECONCILIATION"
      )
      expect(recon).toBeDefined()
      expect(recon?.severity).toBe("warning")
      expect(recon?.drift).toBe("20000") // expected 120000 - computed 100000

      // The correction stays in the ledger as an explicit adjustment transaction.
      await createTransactionForFamily({
        data: {
          type: "income",
          kind: "balance_adjustment",
          amount: "20000",
          description: "Reconciliation adjustment",
          accountId: account.id,
          date: new Date(),
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const after = await detectBalanceDriftForFamily({
        familyId: owner.family.id,
      })
      expect(
        after.find(
          (r) => r.accountId === account.id && r.kind === "RECONCILIATION"
        )
      ).toBeUndefined()

      const row = await accountRow(owner.family.id, account.id)
      expect(row.balance).toBe(120000n)
    })

    test("is tenant-scoped: never reports another family's accounts", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await createAccountForFamily({
        data: {
          name: "Theirs",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
      await harness.withFamily(intruder.family.id, async (tx) =>
        tx.account.update({
          where: { id: intruderAccount.id },
          data: { balance: 0n },
        })
      )

      const report = await detectBalanceDriftForFamily({
        familyId: owner.family.id,
      })
      expect(report.some((r) => r.accountId === intruderAccount.id)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // current / available / held semantics
  // --------------------------------------------------------------------------
  describe("getAccountBalanceForFamily (current / available / held)", () => {
    test("cash: held = pending magnitude, available = current - held (unclamped)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await createTransactionForFamily({
        data: {
          type: "expense",
          amount: "40000",
          description: "Pending card hold",
          accountId: account.id,
          date: new Date(),
          status: "PENDING",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const view = await getAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
      })
      expect(view.current).toBe("110000") // pending expense already lowered balance
      expect(view.held).toBe("40000")
      expect(view.available).toBe("70000") // current - held
    })

    test("credit card: available = creditLimit - |current| - held", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Visa",
          accountType: "CREDIT",
          openingBalance: "200000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      // creditLimit is not part of F1's create contract; set it directly.
      await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.update({
          where: { id: account.id },
          data: { creditLimit: 1000000n },
        })
      )

      const view = await getAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
      })
      expect(view.current).toBe("-200000")
      // 1,000,000 - 200,000 drawn - 0 held
      expect(view.available).toBe("800000")
    })

    test("loan without a limit exposes available = null", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Mortgage",
          accountType: "LOAN",
          openingBalance: "5000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const view = await getAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
      })
      expect(view.available).toBeNull()
    })

    test("tracked asset: held = 0, available = current", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Gold",
          accountType: "TRACKED_ASSET",
          accountSubtype: "collectible",
          openingBalance: "100000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const view = await getAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
      })
      expect(view.held).toBe("0")
      expect(view.available).toBe("100000000")
    })
  })

  // --------------------------------------------------------------------------
  // Database is the law — constraint rejection
  // --------------------------------------------------------------------------
  describe("database constraints", () => {
    test("rejects a value whose sign contradicts normalBalance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "1",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      await expect(
        harness.withFamily(owner.family.id, async (tx) =>
          tx.valuation.create({
            data: {
              accountId: account.id,
              familyId: owner.family.id,
              value: -5n, // negative under a POSITIVE normal balance
              currency: "IDR",
              valuationDate: new Date(),
              type: "manual",
              normalBalance: "POSITIVE",
              createdById: owner.user.id,
            },
          })
        )
      ).rejects.toThrow()
    })

    test("rejects an out-of-domain valuation type", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "1",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      await expect(
        harness.withFamily(owner.family.id, async (tx) =>
          tx.valuation.create({
            data: {
              accountId: account.id,
              familyId: owner.family.id,
              value: 1n,
              currency: "IDR",
              valuationDate: new Date(),
              type: "bogus",
              normalBalance: "POSITIVE",
              createdById: owner.user.id,
            },
          })
        )
      ).rejects.toThrow()
    })

    test("rejects a second live opening valuation for the same account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY",
          openingBalance: "1",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      await expect(
        harness.withFamily(owner.family.id, async (tx) =>
          tx.valuation.create({
            data: {
              accountId: account.id,
              familyId: owner.family.id,
              value: 1n,
              currency: "IDR",
              valuationDate: new Date(),
              type: "opening",
              normalBalance: "POSITIVE",
              createdById: owner.user.id,
            },
          })
        )
      ).rejects.toThrow()
    })
  })
})
