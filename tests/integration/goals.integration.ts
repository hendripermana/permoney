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
import { HoldingError, recordTradeForFamily } from "@/server/holdings"
import {
  archiveGoalForFamily,
  createGoalForFamily,
  linkAccountToGoalForFamily,
  listGoalsForFamily,
  listHoldingGoalHistoryForFamily,
  reassignHoldingAllocationForFamily,
  unlinkAccountFromGoalForFamily,
} from "@/server/goals"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// Goal — broker-agnostic purpose grouping (Bibit "Portofolio" / Betterment
// "Goals" generalized), orthogonal to Account (custody). Reassigning a
// Holding's units between Goals is PURE relabeling: no cash, no cost-basis
// change, never a ledger Transaction — only an AuditLog "GoalAllocation" row.
// Conservation invariant: SUM(allocation.quantity) per holding must never
// exceed the Holding's own quantity.

describe("goals (broker-agnostic purpose grouping)", () => {
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
    name = "Majoris Pasar Uang"
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

  const fundA = { kind: "mutual_fund" as const, name: "Majoris Pasar Uang" }

  // Buys `quantity` units @ `unitPrice` (both minor units / decimal strings)
  // in `investmentId`, funded from `fundingId`.
  const seedPosition = async (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    fundingId: string,
    quantity: string,
    unitPrice: string
  ) => {
    const cashAmount = (BigInt(quantity) * BigInt(unitPrice)).toString()
    const buy = await recordTradeForFamily({
      data: {
        investmentAccountId: investmentId,
        fundingAccountId: fundingId,
        instrument: fundA,
        side: "buy",
        cashAmount,
        quantity,
        unitPrice,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    return { holdingId: buy.holding?.id ?? "" }
  }

  // --------------------------------------------------------------------------
  // The exact scenario from the design conversation: Rp 3,000,000 total in
  // Majoris Pasar Uang, move Rp 2,000,000 of it to "Dana Darurat", leaving
  // Rp 1,000,000 unassigned — no cash moves, no ledger Transaction, cost
  // basis floats with NAV on both sides afterward.
  // --------------------------------------------------------------------------
  test("moves a partial Rupiah amount of a holding into a Goal, leaving the rest unassigned", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    // 3,000,000 units @ 1 minor/unit = Rp 3,000,000 total (unit price kept at
    // 1 so "amount" and "quantity" are numerically identical and easy to
    // reason about in the assertions below).
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "3000000",
      "1"
    )

    const goal = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const result = await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: null,
        toGoalId: goal.id,
        amount: "2000000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.movedQuantity).toBe("2000000.00000000")
    expect(result.unallocatedQuantity).toBe("1000000.00000000")

    // No ledger Transaction was ever posted for this — the account's balance
    // is untouched (a pure relabeling, not a financial event).
    const investmentAfter = await harness.withFamily(
      owner.family.id,
      async (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: investment.id } })
    )
    expect(investmentAfter.balance).toBe(3_000_000n)

    const goals = await listGoalsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const danaDarurat = goals.find((g) => g.id === goal.id)
    expect(danaDarurat?.holdingAllocations).toHaveLength(1)
    expect(danaDarurat?.holdingAllocations[0]?.quantity).toBe(
      "2000000.00000000"
    )
    expect(danaDarurat?.holdingAllocations[0]?.valueMinor).toBe("2000000")
  })

  // --------------------------------------------------------------------------
  // Moving between two goals directly (not via the unassigned pool).
  // --------------------------------------------------------------------------
  test("moves an allocation directly from one Goal to another", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )

    const goalA = await createGoalForFamily({
      data: {
        name: "Tabungan Nikah",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const goalB = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: null,
        toGoalId: goalA.id,
        amount: "600000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const moved = await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: goalA.id,
        toGoalId: goalB.id,
        quantity: "250000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(moved.movedQuantity).toBe("250000.00000000")

    const goals = await listGoalsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const a = goals.find((g) => g.id === goalA.id)
    const b = goals.find((g) => g.id === goalB.id)
    expect(a?.holdingAllocations[0]?.quantity).toBe("350000.00000000")
    expect(b?.holdingAllocations[0]?.quantity).toBe("250000.00000000")
  })

  // --------------------------------------------------------------------------
  // Conservation invariant: cannot move more than is actually available,
  // either from the unassigned pool or from a specific Goal's allocation.
  // --------------------------------------------------------------------------
  test("rejects moving more than the unassigned pool holds", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )
    const goal = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      reassignHoldingAllocationForFamily({
        data: {
          holdingId: position.holdingId,
          fromGoalId: null,
          toGoalId: goal.id,
          amount: "1000001", // one more than the whole position
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    // Nothing was allocated by the rejected attempt.
    const goals = await listGoalsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(
      goals.find((g) => g.id === goal.id)?.holdingAllocations
    ).toHaveLength(0)
  })

  test("rejects moving more than a Goal's own allocation holds", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )
    const goalA = await createGoalForFamily({
      data: {
        name: "Tabungan Nikah",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const goalB = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: null,
        toGoalId: goalA.id,
        amount: "300000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      reassignHoldingAllocationForFamily({
        data: {
          holdingId: position.holdingId,
          fromGoalId: goalA.id,
          toGoalId: goalB.id,
          quantity: "300001", // one more than goalA actually holds
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("rejects fromGoalId equal to toGoalId", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )
    const goal = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      reassignHoldingAllocationForFamily({
        data: {
          holdingId: position.holdingId,
          fromGoalId: goal.id,
          toGoalId: goal.id,
          quantity: "1",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow()
  })

  // --------------------------------------------------------------------------
  // Whole-account linking (the "this whole savings account IS my Dana
  // Darurat" case) — an account can belong to at most one Goal.
  // --------------------------------------------------------------------------
  test("links and unlinks a whole account to a Goal, rejecting a double-link elsewhere", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const savings = await makeCashAccount(owner, "Tabungan Darurat", "10000000")
    const goalA = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const goalB = await createGoalForFamily({
      data: {
        name: "Tabungan Nikah",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const link = await linkAccountToGoalForFamily({
      data: { goalId: goalA.id, accountId: savings.id },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(link.balanceMinor).toBe("10000000")

    await expect(
      linkAccountToGoalForFamily({
        data: { goalId: goalB.id, accountId: savings.id },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    await unlinkAccountFromGoalForFamily({
      data: { accountId: savings.id },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Now linkable to the other goal.
    const relinked = await linkAccountToGoalForFamily({
      data: { goalId: goalB.id, accountId: savings.id },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(relinked.accountId).toBe(savings.id)
  })

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------
  test("replaying the same reassignment key does not double-move units", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )
    const goal = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        holdingId: position.holdingId,
        fromGoalId: null,
        toGoalId: goal.id,
        amount: "400000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await reassignHoldingAllocationForFamily(payload)
    const second = await reassignHoldingAllocationForFamily(payload)
    expect(second).toEqual(first)

    const goals = await listGoalsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    // Applied exactly once: 400,000, not 800,000.
    expect(
      goals.find((g) => g.id === goal.id)?.holdingAllocations[0]?.quantity
    ).toBe("400000.00000000")
  })

  // --------------------------------------------------------------------------
  // Tenant isolation
  // --------------------------------------------------------------------------
  test("a reassignment referencing another family's holding is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )
    const intruderGoal = await createGoalForFamily({
      data: {
        name: "Intruder Goal",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: intruder.family.id,
      user: intruder.user,
    })

    await expect(
      reassignHoldingAllocationForFamily({
        data: {
          holdingId: position.holdingId,
          fromGoalId: null,
          toGoalId: intruderGoal.id,
          amount: "1",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()
  })

  // --------------------------------------------------------------------------
  // Contextual activity — "when was this holding last moved between Goals?"
  // --------------------------------------------------------------------------
  test("holding Goal history reflects reassignments with resolved Goal names", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "1000000",
      "1"
    )
    const goalA = await createGoalForFamily({
      data: {
        name: "Tabungan Nikah",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const goalB = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: null,
        toGoalId: goalA.id,
        amount: "500000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: goalA.id,
        toGoalId: goalB.id,
        quantity: "200000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const history = await listHoldingGoalHistoryForFamily({
      holdingId: position.holdingId,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(history).toHaveLength(2)
    // Newest first.
    expect(history[0]?.fromGoalName).toBe("Tabungan Nikah")
    expect(history[0]?.toGoalName).toBe("Dana Darurat")
    expect(history[0]?.movedQuantity).toBe("200000.00000000")
    expect(history[1]?.fromGoalName).toBeNull()
    expect(history[1]?.toGoalName).toBe("Tabungan Nikah")
  })

  test("archiving a Goal keeps its allocations queryable but excludes it from the default list", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const investment = await makeInvestmentAccount(owner)
    const position = await seedPosition(
      owner,
      investment.id,
      cash.id,
      "500000",
      "1"
    )
    const goal = await createGoalForFamily({
      data: {
        name: "Dana Darurat",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await reassignHoldingAllocationForFamily({
      data: {
        holdingId: position.holdingId,
        fromGoalId: null,
        toGoalId: goal.id,
        amount: "500000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await archiveGoalForFamily({
      data: { goalId: goal.id },
      familyId: owner.family.id,
      user: owner.user,
    })

    const defaultList = await listGoalsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(defaultList.find((g) => g.id === goal.id)).toBeUndefined()

    const withArchived = await listGoalsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      includeArchived: true,
    })
    expect(
      withArchived.find((g) => g.id === goal.id)?.archivedAt
    ).not.toBeNull()
  })
})
