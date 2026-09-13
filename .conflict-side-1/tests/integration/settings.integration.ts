import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  readSettingsOverviewForFamily,
  updateFamilyPreferencesForFamily,
  updateProfileForUser,
} from "@/server/settings"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-113 — Real-Postgres proof of the settings mutations: family preference
// (timezone) and profile/theme writes go through a tenant transaction, persist,
// write an audit row in the same tx, and stay tenant-isolated.

describe("settings mutations (PER-113)", () => {
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

  // Inject the harness tenant runner so the domain fns run with both GUCs set to
  // the acting member — exactly what familyMiddleware would do in production.
  const runner = (actorId: string) => {
    return <T>(
      familyId: string,
      userId: string,
      fn: Parameters<typeof harness.withMember>[2]
    ) => {
      expect(userId).toBe(actorId)
      return harness.withMember(familyId, userId, fn) as Promise<T>
    }
  }

  test("updates family timezone, persists it, and writes an audit row", async () => {
    const family = await factories.createFamily()
    const user = await factories.createUser({ familyId: family.id })
    await factories.createFamilyMember({
      familyId: family.id,
      userId: user.id,
      role: "owner",
    })

    const result = await updateFamilyPreferencesForFamily({
      data: { timezone: "America/New_York" },
      familyId: family.id,
      userId: user.id,
      runInTenantTransaction: runner(user.id),
    })
    expect(result.timezone).toBe("America/New_York")

    const persisted = await harness.prisma.family.findUniqueOrThrow({
      where: { id: family.id },
      select: { timezone: true },
    })
    expect(persisted.timezone).toBe("America/New_York")

    // AuditLog SELECT is membership-gated by RLS, so it must be read inside a
    // tenant transaction (GUCs set), never via the bare GUC-less client.
    const audit = await harness.withFamily(family.id, (tx) =>
      tx.auditLog.findFirst({
        where: {
          familyId: family.id,
          entityType: "Family",
          entityId: family.id,
        },
        orderBy: { createdAt: "desc" },
      })
    )
    expect(audit).not.toBeNull()
    expect(audit?.action).toBe("update")
    expect(audit?.afterJson).toMatchObject({ timezone: "America/New_York" })
  })

  test("rejects an unknown IANA timezone", async () => {
    const family = await factories.createFamily()
    const user = await factories.createUser({ familyId: family.id })
    await factories.createFamilyMember({
      familyId: family.id,
      userId: user.id,
      role: "owner",
    })

    await expect(
      updateFamilyPreferencesForFamily({
        data: { timezone: "Mars/Phobos" },
        familyId: family.id,
        userId: user.id,
        runInTenantTransaction: runner(user.id),
      })
    ).rejects.toThrow()
  })

  test("updates profile name + theme and audits the change", async () => {
    const family = await factories.createFamily()
    const user = await factories.createUser({ familyId: family.id })
    await factories.createFamilyMember({
      familyId: family.id,
      userId: user.id,
      role: "member",
    })

    const result = await updateProfileForUser({
      data: { name: "Renamed Person", theme: "dark" },
      familyId: family.id,
      userId: user.id,
      runInTenantTransaction: runner(user.id),
    })
    expect(result.name).toBe("Renamed Person")
    expect(result.theme).toBe("dark")

    const persisted = await harness.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { name: true, theme: true },
    })
    expect(persisted).toMatchObject({ name: "Renamed Person", theme: "dark" })

    const overview = await readSettingsOverviewForFamily({
      familyId: family.id,
      userId: user.id,
      runInTenantTransaction: runner(user.id),
    })
    expect(overview.profile.name).toBe("Renamed Person")
    expect(overview.profile.theme).toBe("dark")
    expect(overview.family.timezone).toBe(family.timezone)

    // This user is a plain member (no owner), so read as the explicit member —
    // withFamily would resolve a non-existent owner and fail the membership GUC.
    const audit = await harness.withMember(family.id, user.id, (tx) =>
      tx.auditLog.findFirst({
        where: { familyId: family.id, entityType: "User", entityId: user.id },
        orderBy: { createdAt: "desc" },
      })
    )
    expect(audit?.afterJson).toMatchObject({
      name: "Renamed Person",
      theme: "dark",
    })
  })

  test("a member of family B cannot update family A's preferences (RLS)", async () => {
    const familyA = await factories.createFamily()
    const ownerA = await factories.createUser({ familyId: familyA.id })
    await factories.createFamilyMember({
      familyId: familyA.id,
      userId: ownerA.id,
      role: "owner",
    })

    const familyB = await factories.createFamily()
    const ownerB = await factories.createUser({ familyId: familyB.id })
    await factories.createFamilyMember({
      familyId: familyB.id,
      userId: ownerB.id,
      role: "owner",
    })

    // ownerB acting with family A's id: the RLS membership guard runs the write
    // under app.user_id=ownerB / app.family_id=familyA, where ownerB is not a
    // member — the Family update affects zero rows, so findUniqueOrThrow on the
    // pre-image (or the update) fails and nothing in family A changes.
    await expect(
      updateFamilyPreferencesForFamily({
        data: { timezone: "Europe/London" },
        familyId: familyA.id,
        userId: ownerB.id,
        runInTenantTransaction: runner(ownerB.id),
      })
    ).rejects.toThrow()

    const persisted = await harness.prisma.family.findUniqueOrThrow({
      where: { id: familyA.id },
      select: { timezone: true },
    })
    expect(persisted.timezone).toBe(familyA.timezone)
  })
})
