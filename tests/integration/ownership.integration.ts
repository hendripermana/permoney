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
    // The spouse's person, plus the acting member's own (see the next test).
    expect(people).toHaveLength(2)
    const spousePerson = people.find((p) => p.linkedUserId === spouse.id)
    expect(spousePerson).toMatchObject({ displayName: "Rahayu" })
    expect(first.zakatPayerId).toBe(spousePerson!.id)

    // A second account, resolved through the same member, reuses the person.
    const account2 = await factories.createAccount({
      familyId: owner.family.id,
    })
    const second = await setOwner(owner, account2.id, {
      owner: { memberUserId: spouse.id },
    })
    expect(second.zakatPayerId).toBe(first.zakatPayerId)
    expect(await peopleFor(owner.family.id)).toHaveLength(2)

    // Person creation is audited in the same transaction as the tag: one row
    // per created person, none for the reuse.
    const audits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, entityType: "ZakatPayer" },
      })
    )
    expect(audits.map((a) => a.action)).toEqual(["create", "create"])
    expect(new Set(audits.map((a) => a.entityId))).toEqual(
      new Set(people.map((p) => p.id))
    )
  })

  test("the first on-demand person never stands alone: the acting member gets theirs too", async () => {
    // With exactly ONE person Zakat runs in single-payer mode and counts every
    // account toward that person, so creating only the spouse would silently
    // turn the household head's implicit "Me" into the spouse.
    const owner = await factories.createAuthenticatedOnboardedUser()
    const spouse = await addMember(owner, "active", "Rahayu")
    const other = await addMember(owner, "active", "Dina")
    const [a1, a2] = await Promise.all(
      [1, 2].map(() => factories.createAccount({ familyId: owner.family.id }))
    )

    await setOwner(owner, a1!.id, { owner: { memberUserId: spouse.id } })
    let people = await peopleFor(owner.family.id)
    expect(new Set(people.map((p) => p.linkedUserId))).toEqual(
      new Set([owner.user.id, spouse.id])
    )

    // Not the first person any more: a third member adds only their own.
    await setOwner(owner, a2!.id, { owner: { memberUserId: other.id } })
    people = await peopleFor(owner.family.id)
    expect(people).toHaveLength(3)

    // Assigning to yourself first (no other person yet) creates just yours.
    const solo = await factories.createAuthenticatedOnboardedUser()
    const soloAccount = await factories.createAccount({
      familyId: solo.family.id,
    })
    await setOwner(solo, soloAccount.id, {
      owner: { memberUserId: solo.user.id },
    })
    expect(await peopleFor(solo.family.id)).toHaveLength(1)
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

    // Exactly one person per user: the spouse's, and the acting member's.
    const people = await peopleFor(owner.family.id)
    expect(people).toHaveLength(2)
    expect(new Set(people.map((p) => p.linkedUserId)).size).toBe(2)
    const spousePerson = people.find((p) => p.linkedUserId === spouse.id)
    for (const r of results) expect(r.zakatPayerId).toBe(spousePerson!.id)
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

    // Replay created nothing new (spouse + acting member), one Account audit
    // row for the tag.
    expect(await peopleFor(owner.family.id)).toHaveLength(2)
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

    // A genuine joint account with a member co-owner works. The acting
    // member's own person already exists (created alongside the spouse's).
    const ownerPerson = (await peopleFor(owner.family.id)).find(
      (p) => p.linkedUserId === owner.user.id
    )!
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
    // Rahayu and the acting member both have a person now; no member is left
    // over as a separate "member" candidate, and nobody appears twice.
    expect(after.peopleCount).toBe(2)
    expect(after.candidates.map((c) => c.kind)).toEqual(["person", "person"])
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
