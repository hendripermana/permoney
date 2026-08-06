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
import {
  deleteHoldingForFamily,
  getAccountHoldingsForFamily,
  HoldingError,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

describe("holdings core (PER-232 / ADR-0051 — Instrument + Holding + value=Σ holdings)", () => {
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

  // ---- shared factories -----------------------------------------------------

  // A valuation-tracked investment account (TRACKED_ASSET → balanceSource
  // "valuation"), the only kind holdings may attach to this slice.
  const makeInvestmentAccount = async (
    owner: AuthenticatedOnboardedUser,
    openingBalance = "0"
  ) =>
    await createAccountForFamily({
      data: {
        name: "Bibit",
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const makeCashAccount = async (owner: AuthenticatedOnboardedUser) =>
    await createAccountForFamily({
      data: {
        name: "Checking",
        accountType: "DEPOSITORY" as AccountType,
        openingBalance: "150000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Add a fresh gold holding (2.0180 gram, avg Rp 2,760,809/gram, last
  // Rp 2,455,000/gram). Amounts are MAJOR units; the server parses to minor.
  const addGoldHolding = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    overrides: {
      quantity?: string
      avgUnitCost?: string
      lastPrice?: string
    } = {}
  ) =>
    upsertHoldingForFamily({
      data: {
        accountId,
        instrument: {
          kind: "metal",
          name: "BSI Gold",
          symbol: "XAU",
        },
        quantity: overrides.quantity ?? "2.0180",
        avgUnitCost: overrides.avgUnitCost ?? "2760809",
        lastPrice: overrides.lastPrice ?? "2455000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const accountRow = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  // --------------------------------------------------------------------------
  // Create + value = Σ holdings
  // --------------------------------------------------------------------------
  describe("create holding + account value anchor", () => {
    test("creates a holding with an inline instrument and computes value/cost/gain", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)

      const holding = await addGoldHolding(owner, account.id)

      // 2.0180 × Rp 2,455,000 = Rp 4,954,190 (495_419_000 sen).
      expect(holding.valueMinor).toBe("495419000")
      // 2.0180 × Rp 2,760,809 = Rp 5,571,312.56 → 557_131_256 sen.
      expect(holding.costMinor).toBe("557131256")
      expect(holding.gainMinor).toBe("-61712256")
      expect(holding.currency).toBe("IDR")
      expect(holding.instrument.kind).toBe("metal")
      expect(holding.instrument.priceModel).toBe("market")
      expect(holding.quantity).toBe("2.01800000")
    })

    test("accepts locale-formatted IDR amounts (thousands '.' + decimal ',')", async () => {
      // The real bug: a user pastes the BSI-app figures "2.760.809,32" /
      // "2.520.000,00" (Indonesian formatting) — parseUserInput must handle them,
      // not toMinorUnits (which only takes a canonical decimal).
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)

      const holding = await addGoldHolding(owner, account.id, {
        quantity: "2.0180",
        avgUnitCost: "2.760.809,32",
        lastPrice: "2.520.000,00",
      })

      // 2.0180 × Rp 2,520,000.00 = Rp 5,085,360.00 → 508_536_000 sen.
      expect(holding.valueMinor).toBe("508536000")
      // 2.0180 × Rp 2,760,809.32 = Rp 5,571,313.207… → half-up 557_131_321 sen.
      expect(holding.costMinor).toBe("557131321")
      expect(holding.gainMinor).toBe("-48595321")
    })

    test("account balance materializes to Σ holding values via a valuation anchor", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)

      await addGoldHolding(owner, account.id)
      // Add a second holding: 10 units × Rp 1,000 = Rp 10,000 (1_000_000 sen).
      await upsertHoldingForFamily({
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

      const view = await getAccountHoldingsForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(view.holdings).toHaveLength(2)
      expect(view.totalValueMinor).toBe("496419000") // 495_419_000 + 1_000_000

      // The account balance equals Σ holding values (holdings-derived anchor).
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(496419000n)

      // The anchor was written as a "manual" valuation sourced from holdings.
      const anchor = await harness.withFamily(owner.family.id, (tx) =>
        tx.valuation.findFirst({
          where: { accountId: account.id, source: "holdings" },
          orderBy: { createdAt: "desc" },
        })
      )
      expect(anchor?.value).toBe(496419000n)
      expect(anchor?.type).toBe("manual")
    })

    test("a holding with no lastPrice values at cost basis (honest, gain 0)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)

      const holding = await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "stock", name: "No Price Co", symbol: "NPC" },
          quantity: "3",
          avgUnitCost: "5000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(holding.lastPriceMinor).toBeNull()
      expect(holding.valueMinor).toBe(holding.costMinor) // value == cost
      expect(holding.gainMinor).toBe("0")
      expect(holding.returnPct).toBe(0)
    })
  })

  // --------------------------------------------------------------------------
  // Update + delete recompute the anchor
  // --------------------------------------------------------------------------
  describe("update + delete recompute the account value", () => {
    test("updating quantity and price recomputes value and balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const holding = await addGoldHolding(owner, account.id)

      const updated = await upsertHoldingForFamily({
        data: {
          holdingId: holding.id,
          accountId: account.id,
          quantity: "4",
          avgUnitCost: "2760809",
          lastPrice: "2500000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      // 4 × Rp 2,500,000 = Rp 10,000,000 (1_000_000_000 sen).
      expect(updated.valueMinor).toBe("1000000000")
      expect(updated.quantity).toBe("4.00000000")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(1000000000n)
    })

    test("deleting a holding removes it and recomputes the balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const gold = await addGoldHolding(owner, account.id)
      const fund = await upsertHoldingForFamily({
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

      const result = await deleteHoldingForFamily({
        data: {
          holdingId: fund.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(result.deleted).toBe(true)
      expect(result.accountId).toBe(account.id)

      const view = await getAccountHoldingsForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(view.holdings).toHaveLength(1)
      expect(view.holdings[0]?.id).toBe(gold.id)
      expect(view.totalValueMinor).toBe("495419000")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(495419000n)
    })
  })

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------
  describe("idempotency", () => {
    test("replaying the same upsert key returns the same holding and writes once", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const key = factories.createIdempotencyKey()
      const payload = {
        data: {
          accountId: account.id,
          instrument: { kind: "metal" as const, name: "BSI Gold" },
          quantity: "2.0180",
          avgUnitCost: "2760809",
          lastPrice: "2455000",
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        user: owner.user,
      }

      const first = await upsertHoldingForFamily(payload)
      const second = await upsertHoldingForFamily(payload)
      expect(second.id).toBe(first.id)

      const count = await harness.withFamily(owner.family.id, (tx) =>
        tx.holding.count({ where: { accountId: account.id } })
      )
      expect(count).toBe(1)

      const balance = (await accountRow(owner, account.id)).balance
      expect(balance).toBe(495419000n) // applied exactly once
    })

    test("replaying the same delete key is a single no-op", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const holding = await addGoldHolding(owner, account.id)
      const key = factories.createIdempotencyKey()

      const first = await deleteHoldingForFamily({
        data: { holdingId: holding.id, idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      })
      const second = await deleteHoldingForFamily({
        data: { holdingId: holding.id, idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(second).toEqual(first)

      const count = await harness.withFamily(owner.family.id, (tx) =>
        tx.holding.count({ where: { accountId: account.id } })
      )
      expect(count).toBe(0)
    })
  })

  // --------------------------------------------------------------------------
  // Eligibility + rejections
  // --------------------------------------------------------------------------
  describe("account eligibility", () => {
    test("rejects adding a holding to a cash (transaction_flow) account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const cash = await makeCashAccount(owner)

      await expect(
        upsertHoldingForFamily({
          data: {
            accountId: cash.id,
            instrument: { kind: "metal", name: "Gold" },
            quantity: "1",
            avgUnitCost: "1000",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(HoldingError)
    })

    test("rejects an instrument whose currency differs from the account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner) // IDR

      await expect(
        upsertHoldingForFamily({
          data: {
            accountId: account.id,
            instrument: {
              kind: "stock",
              name: "US Stock",
              quoteCurrency: "USD",
            },
            quantity: "1",
            avgUnitCost: "100",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(HoldingError)
    })
  })

  // --------------------------------------------------------------------------
  // Tenant isolation
  // --------------------------------------------------------------------------
  describe("tenant isolation", () => {
    test("another family cannot read this family's holdings", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      await addGoldHolding(owner, account.id)

      // Intruder queries the owner's account id under their own family scope.
      await expect(
        getAccountHoldingsForFamily({
          accountId: account.id,
          familyId: intruder.family.id,
          userId: intruder.user.id,
        })
      ).rejects.toBeInstanceOf(HoldingError)
    })

    test("another family cannot upsert onto this family's account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)

      await expect(
        upsertHoldingForFamily({
          data: {
            accountId: account.id,
            instrument: { kind: "metal", name: "Gold" },
            quantity: "1",
            avgUnitCost: "1000",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: intruder.family.id,
          user: intruder.user,
        })
      ).rejects.toThrow()

      const count = await harness.withFamily(owner.family.id, (tx) =>
        tx.holding.count({ where: { accountId: account.id } })
      )
      expect(count).toBe(0)
    })

    test("another family cannot delete this family's holding", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const holding = await addGoldHolding(owner, account.id)

      // Under the intruder's scope the holding is invisible → treated as a
      // no-op (gone) delete, so the owner's holding must survive.
      await deleteHoldingForFamily({
        data: {
          holdingId: holding.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })

      const count = await harness.withFamily(owner.family.id, (tx) =>
        tx.holding.count({ where: { id: holding.id } })
      )
      expect(count).toBe(1)
    })
  })

  // --------------------------------------------------------------------------
  // Database is the law — constraint rejection (raw writes)
  // --------------------------------------------------------------------------
  describe("database constraints", () => {
    test("rejects a negative quantity at the DB CHECK", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const instrument = await harness.withFamily(owner.family.id, (tx) =>
        tx.instrument.create({
          data: {
            familyId: owner.family.id,
            kind: "metal",
            name: "Gold",
            quoteCurrency: "IDR",
            priceModel: "market",
          },
        })
      )

      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.holding.create({
            data: {
              familyId: owner.family.id,
              accountId: account.id,
              instrumentId: instrument.id,
              quantity: "-1",
              avgUnitCostMinor: 1000n,
            },
          })
        )
      ).rejects.toThrow()
    })

    test("rejects an out-of-domain instrument kind at the DB CHECK", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.instrument.create({
            data: {
              familyId: owner.family.id,
              kind: "bogus",
              name: "Nope",
              quoteCurrency: "IDR",
              priceModel: "market",
            },
          })
        )
      ).rejects.toThrow()
    })
  })
})
