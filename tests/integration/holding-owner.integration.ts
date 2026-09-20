import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  deleteTradeForFamily,
  recordPositionMoveForFamily,
  recordTradeForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  OwnerMemberNotActiveError,
  getWealthOwnershipInputsForFamily,
} from "@/server/ownership"
import { TenantReferenceError } from "@/server/validation/tenant-references"
import {
  createZakatPayerForFamily,
  deleteZakatPayerForFamily,
} from "@/server/zakat"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"
import {
  makeCashAccount,
  makeInvestmentAccount,
  seedPosition,
} from "./support/holdings-fixtures"
import { withPrivilegedDatabase } from "./support/privileged-db"

// =============================================================================
// ADR-0058 D2 — per-holding owner (real Postgres).
//
// `Holding.ownerPersonId` is a nullable tenant-safe composite FK to
// ZakatPayer(id, familyId) with a COLUMN-SCOPED `ON DELETE SET NULL`. These
// tests prove the tenant boundary at the DB (not just the app guard), that
// deleting a person un-owns holdings WITHOUT nulling familyId, RLS isolation,
// and that the ledger paths that replace/restore holdings keep or default the
// owner sensibly.
// =============================================================================

describe("holding owner (ADR-0058 D2)", () => {
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

  const addPerson = (owner: AuthenticatedOnboardedUser, displayName: string) =>
    createZakatPayerForFamily({
      data: { displayName, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  const holdingRow = (owner: AuthenticatedOnboardedUser, id: string) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.holding.findUnique({ where: { id } })
    )

  const addHolding = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    extra: {
      owner?: { personId: string } | { memberUserId: string } | null
      holdingId?: string
      /** Units + avg cost (major) to write when editing a seeded position. */
      quantity?: string
      avgUnitCost?: string
    } = {}
  ) =>
    upsertHoldingForFamily({
      data: {
        accountId,
        ...(extra.holdingId ? { holdingId: extra.holdingId } : {}),
        ...(extra.holdingId
          ? {}
          : { instrument: { kind: "mutual_fund" as const, name: "Fund A" } }),
        quantity: extra.quantity ?? "10",
        avgUnitCost: extra.avgUnitCost ?? "1000",
        lastPrice: extra.avgUnitCost ?? "1000",
        ...(extra.owner === undefined ? {} : { owner: extra.owner }),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const holdingAudits = (owner: AuthenticatedOnboardedUser, id: string) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: {
          familyId: owner.family.id,
          entityType: "Holding",
          entityId: id,
        },
        orderBy: { createdAt: "asc" },
      })
    )

  test("create with an owner, change it, clear it — each step audited before/after", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const rahayu = await addPerson(owner, "Rahayu")
    const hendri = await addPerson(owner, "Hendri")

    const created = await addHolding(owner, account.id, {
      owner: { personId: rahayu.id },
    })
    expect(created.ownerPersonId).toBe(rahayu.id)

    const moved = await addHolding(owner, account.id, {
      holdingId: created.id,
      owner: { personId: hendri.id },
    })
    expect(moved.ownerPersonId).toBe(hendri.id)

    // Omitting `owner` on an update leaves it untouched.
    const untouched = await addHolding(owner, account.id, {
      holdingId: created.id,
    })
    expect(untouched.ownerPersonId).toBe(hendri.id)

    const cleared = await addHolding(owner, account.id, {
      holdingId: created.id,
      owner: null,
    })
    expect(cleared.ownerPersonId).toBeNull()

    const audits = await holdingAudits(owner, created.id)
    const pairs = audits.map((a) => ({
      action: a.action,
      before: (a.beforeJson as { ownerPersonId?: string | null } | null)
        ?.ownerPersonId,
      after: (a.afterJson as { ownerPersonId?: string | null } | null)
        ?.ownerPersonId,
    }))
    expect(pairs).toEqual([
      { action: "create", before: undefined, after: rahayu.id },
      { action: "update", before: rahayu.id, after: hendri.id },
      { action: "update", before: hendri.id, after: hendri.id },
      { action: "update", before: hendri.id, after: null },
    ])
  })

  test("a member ref resolves (and creates) the member's person in the same transaction", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const spouse = await factories.createUser({
      familyId: owner.family.id,
      name: "Rahayu",
    })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: spouse.id,
    })

    const holding = await addHolding(owner, account.id, {
      owner: { memberUserId: spouse.id },
    })
    const people = await harness.withFamily(owner.family.id, (tx) =>
      tx.zakatPayer.findMany({ where: { familyId: owner.family.id } })
    )
    // The spouse's person, plus the acting member's own (the first on-demand
    // person never stands alone — see ownership.integration.ts).
    expect(people).toHaveLength(2)
    const spousePerson = people.find((p) => p.linkedUserId === spouse.id)
    expect(spousePerson).toMatchObject({ displayName: "Rahayu" })
    expect(holding.ownerPersonId).toBe(spousePerson!.id)

    const stranger = await factories.createUser({ familyId: null })
    await expect(
      addHolding(owner, account.id, {
        holdingId: holding.id,
        owner: { memberUserId: stranger.id },
      })
    ).rejects.toBeInstanceOf(OwnerMemberNotActiveError)
  })

  test("a cross-family owner is rejected by the app guard and creates nothing", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const other = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const foreign = await addPerson(other, "Outsider")

    await expect(
      addHolding(owner, account.id, { owner: { personId: foreign.id } })
    ).rejects.toBeInstanceOf(TenantReferenceError)

    const holdings = await harness.withFamily(owner.family.id, (tx) =>
      tx.holding.count({ where: { familyId: owner.family.id } })
    )
    expect(holdings).toBe(0)
  })

  test("the composite FK itself rejects a cross-family owner, even bypassing the app", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const other = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const mine = await addPerson(owner, "Mine")
    const foreign = await addPerson(other, "Outsider")
    const holding = await addHolding(owner, account.id, {
      owner: { personId: mine.id },
    })

    // Privileged connection: RLS is bypassed, only the FK can stop this.
    await withPrivilegedDatabase(harness.databaseName, async (client) => {
      await expect(
        client.query(
          `UPDATE "Holding" SET "ownerPersonId" = $1 WHERE id = $2`,
          [foreign.id, holding.id]
        )
      ).rejects.toMatchObject({ code: "23503" })
    })
    expect((await holdingRow(owner, holding.id))?.ownerPersonId).toBe(mine.id)
  })

  test("deleting the person un-owns the holding and leaves familyId (and the ledger) intact", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const rahayu = await addPerson(owner, "Rahayu")
    const holding = await addHolding(owner, account.id, {
      owner: { personId: rahayu.id },
    })
    const balanceBefore = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )

    await deleteZakatPayerForFamily({
      data: { id: rahayu.id, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

    const row = await holdingRow(owner, holding.id)
    expect(row).not.toBeNull()
    expect(row?.ownerPersonId).toBeNull()
    expect(row?.familyId).toBe(owner.family.id)
    expect(row?.quantity.toFixed(8)).toBe("10.00000000")
    const balanceAfter = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(balanceAfter.balance).toBe(balanceBefore.balance)
  })

  test("RLS: another family cannot see or re-point this family's holdings", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const other = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const mine = await addPerson(owner, "Mine")
    const theirs = await addPerson(other, "Theirs")
    const holding = await addHolding(owner, account.id, {
      owner: { personId: mine.id },
    })

    const seen = await harness.withFamily(other.family.id, (tx) =>
      tx.holding.findMany()
    )
    expect(seen).toHaveLength(0)

    const updated = await harness.withFamily(other.family.id, (tx) =>
      tx.holding.updateMany({
        where: { id: holding.id },
        data: { ownerPersonId: theirs.id },
      })
    )
    expect(updated.count).toBe(0)
    expect((await holdingRow(owner, holding.id))?.ownerPersonId).toBe(mine.id)
  })

  test("a Buy-created holding has no owner, and later buys keep an assigned owner", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(factories, owner)
    const cash = await makeCashAccount(factories, owner)
    const rahayu = await addPerson(owner, "Rahayu")

    const seeded = await seedPosition(
      factories,
      owner,
      investment.id,
      cash.id,
      { kind: "mutual_fund", name: "Fund B" },
      "100",
      "10000"
    )
    expect(
      (await holdingRow(owner, seeded.holdingId))?.ownerPersonId
    ).toBeNull()

    await addHolding(owner, investment.id, {
      holdingId: seeded.holdingId,
      owner: { personId: rahayu.id },
    })
    // A second buy of the same instrument blends into the SAME row.
    await seedPosition(
      factories,
      owner,
      investment.id,
      cash.id,
      { instrumentId: seeded.instrumentId },
      "50",
      "10000"
    )
    expect((await holdingRow(owner, seeded.holdingId))?.ownerPersonId).toBe(
      rahayu.id
    )
  })

  test("reversing a sell-to-zero restores the owner; a stale owner is dropped, not fatal", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(factories, owner)
    const cash = await makeCashAccount(factories, owner)
    const rahayu = await addPerson(owner, "Rahayu")
    const hendri = await addPerson(owner, "Hendri")

    const sellAllAndReverse = async (
      personId: string,
      forgetPerson: boolean
    ) => {
      const seeded = await seedPosition(
        factories,
        owner,
        investment.id,
        cash.id,
        { kind: "mutual_fund", name: `Fund ${personId.slice(-4)}` },
        "100",
        "10000"
      )
      await addHolding(owner, investment.id, {
        holdingId: seeded.holdingId,
        owner: { personId },
        quantity: "100",
        avgUnitCost: "100",
      })
      const sell = await recordTradeForFamily({
        data: {
          investmentAccountId: investment.id,
          fundingAccountId: cash.id,
          instrumentId: seeded.instrumentId,
          side: "sell",
          cashAmount: "1000000",
          quantity: "100",
          unitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(sell.holding).toBeNull()
      expect(await holdingRow(owner, seeded.holdingId)).toBeNull()
      if (forgetPerson) {
        await deleteZakatPayerForFamily({
          data: {
            id: personId,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          userId: owner.user.id,
        })
      }
      await deleteTradeForFamily({
        data: {
          transactionId: sell.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      return await holdingRow(owner, seeded.holdingId)
    }

    const restored = await sellAllAndReverse(rahayu.id, false)
    expect(restored?.ownerPersonId).toBe(rahayu.id)

    const dropped = await sellAllAndReverse(hendri.id, true)
    expect(dropped).not.toBeNull()
    expect(dropped?.ownerPersonId).toBeNull()
  })

  test("a position move carries the owner to a freshly-created destination holding", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const from = await makeInvestmentAccount(factories, owner, "Bibit A")
    const to = await makeInvestmentAccount(factories, owner, "Bibit B")
    const cash = await makeCashAccount(factories, owner)
    const rahayu = await addPerson(owner, "Rahayu")
    const seeded = await seedPosition(
      factories,
      owner,
      from.id,
      cash.id,
      { kind: "mutual_fund", name: "Fund C" },
      "100",
      "10000"
    )
    await addHolding(owner, from.id, {
      holdingId: seeded.holdingId,
      owner: { personId: rahayu.id },
    })

    const moved = await recordPositionMoveForFamily({
      data: {
        fromHoldingId: seeded.holdingId,
        toAccountId: to.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect((await holdingRow(owner, moved.toHoldingId))?.ownerPersonId).toBe(
      rahayu.id
    )
  })
  test("wealth inputs list the family's people and ONLY owned holdings, valued like the holdings view", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const other = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(factories, owner)
    const otherAccount = await makeInvestmentAccount(factories, other)
    const rahayu = await addPerson(owner, "Rahayu")
    const outsider = await addPerson(other, "Outsider")

    // 10 units @ Rp 1,000 avg, last price Rp 1,500 -> value Rp 15,000.
    await upsertHoldingForFamily({
      data: {
        accountId: account.id,
        instrument: { kind: "mutual_fund", name: "Owned fund" },
        quantity: "10",
        avgUnitCost: "1000",
        lastPrice: "1500",
        owner: { personId: rahayu.id },
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await addHolding(owner, account.id) // no owner: must not be listed
    await upsertHoldingForFamily({
      data: {
        accountId: otherAccount.id,
        instrument: { kind: "mutual_fund", name: "Theirs" },
        quantity: "1",
        avgUnitCost: "1",
        owner: { personId: outsider.id },
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: other.family.id,
      user: other.user,
    })

    const inputs = await getWealthOwnershipInputsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: (f, u, fn) => harness.withMember(f, u, fn),
    })
    expect(inputs.people).toEqual([{ id: rahayu.id, displayName: "Rahayu" }])
    expect(inputs.ownedHoldings).toEqual([
      {
        accountId: account.id,
        ownerPersonId: rahayu.id,
        valueMinor: "1500000", // 10 x Rp 1,500 in sen
      },
    ])
  })
})
