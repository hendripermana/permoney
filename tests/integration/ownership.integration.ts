import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  OwnerMemberNotActiveError,
  listOwnerCandidatesForFamily,
} from "@/server/ownership"
import {
  AccountOwnershipInvalidError,
  createZakatPayerForFamily,
  deleteZakatPayerForFamily,
  setAccountZakatOwnershipForFamily,
} from "@/server/zakat"
import { TenantReferenceError } from "@/server/validation/tenant-references"
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

// =============================================================================
// ADR-0058 D1 — owner resolution (real Postgres).
//
// `OwnerRef = { personId } | { memberUserId }`. The member branch validates an
// ACTIVE membership of THIS family and get-or-creates the linked person in the
// SAME transaction as the ownership write. One person per user rests on the
// `ZakatPayer.linkedUserId` unique index, so concurrent first-time resolutions
// must converge on one row.
// =============================================================================

describe("owner resolution (ADR-0058 D1)", () => {
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

  const addMember = async (
    owner: AuthenticatedOnboardedUser,
    status: "active" | "invited" | "revoked" = "active",
    name?: string
  ) => {
    const user = await factories.createUser({
      familyId: owner.family.id,
      ...(name ? { name } : {}),
    })
    await factories.createFamilyMember({
      familyId: owner.family.id,
      userId: user.id,
      status,
    })
    return user
  }

  const setOwner = (
    actor: AuthenticatedOnboardedUser,
    accountId: string,
    data: {
      owner: { personId: string } | { memberUserId: string } | null
      jointOwner?: { personId: string } | { memberUserId: string } | null
      jointSharePercent?: number | null
    },
    key = factories.createIdempotencyKey()
  ) =>
    setAccountZakatOwnershipForFamily({
      data: {
        accountId,
        owner: data.owner,
        jointOwner: data.jointOwner ?? null,
        jointSharePercent: data.jointSharePercent ?? null,
        idempotencyKey: key,
      },
      familyId: actor.family.id,
      userId: actor.user.id,
    })

  const peopleFor = (familyId: string) =>
    harness.withFamily(familyId, (tx) =>
      tx.zakatPayer.findMany({ where: { familyId } })
    )

  test("a member ref creates the linked person in the same transaction, once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner, "active", "Rahayu")
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })

    const first = await setOwner(owner, account.id, {
      owner: { memberUserId: spouse.id },
    })
    const people = await peopleFor(owner.family.id)
    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({
      linkedUserId: spouse.id,
      displayName: "Rahayu",
    })
    expect(first.zakatPayerId).toBe(people[0]!.id)

    // A second account, resolved through the same member, reuses the person.
    const account2 = await factories.createAccount({
      familyId: owner.family.id,
    })
    const second = await setOwner(owner, account2.id, {
      owner: { memberUserId: spouse.id },
    })
    expect(second.zakatPayerId).toBe(first.zakatPayerId)
    expect(await peopleFor(owner.family.id)).toHaveLength(1)

    // Person creation is audited in the same transaction as the tag.
    const audits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, entityType: "ZakatPayer" },
      })
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: "create",
      entityId: people[0]!.id,
    })
  })

  test("a member ref reuses an existing person already linked to that user", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner)
    const linked = await createZakatPayerForFamily({
      data: {
        displayName: "Istri",
        linkedUserId: spouse.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })
    const result = await setOwner(owner, account.id, {
      owner: { memberUserId: spouse.id },
    })
    expect(result.zakatPayerId).toBe(linked.id)
    expect(await peopleFor(owner.family.id)).toHaveLength(1)
  })

  test("rejects a user who is not an active member (none, invited, revoked)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })
    const stranger = await factories.createUser({ familyId: null })
    const invited = await addMember(owner, "invited")
    const revoked = await addMember(owner, "revoked")

    for (const userId of [stranger.id, invited.id, revoked.id]) {
      await expect(
        setOwner(owner, account.id, { owner: { memberUserId: userId } })
      ).rejects.toBeInstanceOf(OwnerMemberNotActiveError)
    }
    expect(await peopleFor(owner.family.id)).toHaveLength(0)
  })

  test("rejects a member of ANOTHER family and a foreign personId", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const other = await factories.createAuthenticatedOnboardedUser()
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })

    await expect(
      setOwner(owner, account.id, { owner: { memberUserId: other.user.id } })
    ).rejects.toBeInstanceOf(OwnerMemberNotActiveError)

    const foreignPerson = await createZakatPayerForFamily({
      data: {
        displayName: "Outsider",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: other.family.id,
      userId: other.user.id,
    })
    await expect(
      setOwner(owner, account.id, { owner: { personId: foreignPerson.id } })
    ).rejects.toBeInstanceOf(TenantReferenceError)

    // Nothing leaked into the caller's family.
    expect(await peopleFor(owner.family.id)).toHaveLength(0)
    const stored = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(stored.zakatPayerId).toBeNull()
  })

  test("concurrent first-time resolutions of one member yield exactly one person", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner)
    const accounts = await Promise.all(
      [1, 2, 3, 4].map(() =>
        factories.createAccount({ familyId: owner.family.id })
      )
    )

    const results = await Promise.all(
      accounts.map((a) =>
        setOwner(owner, a.id, { owner: { memberUserId: spouse.id } })
      )
    )

    const people = await peopleFor(owner.family.id)
    expect(people).toHaveLength(1)
    for (const r of results) expect(r.zakatPayerId).toBe(people[0]!.id)
  })

  test("same idempotency key replays; a different payload under it conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner)
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })
    const key = factories.createIdempotencyKey()

    const a = await setOwner(
      owner,
      account.id,
      { owner: { memberUserId: spouse.id } },
      key
    )
    const b = await setOwner(
      owner,
      account.id,
      { owner: { memberUserId: spouse.id } },
      key
    )
    expect(b).toEqual(a)

    await expect(
      setOwner(owner, account.id, { owner: null }, key)
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    // One person, one Account audit row for the tag.
    expect(await peopleFor(owner.family.id)).toHaveLength(1)
    const accountAudits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.count({
        where: { familyId: owner.family.id, entityType: "Account" },
      })
    )
    expect(accountAudits).toBe(1)
  })

  test("joint owner: a member and the person linked to it are the same owner", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner)
    const account = await factories.createAccount({
      familyId: owner.family.id,
    })
    const first = await setOwner(owner, account.id, {
      owner: { memberUserId: spouse.id },
    })

    await expect(
      setOwner(owner, account.id, {
        owner: { personId: first.zakatPayerId! },
        jointOwner: { memberUserId: spouse.id },
        jointSharePercent: 50,
      })
    ).rejects.toBeInstanceOf(AccountOwnershipInvalidError)

    // A genuine joint account with a member co-owner works.
    const ownerPerson = await createZakatPayerForFamily({
      data: {
        displayName: "Hendri",
        linkedUserId: owner.user.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const joint = await setOwner(owner, account.id, {
      owner: { personId: ownerPerson.id },
      jointOwner: { memberUserId: spouse.id },
      jointSharePercent: 40,
    })
    expect(joint).toMatchObject({
      zakatPayerId: ownerPerson.id,
      zakatJointPayerId: first.zakatPayerId,
      zakatJointSharePercent: 40,
    })
  })

  test("candidates list members before they have a person, without duplicates after", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner, "active", "Rahayu")
    await addMember(owner, "revoked", "Ex Member")

    const before = await listOwnerCandidatesForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: (f, u, fn) => harness.withMember(f, u, fn),
    })
    expect(before.activeMemberCount).toBe(2)
    expect(before.peopleCount).toBe(0)
    expect(before.candidates.map((c) => c.kind)).toEqual(["member", "member"])
    expect(
      before.candidates.some(
        (c) => "memberUserId" in c.ref && c.ref.memberUserId === spouse.id
      )
    ).toBe(true)

    const account = await factories.createAccount({
      familyId: owner.family.id,
    })
    await setOwner(owner, account.id, { owner: { memberUserId: spouse.id } })

    const after = await listOwnerCandidatesForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      runInTenantTransaction: (f, u, fn) => harness.withMember(f, u, fn),
    })
    expect(after.peopleCount).toBe(1)
    expect(after.candidates).toHaveLength(2) // owner (member) + Rahayu (person)
    expect(
      after.candidates.filter((c) => c.displayName === "Rahayu")
    ).toHaveLength(1)
  })

  test("deleting a person un-tags the account (owner cleared, ledger untouched)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner)
    const account = await factories.createAccount({
      familyId: owner.family.id,
      balance: 1_000n,
    })
    const tagged = await setOwner(owner, account.id, {
      owner: { memberUserId: spouse.id },
    })
    await deleteZakatPayerForFamily({
      data: {
        id: tagged.zakatPayerId!,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const stored = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(stored.zakatPayerId).toBeNull()
    expect(stored.familyId).toBe(owner.family.id)
    expect(stored.balance).toBe(1_000n)
  })
})
