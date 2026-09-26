import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"
import { createHoldingSuiteFixtures } from "./support/holding-suite-fixtures"

/**
 * F1 audit finding "Security S1" (Phase 1 report, Department 6).
 *
 * `Instrument` and `Holding` shipped with plain tenant isolation and no
 * ADR-0036 §4 membership conjunct, alone among the 22 tenant tables. The
 * database is the second wall of tenant isolation, so a session whose
 * `app.family_id` GUC carried the family id — but whose `app.user_id` was a
 * revoked member or a stranger — could read and write holdings (position size
 * and cost basis) where every other tenant table would refuse.
 *
 * The policy fix lives in
 * `prisma/migrations/20260920140000_holding_rls_membership_guard/migration.sql`.
 * These tests pin the behaviour against real Postgres through the harness's
 * non-superuser, RLS-enforced runtime role (the harness asserts the role is
 * neither superuser nor BYPASSRLS — see `assertRuntimeRoleEnforcesRls`).
 *
 * Every test shares the same arrange/act helpers below, so a test body is only
 * the identity it acts as, the operation it attempts, and the assertion.
 */
describe("holding/instrument RLS membership guard (audit S1 / ADR-0036 §4)", () => {
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

  // --- arrange -------------------------------------------------------------

  const { makeInvestmentAccount } = createHoldingSuiteFixtures(
    () => harness,
    () => factories
  )

  /** A user with no family of their own, linked to `owner`'s family as `status`. */
  const addFamilyMemberWithStatus = async (
    owner: AuthenticatedOnboardedUser,
    status: "revoked" | "invited"
  ) => {
    const member = await factories.createUser({ familyId: null })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: member.id,
      status,
    })
    return member
  }

  // --- act ----------------------------------------------------------------

  /**
   * Creates `instrument` rows as the given actor, under that actor's GUCs. The
   * owner's seeding path and the negative "revoked/stranger cannot write" paths
   * differ only in the actor, so they share this helper.
   */
  const createInstrumentAs = async (
    familyId: string,
    actorUserId: string,
    name: string
  ) =>
    await harness.withMember(familyId, actorUserId, async (tx) =>
      tx.instrument.create({
        data: {
          familyId,
          kind: "metal",
          name,
          quoteCurrency: "IDR",
          priceModel: "market",
        },
      })
    )

  /** Creates a `holding` row as the given actor, under that actor's GUCs. */
  const createHoldingAs = async (
    familyId: string,
    actorUserId: string,
    input: {
      accountId: string
      instrumentId: string
      quantity: string
      avgUnitCostMinor: bigint
    }
  ) =>
    await harness.withMember(familyId, actorUserId, async (tx) =>
      tx.holding.create({ data: { familyId, ...input } })
    )

  /**
   * Reads every RLS-guarded shape as one actor in a single transaction: the two
   * table counts, the target holding by id, and its quantity. Negative cases
   * assert the first three are 0/0/null; the positive case also pins the value.
   */
  const readTenantStateAs = async (
    familyId: string,
    actorUserId: string,
    holdingId: string
  ) =>
    await harness.withMember(familyId, actorUserId, async (tx) => {
      const byId = await tx.holding.findFirst({ where: { id: holdingId } })
      return {
        holdings: await tx.holding.count(),
        instruments: await tx.instrument.count(),
        byId,
        quantity: byId?.quantity.toString() ?? null,
      }
    })

  // --- fixtures ------------------------------------------------------------

  /** An investment account plus one gold instrument and its holding, as `owner`. */
  const seedHolding = async (owner: AuthenticatedOnboardedUser) => {
    const account = await makeInvestmentAccount(owner)
    const instrument = await createInstrumentAs(
      owner.family.id,
      owner.user.id,
      "Gold"
    )
    const holding = await createHoldingAs(owner.family.id, owner.user.id, {
      accountId: account.id,
      instrumentId: instrument.id,
      quantity: "3",
      avgUnitCostMinor: 1_000_000n,
    })
    return { account, instrument, holding }
  }

  // --- tests ---------------------------------------------------------------

  test("active member reads and writes holdings and instruments", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, instrument, holding } = await seedHolding(owner)

    const seen = await readTenantStateAs(
      owner.family.id,
      owner.user.id,
      holding.id
    )
    expect(seen.holdings).toBe(1)
    expect(seen.instruments).toBe(1)
    expect(seen.quantity).toBe("3")

    const created = await createHoldingAs(owner.family.id, owner.user.id, {
      accountId: account.id,
      instrumentId: instrument.id,
      quantity: "1",
      avgUnitCostMinor: 500n,
    })
    expect(created.id).toBeTruthy()
  })

  test("revoked member cannot read holdings or instruments", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { holding } = await seedHolding(owner)
    const revoked = await addFamilyMemberWithStatus(owner, "revoked")

    const visible = await readTenantStateAs(
      owner.family.id,
      revoked.id,
      holding.id
    )
    expect(visible.holdings).toBe(0)
    expect(visible.instruments).toBe(0)
    expect(visible.byId).toBeNull()
  })

  test("revoked member cannot write a holding or instrument", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, instrument } = await seedHolding(owner)
    const revoked = await addFamilyMemberWithStatus(owner, "revoked")

    await expect(
      createHoldingAs(owner.family.id, revoked.id, {
        accountId: account.id,
        instrumentId: instrument.id,
        quantity: "9",
        avgUnitCostMinor: 1n,
      })
    ).rejects.toThrow()

    await expect(
      createInstrumentAs(owner.family.id, revoked.id, "Smuggled")
    ).rejects.toThrow()

    // The owner's rows are untouched by the rejected writes.
    const counts = await harness.withFamily(owner.family.id, async (tx) => ({
      holdings: await tx.holding.count(),
      instruments: await tx.instrument.count(),
      smuggled: await tx.instrument.count({ where: { name: "Smuggled" } }),
    }))
    expect(counts.holdings).toBe(1)
    expect(counts.instruments).toBe(1)
    expect(counts.smuggled).toBe(0)
  })

  test("non-member stranger with the family GUC cannot read or write", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, instrument, holding } = await seedHolding(owner)
    const stranger = await factories.createAuthenticatedOnboardedUser()

    const visible = await readTenantStateAs(
      owner.family.id,
      stranger.user.id,
      holding.id
    )
    expect(visible.holdings).toBe(0)
    expect(visible.instruments).toBe(0)
    expect(visible.byId).toBeNull()

    await expect(
      createHoldingAs(owner.family.id, stranger.user.id, {
        accountId: account.id,
        instrumentId: instrument.id,
        quantity: "1",
        avgUnitCostMinor: 1n,
      })
    ).rejects.toThrow()
  })

  test("invited-but-not-yet-active member is denied (status is part of the guard)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { holding } = await seedHolding(owner)
    const invitee = await addFamilyMemberWithStatus(owner, "invited")

    const visible = await readTenantStateAs(
      owner.family.id,
      invitee.id,
      holding.id
    )
    expect(visible.byId).toBeNull()
  })
})
