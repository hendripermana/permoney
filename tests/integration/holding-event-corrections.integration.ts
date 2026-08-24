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
  correctHoldingEventForFamily,
  deleteHoldingEventForFamily,
  getAccountHoldingsForFamily,
  getHoldingEventForCorrectionForFamily,
  HoldingError,
  listAccountHoldingEventsForFamily,
  recordDistributionForFamily,
  recordSwitchForFamily,
  recordTradeForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import { IdempotencyConflictError } from "@/server/idempotency"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-259 Slice 5 (second half) / ADR-0054 — edit / delete (correct) a SWITCH
// or a DIVIDEND REINVEST.
//
// These events create NO `Transaction` (a switch is fund→fund, a reinvest
// creates units from the distribution itself), so they are resolved from their
// append-only provenance `AuditLog` row and reversed from the Holding
// before/after snapshots captured in the same transaction — never a recomputed
// inverse. The guard is the SAME "still the latest quantity-mutating event"
// IDENTITY check the Buy/Sell correction uses, applied to EVERY position the
// event touched: for a switch, later activity on EITHER fund A or fund B
// refuses the whole correction.
//
// Money amounts are in MINOR units (IDR sen). Fixtures use exact-division
// quantities/prices so conservation is provable to the sen.

describe("position-event corrections — switch & dividend reinvest", () => {
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

  const makeInvestmentAccount = async (owner: AuthenticatedOnboardedUser) =>
    await createAccountForFamily({
      data: {
        name: "Bibit",
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Opening balance 150,000 major = 15,000,000 sen.
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

  const balanceOf = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const row = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { balance: true },
      })
      return row.balance
    })

  const holdingRow = (owner: AuthenticatedOnboardedUser, holdingId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findFirst({
        where: { id: holdingId, familyId: owner.family.id },
      })
    )

  const holdingsOf = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    await getAccountHoldingsForFamily({
      accountId,
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  const eventsOf = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    await listAccountHoldingEventsForFamily({
      data: { accountId },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  // Buy 100 units of Fund A @ 10,000 (cash 1,000,000).
  const buyFundA = async (
    owner: AuthenticatedOnboardedUser,
    investmentAccountId: string,
    fundingAccountId: string
  ) =>
    await recordTradeForFamily({
      data: {
        investmentAccountId,
        fundingAccountId,
        instrument: { kind: "mutual_fund" as const, name: "Fund A" },
        side: "buy" as const,
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Switch `quantity` units of A (@10,000) into a brand-new Fund B (@8,000).
  const switchToFundB = async (
    owner: AuthenticatedOnboardedUser,
    investmentAccountId: string,
    fromHoldingId: string,
    quantity = "40"
  ) =>
    await recordSwitchForFamily({
      data: {
        investmentAccountId,
        fromHoldingId,
        toInstrument: { kind: "mutual_fund" as const, name: "Fund B" },
        quantity,
        fromUnitPrice: "10000",
        toUnitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const reinvestOn = async (
    owner: AuthenticatedOnboardedUser,
    investmentAccountId: string,
    holdingId: string,
    amount = "500000"
  ) =>
    await recordDistributionForFamily({
      data: {
        investmentAccountId,
        holdingId,
        mode: "reinvest" as const,
        amount,
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // A fixture reused by most cases: 100 units of A, 40 of them switched into B.
  const seedSwitch = async (owner: AuthenticatedOnboardedUser) => {
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    const holdingA = buy.holding?.id ?? ""
    const switched = await switchToFundB(owner, investment.id, holdingA)
    const [event] = await eventsOf(owner, investment.id)
    return {
      investment,
      cash,
      holdingA,
      instrumentA: buy.holding?.instrumentId ?? "",
      switched,
      eventId: event?.eventId ?? "",
    }
  }

  // ==========================================================================
  // DELETE — reversal only
  // ==========================================================================

  test("DELETE a switch restores BOTH positions exactly; value conserved; event closed", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    // 60 A @ 10,000 (600,000) + 50 B @ 8,000 (400,000) = 1,000,000.
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
    expect(
      (await holdingsOf(owner, seeded.investment.id)).holdings
    ).toHaveLength(2)
    const cashAfterSwitch = await balanceOf(owner, seeded.cash.id)

    const result = await deleteHoldingEventForFamily({
      data: {
        eventId: seeded.eventId,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.reversed).toBe(true)
    expect(result.kind).toBe("switch")

    // A is back to 100 @ 10,000 with its pre-switch marker; B (created by the
    // switch) is gone; the Σ-holdings anchor re-materialized to the same total.
    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("100.00000000")
    expect(a?.avgUnitCostMinor).toBe(10_000n)
    const view = await holdingsOf(owner, seeded.investment.id)
    expect(view.holdings).toHaveLength(1)
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
    // A switch never touches cash — reversing it must not either.
    expect(await balanceOf(owner, seeded.cash.id)).toBe(cashAfterSwitch)

    // The event is closed: it leaves the activity list and cannot be reopened.
    expect(await eventsOf(owner, seeded.investment.id)).toHaveLength(0)
    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: {
          familyId: owner.family.id,
          entityType: "HoldingEventCorrection",
        },
        select: { action: true, entityId: true, idempotencyKey: true },
      })
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe("delete")
    expect(audit[0]?.entityId).toBe(seeded.eventId)
  })

  test("DELETE a switch that CLOSED fund A recreates it with its original id", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    const holdingA = buy.holding?.id ?? ""

    // Switch ALL of A out — the A position closes (hard delete), B is created.
    const switched = await switchToFundB(owner, investment.id, holdingA, "100")
    expect(switched.fromHolding).toBeNull()
    expect(await holdingRow(owner, holdingA)).toBeNull()

    const [event] = await eventsOf(owner, investment.id)
    await deleteHoldingEventForFamily({
      data: {
        eventId: event?.eventId ?? "",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const restored = await holdingRow(owner, holdingA)
    expect(restored).not.toBeNull()
    expect(restored?.quantity.toFixed(8)).toBe("100.00000000")
    expect(restored?.avgUnitCostMinor).toBe(10_000n)
    expect((await holdingsOf(owner, investment.id)).holdings).toHaveLength(1)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
  })

  test("DELETE a dividend reinvest rolls units and cost basis back", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    const holdingA = buy.holding?.id ?? ""
    const cashAfterBuy = await balanceOf(owner, cash.id)

    // 500,000 reinvested @ 10,000 = 50 more units → 150 @ 10,000.
    await reinvestOn(owner, investment.id, holdingA)
    expect(await balanceOf(owner, investment.id)).toBe(1_500_000n)

    const [event] = await eventsOf(owner, investment.id)
    expect(event?.kind).toBe("dividend_reinvest")
    const result = await deleteHoldingEventForFamily({
      data: {
        eventId: event?.eventId ?? "",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.investmentValueAfterMinor).toBe("1000000")

    const a = await holdingRow(owner, holdingA)
    expect(a?.quantity.toFixed(8)).toBe("100.00000000")
    expect(a?.avgUnitCostMinor).toBe(10_000n)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
    // A reinvest moves no external cash — nor does reversing it.
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterBuy)
  })

  test("DELETE replay with the same key reverses exactly once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: { eventId: seeded.eventId, idempotencyKey: key },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await deleteHoldingEventForFamily(payload)
    const second = await deleteHoldingEventForFamily(payload)
    expect(second).toEqual(first)

    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("100.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
  })

  test("DELETE with a reused key but a different payload conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)
    const other = await makeInvestmentAccount(owner)
    const otherBuy = await buyFundA(owner, other.id, seeded.cash.id)
    await switchToFundB(owner, other.id, otherBuy.holding?.id ?? "")
    const [otherEvent] = await eventsOf(owner, other.id)

    const key = factories.createIdempotencyKey()
    await deleteHoldingEventForFamily({
      data: { eventId: seeded.eventId, idempotencyKey: key },
      familyId: owner.family.id,
      user: owner.user,
    })
    await expect(
      deleteHoldingEventForFamily({
        data: { eventId: otherEvent?.eventId ?? "", idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  test("DELETE an already-deleted event (fresh key) fails without double reversal", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    await deleteHoldingEventForFamily({
      data: {
        eventId: seeded.eventId,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/already been edited or deleted/)

    // Reversed exactly once.
    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("100.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
  })

  // ==========================================================================
  // The TWO-LEG guard — later activity on EITHER side refuses the correction
  // ==========================================================================

  test("DELETE a switch is rejected when a later BUY touched the SELL leg (fund A)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    await recordTradeForFamily({
      data: {
        investmentAccountId: seeded.investment.id,
        fundingAccountId: seeded.cash.id,
        instrumentId: seeded.instrumentA,
        side: "buy" as const,
        cashAmount: "200000",
        quantity: "20",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/Fund A.*activity after it|activity after it.*Fund A/)
  })

  test("DELETE a switch is rejected when a later BUY touched the BUY leg (fund B) only", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    // Fund A is untouched by this; ONLY the destination leg moves. The guard
    // must still refuse — reversing the switch would unwind units the later
    // buy averaged into.
    await recordTradeForFamily({
      data: {
        investmentAccountId: seeded.investment.id,
        fundingAccountId: seeded.cash.id,
        instrumentId: seeded.switched.toInstrumentId,
        side: "buy" as const,
        cashAmount: "160000",
        quantity: "20",
        unitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/Fund B/)

    // Nothing was reversed: A is still at 60, B still holds the blended units.
    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("60.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_160_000n)
  })

  test("DELETE a switch is rejected when a later SELL CLOSED the BUY leg (fund B)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    // The switch LEFT a live B row behind; a later sell-to-zero removed it.
    // Its absence is unambiguous evidence of later activity — never treat it
    // as "still latest" and resurrect the row.
    await recordTradeForFamily({
      data: {
        investmentAccountId: seeded.investment.id,
        fundingAccountId: seeded.cash.id,
        instrumentId: seeded.switched.toInstrumentId,
        side: "sell" as const,
        cashAmount: "400000",
        quantity: "50",
        unitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(
      (await holdingsOf(owner, seeded.investment.id)).holdings
    ).toHaveLength(1)

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/Fund B was changed or closed since/)
  })

  test("DELETE a switch is rejected after a reopen-THEN-reclose cascade on the closed leg", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    const instrumentA = buy.holding?.instrumentId ?? ""

    // Switch ALL of A out: the A leg's "after" is null (it closed the
    // position), which is the ONE shape where a missing row is legitimate.
    await switchToFundB(owner, investment.id, buy.holding?.id ?? "", "100")
    const [event] = await eventsOf(owner, investment.id)

    // …then A is bought again (a BRAND-NEW Holding row — no marker on the old
    // id to compare) and sold back to zero. No live row is left, so only the
    // append-only audit trail can prove the position moved since.
    const rebuy = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: instrumentA,
        side: "buy" as const,
        cashAmount: "300000",
        quantity: "30",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: instrumentA,
        side: "sell" as const,
        cashAmount: "300000",
        quantity: "30",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(await holdingRow(owner, rebuy.holding?.id ?? "")).toBeNull()

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: event?.eventId ?? "",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/Fund A was changed or closed since/)
  })

  test("DELETE a switch is rejected even when values coincidentally match (IDENTITY, not a value diff)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    // Buy back exactly the 40 A units the switch removed, at the same price:
    // fund A's quantity and average cost are EXACTLY what the switch left
    // behind before it — a value-diff guard would wrongly allow the reversal.
    await recordTradeForFamily({
      data: {
        investmentAccountId: seeded.investment.id,
        fundingAccountId: seeded.cash.id,
        instrumentId: seeded.instrumentA,
        side: "buy" as const,
        cashAmount: "400000",
        quantity: "40",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("100.00000000")
    expect(a?.avgUnitCostMinor).toBe(10_000n)

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  test("DELETE a dividend reinvest is rejected after a later trade on the same position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    await reinvestOn(owner, investment.id, buy.holding?.id ?? "")
    const [event] = await eventsOf(owner, investment.id)

    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: buy.holding?.instrumentId ?? "",
        side: "sell" as const,
        cashAmount: "100000",
        quantity: "10",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: event?.eventId ?? "",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/dividend reinvest has activity after it/)
  })

  test("DELETE a switch is rejected after a manual raw edit cleared a leg's marker", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    await upsertHoldingForFamily({
      data: {
        accountId: seeded.investment.id,
        holdingId: seeded.holdingA,
        instrument: { kind: "mutual_fund" as const, name: "Fund A" },
        quantity: "60",
        avgUnitCost: "10500",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  // ==========================================================================
  // Out of scope, by design — the paths that need no correction machinery
  // ==========================================================================

  test("a CASH dividend is not correctable here; it points at the destination account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)

    await recordDistributionForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId: buy.holding?.id ?? "",
        mode: "cash" as const,
        amount: "120000",
        destinationAccountId: cash.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // It never shows up as position activity (it moved no units)…
    expect(await eventsOf(owner, investment.id)).toHaveLength(0)

    // …and reaching for it by id fails loud with the actionable message.
    const row = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findFirst({
        where: { familyId: owner.family.id, entityType: "Distribution" },
        select: { id: true },
      })
    )
    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: row?.id ?? "",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/normal income transaction/)
  })

  test("DELETE cross-tenant is rejected; nothing is reversed", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    await expect(
      deleteHoldingEventForFamily({
        data: {
          eventId: seeded.eventId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("60.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
  })

  // ==========================================================================
  // CORRECT — reversal + reapply, one atomic transaction
  // ==========================================================================

  test("CORRECT a switch: old event closed, corrected one live, both positions exact", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)
    const cashAfterSwitch = await balanceOf(owner, seeded.cash.id)

    // Meant to switch 25 units (not 40), at B = 5,000 (not 8,000):
    // proceeds 250,000 → 50 units of B; A keeps 75 @ 10,000.
    const result = await correctHoldingEventForFamily({
      data: {
        kind: "switch" as const,
        eventId: seeded.eventId,
        quantity: "25",
        fromUnitPrice: "10000",
        toUnitPrice: "5000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.kind).toBe("switch")
    if (result.kind !== "switch") throw new Error("unreachable")
    expect(result.switched.proceedsMinor).toBe("250000")
    expect(result.switched.toQuantity).toBe("50.00000000")
    expect(result.switched.fromHolding?.quantity).toBe("75.00000000")

    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("75.00000000")
    expect(a?.avgUnitCostMinor).toBe(10_000n)
    // 75 × 10,000 + 50 × 5,000 = 1,000,000 — value conserved, no cash moved.
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
    expect(await balanceOf(owner, seeded.cash.id)).toBe(cashAfterSwitch)

    // Exactly ONE open event: the corrected one, under a new id.
    const events = await eventsOf(owner, seeded.investment.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.eventId).not.toBe(seeded.eventId)
    expect(events[0]?.quantity).toBe("25.00000000")

    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: {
          familyId: owner.family.id,
          entityType: "HoldingEventCorrection",
        },
        select: { action: true, entityId: true },
      })
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe("update")
    expect(audit[0]?.entityId).toBe(seeded.eventId)
  })

  test("CORRECT a switch twice in a row keeps the books exact", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    const first = await correctHoldingEventForFamily({
      data: {
        kind: "switch" as const,
        eventId: seeded.eventId,
        quantity: "25",
        fromUnitPrice: "10000",
        toUnitPrice: "5000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(first.kind).toBe("switch")

    const [openEvent] = await eventsOf(owner, seeded.investment.id)
    await correctHoldingEventForFamily({
      data: {
        kind: "switch" as const,
        eventId: openEvent?.eventId ?? "",
        quantity: "10",
        fromUnitPrice: "10000",
        toUnitPrice: "5000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // 90 A @ 10,000 + 20 B @ 5,000 = 1,000,000.
    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("90.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
    expect(await eventsOf(owner, seeded.investment.id)).toHaveLength(1)
  })

  test("CORRECT a dividend reinvest re-derives units and cost basis", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    const holdingA = buy.holding?.id ?? ""
    await reinvestOn(owner, investment.id, holdingA)
    const [event] = await eventsOf(owner, investment.id)

    // Meant 200,000 @ 20,000/unit = 10 units → 110 units, cost 1,200,000.
    const result = await correctHoldingEventForFamily({
      data: {
        kind: "dividend_reinvest" as const,
        eventId: event?.eventId ?? "",
        amount: "200000",
        unitPrice: "20000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.kind).toBe("dividend_reinvest")

    const a = await holdingRow(owner, holdingA)
    expect(a?.quantity.toFixed(8)).toBe("110.00000000")
    // Cost 1,200,000 over 110 units — average unit cost rounds to 10,909.
    expect(a?.avgUnitCostMinor).toBe(10_909n)
    expect(await eventsOf(owner, investment.id)).toHaveLength(1)
  })

  test("CORRECT replay with the same key corrects exactly once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        kind: "switch" as const,
        eventId: seeded.eventId,
        quantity: "25",
        fromUnitPrice: "10000",
        toUnitPrice: "5000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await correctHoldingEventForFamily(payload)
    const second = await correctHoldingEventForFamily(payload)
    expect(second).toEqual(first)

    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("75.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
    expect(await eventsOf(owner, seeded.investment.id)).toHaveLength(1)
  })

  test("CORRECT with a reused key but a different payload conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)
    const key = factories.createIdempotencyKey()
    const base = {
      kind: "switch" as const,
      eventId: seeded.eventId,
      fromUnitPrice: "10000",
      toUnitPrice: "5000",
      idempotencyKey: key,
    }

    await correctHoldingEventForFamily({
      data: { ...base, quantity: "25" },
      familyId: owner.family.id,
      user: owner.user,
    })
    await expect(
      correctHoldingEventForFamily({
        data: { ...base, quantity: "30" },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  test("CORRECT is rejected when the destination leg has later activity", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)
    await recordTradeForFamily({
      data: {
        investmentAccountId: seeded.investment.id,
        fundingAccountId: seeded.cash.id,
        instrumentId: seeded.switched.toInstrumentId,
        side: "buy" as const,
        cashAmount: "160000",
        quantity: "20",
        unitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      correctHoldingEventForFamily({
        data: {
          kind: "switch" as const,
          eventId: seeded.eventId,
          quantity: "25",
          fromUnitPrice: "10000",
          toUnitPrice: "5000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/Fund B/)

    // Atomic: nothing reversed, nothing reapplied.
    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("60.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_160_000n)
  })

  test("CORRECT with the wrong kind is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    await expect(
      correctHoldingEventForFamily({
        data: {
          kind: "dividend_reinvest" as const,
          eventId: seeded.eventId,
          amount: "100000",
          unitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/cannot be corrected as a dividend reinvest/)
  })

  test("CORRECT a switch beyond the units held fails loud and rolls back atomically", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    // The reversal restores A to 100 units; 250 is still impossible, and the
    // reapply must fail with the SAME message `recordSwitchForFamily` gives.
    await expect(
      correctHoldingEventForFamily({
        data: {
          kind: "switch" as const,
          eventId: seeded.eventId,
          quantity: "250",
          fromUnitPrice: "10000",
          toUnitPrice: "5000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/Cannot switch/)

    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("60.00000000")
    expect(await balanceOf(owner, seeded.investment.id)).toBe(1_000_000n)
    expect(await eventsOf(owner, seeded.investment.id)).toHaveLength(1)
  })

  test("CORRECT cross-tenant is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    await expect(
      correctHoldingEventForFamily({
        data: {
          kind: "switch" as const,
          eventId: seeded.eventId,
          quantity: "25",
          fromUnitPrice: "10000",
          toUnitPrice: "5000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    const a = await holdingRow(owner, seeded.holdingA)
    expect(a?.quantity.toFixed(8)).toBe("60.00000000")
  })

  // ==========================================================================
  // READ — activity list + correction prefill
  // ==========================================================================

  test("the activity list shows switches and reinvests newest-first, scoped to the account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const other = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFundA(owner, investment.id, cash.id)
    await switchToFundB(owner, investment.id, buy.holding?.id ?? "")
    await reinvestOn(owner, investment.id, buy.holding?.id ?? "", "100000")

    const otherBuy = await buyFundA(owner, other.id, cash.id)
    await switchToFundB(owner, other.id, otherBuy.holding?.id ?? "")

    const events = await eventsOf(owner, investment.id)
    expect(events).toHaveLength(2)
    expect(events[0]?.kind).toBe("dividend_reinvest")
    expect(events[0]?.title).toBe("Fund A")
    expect(events[0]?.amountMinor).toBe("100000")
    expect(events[1]?.kind).toBe("switch")
    expect(events[1]?.title).toBe("Fund A → Fund B")
    expect(events[1]?.quantity).toBe("40.00000000")
    expect(events[1]?.amountMinor).toBe("400000")
    expect(events[1]?.realizedGainMinor).toBe("0")

    // The other account's switch never leaks into this list.
    expect(await eventsOf(owner, other.id)).toHaveLength(1)
  })

  test("getHoldingEventForCorrection prefills a switch and flags a non-latest one", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const seeded = await seedSwitch(owner)

    const view = await getHoldingEventForCorrectionForFamily({
      data: { eventId: seeded.eventId },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.kind).toBe("switch")
    if (view.kind !== "switch") throw new Error("unreachable")
    expect(view.fromInstrumentName).toBe("Fund A")
    expect(view.toInstrumentName).toBe("Fund B")
    expect(view.quantity).toBe("40.00000000")
    expect(view.fromUnitPriceMinor).toBe("10000")
    expect(view.toUnitPriceMinor).toBe("8000")
    expect(view.currency).toBe("IDR")
    expect(view.notLatestReason).toBeNull()

    await recordTradeForFamily({
      data: {
        investmentAccountId: seeded.investment.id,
        fundingAccountId: seeded.cash.id,
        instrumentId: seeded.instrumentA,
        side: "buy" as const,
        cashAmount: "100000",
        quantity: "10",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const stale = await getHoldingEventForCorrectionForFamily({
      data: { eventId: seeded.eventId },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(stale.notLatestReason).toMatch(/activity after it/)
  })

  test("getHoldingEventForCorrection prefills a reinvest with the recorded unit price", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await buyFundA(owner, investment.id, cash.id)
    await reinvestOn(owner, investment.id, buy.holding?.id ?? "")
    const [event] = await eventsOf(owner, investment.id)

    const view = await getHoldingEventForCorrectionForFamily({
      data: { eventId: event?.eventId ?? "" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.kind).toBe("dividend_reinvest")
    if (view.kind !== "dividend_reinvest") throw new Error("unreachable")
    expect(view.instrumentName).toBe("Fund A")
    expect(view.amountMinor).toBe("500000")
    expect(view.unitPriceMinor).toBe("10000")
    expect(view.quantity).toBe("50.00000000")
    expect(view.notLatestReason).toBeNull()
  })
})
