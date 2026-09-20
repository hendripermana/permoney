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
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

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

  const seedHolding = async (owner: AuthenticatedOnboardedUser) => {
    const account = await makeInvestmentAccount(owner)
    return await harness.withFamily(owner.family.id, async (tx) => {
      const instrument = await tx.instrument.create({
        data: {
          familyId: owner.family.id,
          kind: "metal",
          name: "Gold",
          quoteCurrency: "IDR",
          priceModel: "market",
        },
      })
      const holding = await tx.holding.create({
        data: {
          familyId: owner.family.id,
          accountId: account.id,
          instrumentId: instrument.id,
          quantity: "3",
          avgUnitCostMinor: 1_000_000n,
        },
      })
      return { account, instrument, holding }
    })
  }

  test("active member reads and writes holdings and instruments", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, instrument, holding } = await seedHolding(owner)

    const seen = await harness.withMember(
      owner.family.id,
      owner.user.id,
      async (tx) => ({
        holdings: await tx.holding.count(),
        instruments: await tx.instrument.count(),
        quantity: (
          await tx.holding.findUniqueOrThrow({ where: { id: holding.id } })
        ).quantity.toString(),
      })
    )
    expect(seen.holdings).toBe(1)
    expect(seen.instruments).toBe(1)
    expect(seen.quantity).toBe("3")

    const created = await harness.withMember(
      owner.family.id,
      owner.user.id,
      async (tx) =>
        await tx.holding.create({
          data: {
            familyId: owner.family.id,
            accountId: account.id,
            instrumentId: instrument.id,
            quantity: "1",
            avgUnitCostMinor: 500n,
          },
        })
    )
    expect(created.id).toBeTruthy()
  })

  test("revoked member cannot read holdings or instruments", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { holding } = await seedHolding(owner)

    const revoked = await factories.createUser({ familyId: null })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: revoked.id,
      status: "revoked",
    })

    const visible = await harness.withMember(
      owner.family.id,
      revoked.id,
      async (tx) => ({
        holdings: await tx.holding.count(),
        instruments: await tx.instrument.count(),
        byId: await tx.holding.findFirst({ where: { id: holding.id } }),
      })
    )
    expect(visible.holdings).toBe(0)
    expect(visible.instruments).toBe(0)
    expect(visible.byId).toBeNull()
  })

  test("revoked member cannot write a holding or instrument", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, instrument } = await seedHolding(owner)

    const revoked = await factories.createUser({ familyId: null })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: revoked.id,
      status: "revoked",
    })

    await expect(
      harness.withMember(owner.family.id, revoked.id, async (tx) =>
        tx.holding.create({
          data: {
            familyId: owner.family.id,
            accountId: account.id,
            instrumentId: instrument.id,
            quantity: "9",
            avgUnitCostMinor: 1n,
          },
        })
      )
    ).rejects.toThrow()

    await expect(
      harness.withMember(owner.family.id, revoked.id, async (tx) =>
        tx.instrument.create({
          data: {
            familyId: owner.family.id,
            kind: "metal",
            name: "Smuggled",
            quoteCurrency: "IDR",
            priceModel: "market",
          },
        })
      )
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

    const visible = await harness.withMember(
      owner.family.id,
      stranger.user.id,
      async (tx) => ({
        holdings: await tx.holding.count(),
        instruments: await tx.instrument.count(),
        byId: await tx.holding.findFirst({ where: { id: holding.id } }),
      })
    )
    expect(visible.holdings).toBe(0)
    expect(visible.instruments).toBe(0)
    expect(visible.byId).toBeNull()

    await expect(
      harness.withMember(owner.family.id, stranger.user.id, async (tx) =>
        tx.holding.create({
          data: {
            familyId: owner.family.id,
            accountId: account.id,
            instrumentId: instrument.id,
            quantity: "1",
            avgUnitCostMinor: 1n,
          },
        })
      )
    ).rejects.toThrow()
  })

  test("invited-but-not-yet-active member is denied (status is part of the guard)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { holding } = await seedHolding(owner)
    const invitee = await factories.createUser({ familyId: null })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: invitee.id,
      status: "invited",
    })

    const visible = await harness.withMember(
      owner.family.id,
      invitee.id,
      async (tx) => await tx.holding.findFirst({ where: { id: holding.id } })
    )
    expect(visible).toBeNull()
  })
})
