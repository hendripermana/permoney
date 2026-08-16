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
  getAccountHoldingsForFamily,
  HoldingError,
  recordSwitchForFamily,
  recordTradeForFamily,
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

// PER-259 Slice 4 / ADR-0054 — Switch (atomic sell-A + buy-B, ONE holdings
// account, NO external cash). Broker/country-agnostic (Bibit "pindah/switch",
// Vanguard/Fidelity "exchange"). Amounts are in MINOR units (IDR sen). Fixtures
// use exact-division quantities/prices so conservation is provable to the sen —
// the account's Σ-holdings value must move by EXACTLY the realized gain, since
// neither side carries a separate "current market price" beyond average cost.

describe("switch (PER-259 Slice 4 / ADR-0054)", () => {
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

  const makeInvestmentAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Reksadana"
  ) =>
    await createAccountForFamily({
      data: {
        name,
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const makeCashAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Checking",
    openingBalance = "2000000"
  ) =>
    await createAccountForFamily({
      data: {
        name,
        accountType: "DEPOSITORY" as AccountType,
        openingBalance,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const balanceOf = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const row = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { balance: true },
      })
      return row.balance
    })

  // Buys `quantity` units of `instrument` @ `unitPrice` in `investmentId`,
  // funded from `fundingId`. Returns the resulting holding + instrument id.
  const seedPosition = async (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    fundingId: string,
    instrument: { kind: "mutual_fund"; name: string },
    quantity: string,
    unitPrice: string
  ) => {
    const cashAmount = (BigInt(quantity) * BigInt(unitPrice)).toString()
    const buy = await recordTradeForFamily({
      data: {
        investmentAccountId: investmentId,
        fundingAccountId: fundingId,
        instrument,
        side: "buy",
        cashAmount,
        quantity,
        unitPrice,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    return {
      instrumentId: buy.holding?.instrumentId ?? "",
      holdingId: buy.holding?.id ?? "",
    }
  }

  const fundA = { kind: "mutual_fund" as const, name: "BNI-AM Dana Ardhani" }
  const fundB = {
    kind: "mutual_fund" as const,
    name: "Sucorinvest Money Market",
  }

  // --------------------------------------------------------------------------
  // Partial switch A -> existing B: average-cost blends on B; A keeps its
  // (unchanged) average cost on the remaining units; the account's total value
  // moves by EXACTLY the realized gain (proven to the sen).
  // --------------------------------------------------------------------------
  test("partial switch into an existing holding blends average cost; account value moves only by the realized gain", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )
    const b = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundB,
      "50",
      "8000"
    )

    const investBefore = await balanceOf(owner, investment.id) // 1,000,000 + 400,000 = 1,400,000
    expect(investBefore).toBe(1_400_000n)

    const key = factories.createIdempotencyKey()
    const result = await recordSwitchForFamily({
      data: {
        investmentAccountId: investment.id,
        fromHoldingId: a.holdingId,
        toInstrumentId: b.instrumentId,
        quantity: "40",
        fromUnitPrice: "12000", // A appreciated from its 10,000 avg cost
        toUnitPrice: "8000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Proceeds = 40 x 12,000 = 480,000. Cost removed = 40 x 10,000 = 400,000.
    // Realized gain = 80,000.
    expect(result.proceedsMinor).toBe("480000")
    expect(result.fromCostRemovedMinor).toBe("400000")
    expect(result.realizedGainMinor).toBe("80000")
    expect(result.fromQuantity).toBe("40.00000000")

    // A: 60 units remain, average cost UNCHANGED at 10,000/unit.
    expect(result.fromHolding).not.toBeNull()
    expect(result.fromHolding?.quantity).toBe("60.00000000")
    expect(result.fromHolding?.avgUnitCostMinor).toBe("10000")

    // B: 50 + 60 = 110 units; blended avg cost = (400,000 + 480,000) / 110 =
    // 8,000/unit exactly.
    expect(result.toQuantity).toBe("60.00000000")
    expect(result.toCostAddedMinor).toBe("480000")
    expect(result.toHolding.quantity).toBe("110.00000000")
    expect(result.toHolding.avgUnitCostMinor).toBe("8000")

    // Account total value: A (60 x 10,000 = 600,000) + B (110 x 8,000 =
    // 880,000) = 1,480,000 -- exactly investBefore + the realized gain.
    const investAfter = await balanceOf(owner, investment.id)
    expect(investAfter).toBe(1_480_000n)
    expect(investAfter - investBefore).toBe(80_000n)
    expect(result.investmentValueAfterMinor).toBe(investAfter.toString())

    // Provenance audit row links both sides + proceeds + realized gain.
    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, idempotencyKey: key },
        select: { entityType: true, afterJson: true },
      })
    )
    const provenance = audit.find((r) => r.entityType === "Switch")
    expect(provenance).toBeDefined()
    const after = provenance?.afterJson as Record<string, unknown> | null
    expect(after?.fromHoldingId).toBe(a.holdingId)
    expect(after?.toInstrumentId).toBe(b.instrumentId)
    expect(after?.proceedsMinor).toBe("480000")
    expect(after?.realizedGainMinor).toBe("80000")

    // Only holdings mutate — no Transaction/cash leg is posted by a switch.
    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(2)
  })

  // --------------------------------------------------------------------------
  // Switch-all into a brand-new instrument: closes (deletes) A's position and
  // creates B inline, like a first Buy.
  // --------------------------------------------------------------------------
  test("switching ALL of A into a new inline fund closes A's position and creates B", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    const result = await recordSwitchForFamily({
      data: {
        investmentAccountId: investment.id,
        fromHoldingId: a.holdingId,
        toInstrument: fundB,
        quantity: "100", // switch ALL of A
        fromUnitPrice: "10500",
        toUnitPrice: "1000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Proceeds = 100 x 10,500 = 1,050,000. Cost removed = 1,000,000. Realized
    // gain = 50,000.
    expect(result.proceedsMinor).toBe("1050000")
    expect(result.realizedGainMinor).toBe("50000")

    // A closed — no remaining holding.
    expect(result.fromHolding).toBeNull()

    // B created inline: 1,050,000 / 1,000 = 1,050 units @ avg cost 1,000/unit.
    expect(result.toHolding.instrument.name).toBe(fundB.name)
    expect(result.toHolding.quantity).toBe("1050.00000000")
    expect(result.toHolding.avgUnitCostMinor).toBe("1000")

    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(1)
    expect(view.holdings[0]?.instrument.name).toBe(fundB.name)

    const remainingA = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findFirst({ where: { id: a.holdingId } })
    )
    expect(remainingA).toBeNull()
  })

  // --------------------------------------------------------------------------
  // Quantity-based and amount-based switches are equivalent when the amount
  // equals the quantity-derived proceeds exactly.
  // --------------------------------------------------------------------------
  test("a quantity-based switch and an equivalent amount-based switch produce the same result", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner, "Checking", "10000000")

    const investmentQty = await makeInvestmentAccount(owner, "By quantity")
    const aQty = await seedPosition(
      owner,
      investmentQty.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )
    const bQty = await seedPosition(
      owner,
      investmentQty.id,
      cash.id,
      fundB,
      "50",
      "8000"
    )
    const byQuantity = await recordSwitchForFamily({
      data: {
        investmentAccountId: investmentQty.id,
        fromHoldingId: aQty.holdingId,
        toInstrumentId: bQty.instrumentId,
        quantity: "40",
        fromUnitPrice: "12000",
        toUnitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const investmentAmt = await makeInvestmentAccount(owner, "By amount")
    const aAmt = await seedPosition(
      owner,
      investmentAmt.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )
    const bAmt = await seedPosition(
      owner,
      investmentAmt.id,
      cash.id,
      fundB,
      "50",
      "8000"
    )
    const byAmount = await recordSwitchForFamily({
      data: {
        investmentAccountId: investmentAmt.id,
        fromHoldingId: aAmt.holdingId,
        toInstrumentId: bAmt.instrumentId,
        // Exactly the proceeds the quantity-based switch derived (40 x 12,000).
        amount: "480000",
        fromUnitPrice: "12000",
        toUnitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(byAmount.fromQuantity).toBe(byQuantity.fromQuantity)
    expect(byAmount.proceedsMinor).toBe(byQuantity.proceedsMinor)
    expect(byAmount.realizedGainMinor).toBe(byQuantity.realizedGainMinor)
    expect(byAmount.toQuantity).toBe(byQuantity.toQuantity)
    expect(byAmount.toHolding.avgUnitCostMinor).toBe(
      byQuantity.toHolding.avgUnitCostMinor
    )
    expect(byAmount.fromHolding?.quantity).toBe(
      byQuantity.fromHolding?.quantity
    )
  })

  // --------------------------------------------------------------------------
  // Guard rejections
  // --------------------------------------------------------------------------
  test("rejects switching into the SAME instrument (A === B)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordSwitchForFamily({
        data: {
          investmentAccountId: investment.id,
          fromHoldingId: a.holdingId,
          toInstrumentId: a.instrumentId,
          quantity: "10",
          fromUnitPrice: "10000",
          toUnitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("rejects switching more units than held", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordSwitchForFamily({
        data: {
          investmentAccountId: investment.id,
          fromHoldingId: a.holdingId,
          toInstrument: fundB,
          quantity: "150", // only 100 held
          fromUnitPrice: "10000",
          toUnitPrice: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    // A untouched by the rejected attempt.
    const stillA = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: a.holdingId } })
    )
    expect(stillA.quantity.toFixed(8)).toBe("100.00000000")
  })

  test("rejects a non-holdings account (balanceSource != valuation)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordSwitchForFamily({
        data: {
          // A cash-like (transaction_flow) account is not a holdings account.
          investmentAccountId: cash.id,
          fromHoldingId: a.holdingId,
          toInstrument: fundB,
          quantity: "10",
          fromUnitPrice: "10000",
          toUnitPrice: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("a switch referencing another family's holding/account is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordSwitchForFamily({
        data: {
          investmentAccountId: investment.id,
          fromHoldingId: a.holdingId,
          toInstrument: fundB,
          quantity: "10",
          fromUnitPrice: "10000",
          toUnitPrice: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    // The owner's position is untouched by the rejected cross-tenant attempt.
    const stillA = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: a.holdingId } })
    )
    expect(stillA.quantity.toFixed(8)).toBe("100.00000000")
  })

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------
  test("replaying the same key returns the same result and does not double-mutate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )
    const b = await seedPosition(
      owner,
      investment.id,
      cash.id,
      fundB,
      "50",
      "8000"
    )

    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        investmentAccountId: investment.id,
        fromHoldingId: a.holdingId,
        toInstrumentId: b.instrumentId,
        quantity: "40",
        fromUnitPrice: "12000",
        toUnitPrice: "8000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await recordSwitchForFamily(payload)
    const second = await recordSwitchForFamily(payload)
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value))
    expect(normalize(second)).toEqual(normalize(first))

    // Applied exactly once: A at 60 (not 20), B at 110 (not 170).
    const finalA = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: a.holdingId } })
    )
    expect(finalA.quantity.toFixed(8)).toBe("60.00000000")
    const finalB = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: b.holdingId } })
    )
    expect(finalB.quantity.toFixed(8)).toBe("110.00000000")

    const investAfter = await balanceOf(owner, investment.id)
    expect(investAfter).toBe(1_480_000n)

    // Exactly one Switch provenance audit row for this key (replay short-
    // circuits before the second write, never appending a duplicate).
    const count = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.count({
        where: {
          familyId: owner.family.id,
          idempotencyKey: key,
          entityType: "Switch",
        },
      })
    )
    expect(count).toBe(1)
  })
})
