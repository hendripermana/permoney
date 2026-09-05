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
  recordPositionMoveForFamily,
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

// PER-259 Slice 6 / ADR-0054 item 13 — in-kind position move (no sale). The
// holding (units + cost basis) leaves the source account and lands, whole, in
// the destination account; both accounts' Σ-holdings anchors re-materialize.
// NO cash leg, NO realized gain — cost basis carries over EXACTLY, provable to
// the sen. v1 scope: whole-position move only, same-currency accounts only.

describe("in-kind position move (PER-259 Slice 6 / ADR-0054)", () => {
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
    name = "Reksadana",
    currencyOverride?: string
  ) =>
    await createAccountForFamily({
      data: {
        name,
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        ...(currencyOverride ? { currency: currencyOverride } : {}),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const makeCashAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Checking",
    openingBalance = "5000000"
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

  // Buys `quantity` units @ `unitPrice` in `investmentId`, funded from
  // `fundingId`. `instrument` creates a brand-new Instrument row inline;
  // pass an existing `instrumentId` instead to buy a SECOND position in the
  // SAME instrument (e.g. seeding an existing destination holding to move
  // into) — an inline `instrument` object is never deduplicated by name, so
  // reusing the literal fundA/fundB constant across two calls would silently
  // create two distinct instruments.
  const seedPosition = async (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    fundingId: string,
    instrument:
      | { kind: "mutual_fund"; name: string }
      | { instrumentId: string },
    quantity: string,
    unitPrice: string
  ) => {
    const cashAmount = (BigInt(quantity) * BigInt(unitPrice)).toString()
    const buy = await recordTradeForFamily({
      data: {
        investmentAccountId: investmentId,
        fundingAccountId: fundingId,
        ...("instrumentId" in instrument
          ? { instrumentId: instrument.instrumentId }
          : { instrument }),
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

  // --------------------------------------------------------------------------
  // Move into a fresh account: closes the source, creates the destination with
  // the EXACT same quantity + average cost — no realized gain anywhere.
  // --------------------------------------------------------------------------
  test("moves a whole position into a fresh account with cost basis carried over exactly", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner, "Old broker")
    const dest = await makeInvestmentAccount(owner, "New broker")
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    const sourceBefore = await balanceOf(owner, source.id) // 100 x 10,000
    expect(sourceBefore).toBe(1_000_000n)
    const destBefore = await balanceOf(owner, dest.id)
    expect(destBefore).toBe(0n)

    const key = factories.createIdempotencyKey()
    const result = await recordPositionMoveForFamily({
      data: {
        fromHoldingId: a.holdingId,
        toAccountId: dest.id,
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.fromHolding).toBeNull()
    expect(result.movedQuantity).toBe("100.00000000")
    expect(result.movedCostMinor).toBe("1000000")
    expect(result.toHolding.quantity).toBe("100.00000000")
    expect(result.toHolding.avgUnitCostMinor).toBe("10000")
    expect(result.toHolding.instrument.name).toBe(fundA.name)

    // Source closes to zero; destination gains EXACTLY what source lost — no
    // gain or loss materializes anywhere.
    const sourceAfter = await balanceOf(owner, source.id)
    expect(sourceAfter).toBe(0n)
    const destAfter = await balanceOf(owner, dest.id)
    expect(destAfter).toBe(1_000_000n)
    expect(result.fromAccountValueAfterMinor).toBe(sourceAfter.toString())
    expect(result.toAccountValueAfterMinor).toBe(destAfter.toString())

    const stillSourceHolding = await harness.withFamily(
      owner.family.id,
      async (tx) => tx.holding.findFirst({ where: { id: a.holdingId } })
    )
    expect(stillSourceHolding).toBeNull()

    // Provenance audit row links both sides.
    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, idempotencyKey: key },
        select: { entityType: true, afterJson: true },
      })
    )
    const provenance = audit.find((r) => r.entityType === "PositionMove")
    expect(provenance).toBeDefined()
    const after = provenance?.afterJson as Record<string, unknown> | null
    expect(after?.fromAccountId).toBe(source.id)
    expect(after?.toAccountId).toBe(dest.id)
    expect(after?.movedCostMinor).toBe("1000000")
  })

  // --------------------------------------------------------------------------
  // Move into an account that already holds the SAME instrument: average-cost
  // blends exactly, mirroring the Switch buy-side blend.
  // --------------------------------------------------------------------------
  test("moving into an account that already holds the same instrument blends average cost", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner, "Old broker")
    const dest = await makeInvestmentAccount(owner, "New broker")
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )
    const existing = await seedPosition(
      owner,
      dest.id,
      cash.id,
      { instrumentId: a.instrumentId },
      "50",
      "8000"
    )

    const result = await recordPositionMoveForFamily({
      data: {
        fromHoldingId: a.holdingId,
        toAccountId: dest.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Blended: (50 x 8,000 + 100 x 10,000) / 150 = (400,000 + 1,000,000) / 150
    // = 9,333.33... -> rounds half-up to 9,333 per unit (verified via the
    // exact same averageUnitCostMinor helper the server uses).
    expect(result.toHolding.quantity).toBe("150.00000000")
    expect(result.toHoldingId).toBe(existing.holdingId)

    const finalDest = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: existing.holdingId } })
    )
    expect(finalDest.quantity.toFixed(8)).toBe("150.00000000")
  })

  // --------------------------------------------------------------------------
  // Guard rejections
  // --------------------------------------------------------------------------
  test("rejects moving to the SAME account as the source", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner)
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordPositionMoveForFamily({
        data: {
          fromHoldingId: a.holdingId,
          toAccountId: source.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("rejects a cross-currency move", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner, "IDR broker")
    const destUsd = await makeInvestmentAccount(owner, "USD broker", "USD")
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordPositionMoveForFamily({
        data: {
          fromHoldingId: a.holdingId,
          toAccountId: destUsd.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    // Source untouched by the rejected attempt.
    const stillA = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: a.holdingId } })
    )
    expect(stillA.quantity.toFixed(8)).toBe("100.00000000")
  })

  test("rejects a destination account that is not holdings-tracked (balanceSource != valuation)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const source = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await expect(
      recordPositionMoveForFamily({
        data: {
          fromHoldingId: a.holdingId,
          // A cash-like (transaction_flow) account is not a holdings account.
          toAccountId: cash.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("a move referencing another family's holding/account is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner)
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )
    const intruderDest = await makeInvestmentAccount(intruder, "Intruder dest")

    await expect(
      recordPositionMoveForFamily({
        data: {
          fromHoldingId: a.holdingId,
          toAccountId: intruderDest.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    const stillA = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: a.holdingId } })
    )
    expect(stillA.quantity.toFixed(8)).toBe("100.00000000")
  })

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------
  test("replaying the same key returns the same result and does not double-move", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner, "Old broker")
    const dest = await makeInvestmentAccount(owner, "New broker")
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        fromHoldingId: a.holdingId,
        toAccountId: dest.id,
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await recordPositionMoveForFamily(payload)
    const second = await recordPositionMoveForFamily(payload)
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value))
    expect(normalize(second)).toEqual(normalize(first))

    // Applied exactly once: destination at 100 (not 200).
    const finalDest = await harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findUniqueOrThrow({ where: { id: first.toHoldingId } })
    )
    expect(finalDest.quantity.toFixed(8)).toBe("100.00000000")

    // Exactly one PositionMove provenance row for this key.
    const count = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.count({
        where: {
          familyId: owner.family.id,
          idempotencyKey: key,
          entityType: "PositionMove",
        },
      })
    )
    expect(count).toBe(1)
  })

  // --------------------------------------------------------------------------
  // Full round trip via getAccountHoldingsForFamily — both accounts reflect
  // the move once the dust settles.
  // --------------------------------------------------------------------------
  test("both accounts' holdings views reflect the move", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const source = await makeInvestmentAccount(owner, "Old broker")
    const dest = await makeInvestmentAccount(owner, "New broker")
    const a = await seedPosition(
      owner,
      source.id,
      cash.id,
      fundA,
      "100",
      "10000"
    )

    await recordPositionMoveForFamily({
      data: {
        fromHoldingId: a.holdingId,
        toAccountId: dest.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const sourceView = await getAccountHoldingsForFamily({
      accountId: source.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(sourceView.holdings).toHaveLength(0)

    const destView = await getAccountHoldingsForFamily({
      accountId: dest.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(destView.holdings).toHaveLength(1)
    expect(destView.holdings[0]?.instrument.name).toBe(fundA.name)
  })
})
