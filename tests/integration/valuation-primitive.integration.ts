import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
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
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

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

  // ---- shared factories (kept here so the suite stays DRY) -------------------

  const makeAccount = async (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      accountSubtype?: string
      openingBalance?: string
    } = {}
  ) =>
    await createAccountForFamily({
      data: {
        name: overrides.name ?? "Checking",
        accountType: overrides.accountType ?? "DEPOSITORY",
        ...(overrides.accountSubtype
          ? { accountSubtype: overrides.accountSubtype }
          : {}),
        openingBalance: overrides.openingBalance ?? "150000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const makeCash = (
    owner: AuthenticatedOnboardedUser,
    openingBalance = "150000"
  ) => makeAccount(owner, { accountType: "DEPOSITORY", openingBalance })

  const makeTracked = (
    owner: AuthenticatedOnboardedUser,
    openingBalance = "100000000"
  ) =>
    makeAccount(owner, {
      name: "Gold",
      accountType: "TRACKED_ASSET",
      accountSubtype: "collectible",
      openingBalance,
    })

  const addValuation = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    value: string,
    type: "reconciliation" | "market" | "manual"
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value,
        type,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const setBalance = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    balance: bigint
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.update({ where: { id: accountId }, data: { balance } })
    )

  const openingValuation = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId, type: "opening", deletedAt: null },
      })
    )

  const accountRow = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  const updateAuditCount = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.count({
        where: { entityType: "Account", entityId: accountId, action: "update" },
      })
    )

  // --------------------------------------------------------------------------
  // Opening balance recorded as the first valuation inside account create
  // --------------------------------------------------------------------------
  describe("opening valuation on account create", () => {
    test("cash account create writes exactly one signed opening valuation", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      const opening = await openingValuation(owner, account.id)
      expect(opening).not.toBeNull()
      expect(opening?.value).toBe(150000n)
      expect(opening?.type).toBe("opening")
      expect(opening?.normalBalance).toBe("POSITIVE")
      expect(opening?.currency).toBe("IDR")
    })

    test("liability account opening valuation is signed non-positive", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeAccount(owner, {
        name: "Visa",
        accountType: "CREDIT",
        openingBalance: "500000",
      })

      const opening = await openingValuation(owner, account.id)
      expect(opening?.value).toBe(-500000n)
      expect(opening?.normalBalance).toBe("NEGATIVE")
    })

    test("tracked asset opening valuation drives its balance source", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner, "200000000")

      expect(account.balanceSource).toBe("valuation")
      const opening = await openingValuation(owner, account.id)
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
    test("tracked valuation re-materializes the account balance and audits both rows", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)

      const valuation = await addValuation(
        owner,
        account.id,
        "125000000",
        "market"
      )
      expect(valuation.value).toBe("125000000")
      expect(valuation.type).toBe("market")

      const row = await accountRow(owner, account.id)
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
      const account = await makeCash(owner, "150000")

      await addValuation(owner, account.id, "175000", "reconciliation")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(150000n) // unchanged
    })

    test("rejects a valuation whose currency differs from the account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)

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
      const account = await makeTracked(owner)

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
      const account = await makeTracked(owner)
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

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(140000000n) // applied exactly once

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.count({ where: { accountId: account.id, type: "market" } })
      )
      expect(count).toBe(1)
    })

    test("cannot create a valuation on another family's account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await makeTracked(intruder)

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

      const row = await accountRow(intruder, intruderAccount.id)
      expect(row.balance).toBe(100000000n) // untouched
    })
  })

  // --------------------------------------------------------------------------
  // Balance rebuild
  // --------------------------------------------------------------------------
  describe("rebuildAccountBalanceForFamily", () => {
    const rebuild = (owner: AuthenticatedOnboardedUser, accountId: string) =>
      rebuildAccountBalanceForFamily({
        accountId,
        familyId: owner.family.id,
        user: owner.user,
      })

    test("is a no-op when the materialized balance already matches the canonical rows", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
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
      const auditsBefore = await updateAuditCount(owner, account.id)

      const result = await rebuild(owner, account.id)
      expect(result.changed).toBe(false)
      expect(result.rebuiltBalance).toBe("100000")

      const auditsAfter = await updateAuditCount(owner, account.id)
      expect(auditsAfter).toBe(auditsBefore) // no-op rebuild writes no audit noise
    })

    test("repairs materialization drift for a cash account and audits the correction", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      // Corrupt the materialized cache directly (simulating a missed delta).
      await setBalance(owner, account.id, 999999n)
      const auditsBefore = await updateAuditCount(owner, account.id)

      const result = await rebuild(owner, account.id)
      expect(result.changed).toBe(true)
      expect(result.previousBalance).toBe("999999")
      expect(result.rebuiltBalance).toBe("150000")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(150000n)
      expect(await updateAuditCount(owner, account.id)).toBe(auditsBefore + 1)
    })

    test("tracked account rebuild restores balance to the latest valuation", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)
      await addValuation(owner, account.id, "130000000", "market")
      await setBalance(owner, account.id, 1n)

      const result = await rebuild(owner, account.id)
      expect(result.rebuiltBalance).toBe("130000000")
    })

    test("family batch rebuild covers every account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const a = await makeCash(owner, "1000")
      const b = await makeAccount(owner, {
        name: "B",
        accountType: "E_WALLET",
        openingBalance: "2000",
      })
      await setBalance(owner, a.id, 0n)
      await setBalance(owner, b.id, 0n)

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
    const detect = (owner: AuthenticatedOnboardedUser) =>
      detectBalanceDriftForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })

    test("reports no drift for a clean family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await makeCash(owner, "150000")

      expect(await detect(owner)).toHaveLength(0)
    })

    test("flags materialization drift as an error without mutating anything", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await setBalance(owner, account.id, 100000n)

      const report = await detect(owner)
      const entry = report.find(
        (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
      )
      expect(entry).toBeDefined()
      expect(entry?.severity).toBe("error")
      expect(entry?.drift).toBe("50000") // expected 150000 - actual 100000

      // Read-only: the balance is still wrong after detection.
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(100000n)
    })

    test("flags cash reconciliation drift as a warning, cleared by a balance_adjustment", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "100000")

      // Real-world statement says 120,000; transaction-derived balance is 100,000.
      await addValuation(owner, account.id, "120000", "reconciliation")

      const before = await detect(owner)
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

      const after = await detect(owner)
      expect(
        after.find(
          (r) => r.accountId === account.id && r.kind === "RECONCILIATION"
        )
      ).toBeUndefined()

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(120000n)
    })

    test("is tenant-scoped: never reports another family's accounts", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await makeCash(intruder, "150000")
      await setBalance(intruder, intruderAccount.id, 0n)

      const report = await detect(owner)
      expect(report.some((r) => r.accountId === intruderAccount.id)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // current / available / held semantics
  // --------------------------------------------------------------------------
  describe("getAccountBalanceForFamily (current / available / held)", () => {
    const view = (owner: AuthenticatedOnboardedUser, accountId: string) =>
      getAccountBalanceForFamily({
        accountId,
        familyId: owner.family.id,
        userId: owner.user.id,
      })

    test("cash: held = pending magnitude, available = current - held (unclamped)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
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

      const balance = await view(owner, account.id)
      expect(balance.current).toBe("110000") // pending expense already lowered balance
      expect(balance.held).toBe("40000")
      expect(balance.available).toBe("70000") // current - held
    })

    test("credit card: available = creditLimit - |current| - held", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeAccount(owner, {
        name: "Visa",
        accountType: "CREDIT",
        openingBalance: "200000",
      })
      // creditLimit is not part of F1's create contract; set it directly.
      await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.update({
          where: { id: account.id },
          data: { creditLimit: 1000000n },
        })
      )

      const balance = await view(owner, account.id)
      expect(balance.current).toBe("-200000")
      // 1,000,000 - 200,000 drawn - 0 held
      expect(balance.available).toBe("800000")
    })

    test("loan without a limit exposes available = null", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeAccount(owner, {
        name: "Mortgage",
        accountType: "LOAN",
        openingBalance: "5000000",
      })

      const balance = await view(owner, account.id)
      expect(balance.available).toBeNull()
    })

    test("tracked asset: held = 0, available = current", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner, "100000000")

      const balance = await view(owner, account.id)
      expect(balance.held).toBe("0")
      expect(balance.available).toBe("100000000")
    })
  })

  // --------------------------------------------------------------------------
  // Database is the law — constraint rejection
  // --------------------------------------------------------------------------
  describe("database constraints", () => {
    // Attempt a raw insert that violates a CHECK / unique index, expecting the
    // database to reject it regardless of app-layer guards.
    const rawInsert = (
      owner: AuthenticatedOnboardedUser,
      accountId: string,
      data: { value: bigint; type: string; normalBalance: string }
    ) =>
      harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.create({
          data: {
            accountId,
            familyId: owner.family.id,
            currency: "IDR",
            valuationDate: new Date(),
            createdById: owner.user.id,
            ...data,
          },
        })
      )

    test("rejects a value whose sign contradicts normalBalance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: -5n, // negative under a POSITIVE normal balance
          type: "manual",
          normalBalance: "POSITIVE",
        })
      ).rejects.toThrow()
    })

    test("rejects an out-of-domain valuation type", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "bogus",
          normalBalance: "POSITIVE",
        })
      ).rejects.toThrow()
    })

    test("rejects a second live opening valuation for the same account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "opening",
          normalBalance: "POSITIVE",
        })
      ).rejects.toThrow()
    })
  })
})
