import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import {
  AccountNotFoundError,
  AccountValidationError,
  createAccountForFamily,
  enableHoldingsTrackingForFamily,
} from "@/server/accounts"
import { upsertHoldingForFamily } from "@/server/holdings"
import { computeCanonicalBalance, fetchAccountFacts } from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// =============================================================================
// PER-239 / ADR-0051 — opt-in holdings tracking for INVESTMENT accounts.
//
// Genuine INVESTMENT accounts default to balanceSource="transaction_flow" and
// so cannot record holdings. `enableHoldingsTrackingForFamily` flips a
// qualifying INVESTMENT account to "valuation" and seeds a balance-preserving
// reconciliation anchor in the SAME transaction. These real-PG tests prove the
// safe-seed-anchor invariant (no data loss), idempotent replay, the eligibility
// rejections, tenant isolation, and that the holdings layer then works
// unchanged (enable → add holding → balance == Σ holdings).
// =============================================================================

describe("enable holdings tracking (PER-239 / ADR-0051 — opt-in valuation)", () => {
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

  // A genuine INVESTMENT account (accountType="INVESTMENT" →
  // balanceSource="transaction_flow"), the exact case this slice unblocks.
  const makeInvestmentAccount = async (
    owner: AuthenticatedOnboardedUser,
    options: { openingBalance?: string; reserveBalance?: string } = {}
  ) =>
    await createAccountForFamily({
      data: {
        name: "Bibit",
        accountType: "INVESTMENT" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: options.openingBalance ?? "5000000",
        ...(options.reserveBalance
          ? { reserveBalance: options.reserveBalance }
          : {}),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const accountRow = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  const canonicalBalance = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const facts = await fetchAccountFacts(tx, owner.family.id, accountId)
      if (!facts) throw new Error("account not found")
      return await computeCanonicalBalance(tx, owner.family.id, facts)
    })

  const reconciliationAnchors = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.valuation.findMany({
        where: { accountId, type: "reconciliation" },
        orderBy: { createdAt: "asc" },
      })
    )

  // --------------------------------------------------------------------------
  // Happy path — safe-seed-anchor invariant (no data loss on flip)
  // --------------------------------------------------------------------------
  describe("enable happy path", () => {
    test("flips balanceSource to valuation and preserves the balance as an anchor", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner, {
        openingBalance: "5000000",
      })
      expect(account.balanceSource).toBe("transaction_flow")

      const result = await enableHoldingsTrackingForFamily({
        data: {
          accountId: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(result.balanceSource).toBe("valuation")
      // Balance is unchanged by the flip (safe-seed-anchor invariant).
      expect(result.balance).toBe("5000000")

      const row = await accountRow(owner, account.id)
      expect(row.balanceSource).toBe("valuation")
      expect(row.balance).toBe(5000000n)

      // computeCanonicalBalance resolves to the OLD balance — zero data loss.
      expect(await canonicalBalance(owner, account.id)).toBe(5000000n)

      // Exactly one reconciliation anchor was seeded, equal to the old balance.
      const anchors = await reconciliationAnchors(owner, account.id)
      expect(anchors).toHaveLength(1)
      expect(anchors[0]?.value).toBe(5000000n)
      expect(anchors[0]?.source).toBe("manual")
    })
  })

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------
  describe("idempotency", () => {
    test("replaying the same key writes no second anchor and does not move the balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner, {
        openingBalance: "5000000",
      })
      const key = factories.createIdempotencyKey()

      const first = await enableHoldingsTrackingForFamily({
        data: { accountId: account.id, idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      })
      const second = await enableHoldingsTrackingForFamily({
        data: { accountId: account.id, idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(second).toEqual(first)

      const anchors = await reconciliationAnchors(owner, account.id)
      expect(anchors).toHaveLength(1)

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(5000000n)
    })
  })

  // --------------------------------------------------------------------------
  // Eligibility rejections
  // --------------------------------------------------------------------------
  describe("eligibility rejections", () => {
    test("rejects a non-INVESTMENT (cash) account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const cash = await createAccountForFamily({
        data: {
          name: "Checking",
          accountType: "DEPOSITORY" as AccountType,
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      await expect(
        enableHoldingsTrackingForFamily({
          data: {
            accountId: cash.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(AccountValidationError)

      // The account was not mutated.
      const row = await accountRow(owner, cash.id)
      expect(row.balanceSource).toBe("transaction_flow")
    })

    test("rejects an INVESTMENT account that has a reserve balance set", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner, {
        openingBalance: "5000000",
        reserveBalance: "100000",
      })
      expect(account.reserveBalance).toBe("100000")

      await expect(
        enableHoldingsTrackingForFamily({
          data: {
            accountId: account.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(AccountValidationError)

      const row = await accountRow(owner, account.id)
      expect(row.balanceSource).toBe("transaction_flow")
    })

    test("rejects an already valuation-tracked (TRACKED_ASSET) account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const tracked = await createAccountForFamily({
        data: {
          name: "House",
          accountType: "TRACKED_ASSET" as AccountType,
          accountSubtype: "real_estate",
          openingBalance: "9000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(tracked.balanceSource).toBe("valuation")

      await expect(
        enableHoldingsTrackingForFamily({
          data: {
            accountId: tracked.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(AccountValidationError)
    })
  })

  // --------------------------------------------------------------------------
  // Tenant isolation
  // --------------------------------------------------------------------------
  describe("tenant isolation", () => {
    test("another family cannot enable tracking on this family's account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner, {
        openingBalance: "5000000",
      })

      await expect(
        enableHoldingsTrackingForFamily({
          data: {
            accountId: account.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: intruder.family.id,
          user: intruder.user,
        })
      ).rejects.toBeInstanceOf(AccountNotFoundError)

      // The owner's account is untouched.
      const row = await accountRow(owner, account.id)
      expect(row.balanceSource).toBe("transaction_flow")
    })
  })

  // --------------------------------------------------------------------------
  // Holdings layer works unchanged once enabled
  // --------------------------------------------------------------------------
  describe("holdings after enable", () => {
    test("enable → add holding → balance equals Σ holdings", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner, {
        openingBalance: "5000000",
      })

      await enableHoldingsTrackingForFamily({
        data: {
          accountId: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // 10 units × Rp 1,000 = Rp 10,000 (1_000_000 sen).
      const holding = await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "mutual_fund", name: "Fund A" },
          quantity: "10",
          avgUnitCost: "1000",
          lastPrice: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(holding.valueMinor).toBe("1000000")

      // The holdings-derived anchor supersedes the seed: balance == Σ holdings.
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(1000000n)
    })
  })
})
