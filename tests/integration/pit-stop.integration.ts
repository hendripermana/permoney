import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { AppError, isAuthError } from "@/lib/auth-errors"
import type { AccountType } from "@/lib/accounts"
import { createAccountForFamily } from "@/server/accounts"
import { IdempotencyConflictError } from "@/server/idempotency"
import type { FamilyRole } from "@/server/middleware/authz"
import {
  batchReconcileFn,
  batchReconcileForFamily,
  listPitStopAccountsForFamily,
  PitStopError,
  PIT_STOP_VALUATION_SOURCE,
} from "@/server/pit-stop"
import { createTransactionForFamily } from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"
import { makeInvestmentAccount } from "./support/holdings-fixtures"
import { callServerFnAs } from "./support/server-fn-request"

// ADR-0058 D4 — Pit Stop batch balance check. Real Postgres: these invariants
// (all-or-nothing, idempotent replay, tenant isolation, in-transaction canonical
// read, derived-only unrecorded movement) cannot be proven with a mocked Prisma.

describe("Pit Stop batch reconcile (ADR-0058 D4)", () => {
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

  const makeAccount = async (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      currency?: string
      openingBalance?: string
    } = {}
  ) =>
    await createAccountForFamily({
      data: {
        name: overrides.name ?? "Checking",
        accountType: overrides.accountType ?? "DEPOSITORY",
        ...(overrides.currency ? { currency: overrides.currency } : {}),
        openingBalance: overrides.openingBalance ?? "150000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const runBatch = (
    owner: AuthenticatedOnboardedUser,
    entries: Array<{ accountId: string; actualBalance: string }>,
    idempotencyKey = factories.createIdempotencyKey()
  ) =>
    batchReconcileForFamily({
      data: { idempotencyKey, entries },
      familyId: owner.family.id,
      user: owner.user,
    })

  const pitStopAnchors = (owner: AuthenticatedOnboardedUser) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.valuation.findMany({
        where: { source: PIT_STOP_VALUATION_SOURCE },
        orderBy: { createdAt: "asc" },
      })
    )

  const balanceOf = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    (
      await harness.withFamily(owner.family.id, (tx) =>
        tx.account.findFirstOrThrow({ where: { id: accountId } })
      )
    ).balance

  const transactionCount = (owner: AuthenticatedOnboardedUser) =>
    harness.withFamily(owner.family.id, (tx) => tx.transaction.count())

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

  test("writes one ground-truth anchor per entry, re-materializes balances and posts no transaction", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "150000",
    })
    const wallet = await makeAccount(owner, {
      name: "Wallet",
      accountType: "E_WALLET",
      openingBalance: "20000",
    })
    const txnsBefore = await transactionCount(owner)

    const result = await runBatch(owner, [
      { accountId: bank.id, actualBalance: "120000" },
      { accountId: wallet.id, actualBalance: "25000" },
    ])

    const byId = new Map(result.results.map((row) => [row.accountId, row]))
    expect(byId.get(bank.id)).toMatchObject({
      before: "150000",
      after: "120000",
      delta: "-30000",
      matchesActual: true,
    })
    expect(byId.get(wallet.id)).toMatchObject({
      before: "20000",
      after: "25000",
      delta: "5000",
      matchesActual: true,
    })
    expect(result.unrecordedByCurrency).toEqual([
      { currency: "IDR", delta: "-25000" },
    ])

    expect(await balanceOf(owner, bank.id)).toBe(120000n)
    expect(await balanceOf(owner, wallet.id)).toBe(25000n)

    const anchors = await pitStopAnchors(owner)
    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) {
      expect(anchor.type).toBe("reconciliation")
      expect(anchor.provenance).toBe("ground_truth")
    }
    // ADR-0043: derived only — never a plug transaction.
    expect(await transactionCount(owner)).toBe(txnsBefore)
  })

  test("audits each anchor with { source: pit_stop, priorBalance, delta } and the batch idempotency key", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, { openingBalance: "150000" })
    const key = factories.createIdempotencyKey()

    await runBatch(
      owner,
      [{ accountId: bank.id, actualBalance: "100000" }],
      key
    )

    const logs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityType: "Valuation", idempotencyKey: key },
      })
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]?.afterJson).toMatchObject({
      source: "pit_stop",
      priorBalance: "150000",
      delta: "-50000",
    })
    const accountLogs = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.findMany({
        where: {
          entityType: "Account",
          entityId: bank.id,
          idempotencyKey: key,
        },
      })
    )
    expect(accountLogs).toHaveLength(1)
  })

  test("is all-or-nothing: a rejected entry mid-batch rolls back every earlier anchor", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    // Cash-in-hand cannot go negative (only DEPOSITORY/E_WALLET carve out an
    // overdraft), so a negative value is rejected by the ledger AFTER earlier
    // entries were already written in the same transaction.
    const one = await makeAccount(owner, { name: "One", accountType: "CASH" })
    const two = await makeAccount(owner, { name: "Two", accountType: "CASH" })
    // The batch writes in account-id order: `lo` is written before `hi` fails.
    const [lo, hi] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1))
    if (!lo || !hi) throw new Error("fixture")

    await expect(
      runBatch(owner, [
        { accountId: lo.id, actualBalance: "90000" },
        { accountId: hi.id, actualBalance: "-1000" },
      ])
    ).rejects.toThrow(/negative/i)

    expect(await pitStopAnchors(owner)).toHaveLength(0)
    expect(await balanceOf(owner, lo.id)).toBe(150000n)
    expect(await balanceOf(owner, hi.id)).toBe(150000n)
    // Only the two account-creation records exist; the failed batch left none.
    const records = await harness.withFamily(owner.family.id, (tx) =>
      tx.idempotencyRecord.count()
    )
    expect(records).toBe(2)
  })

  test("replaying the same key + payload returns the same response and writes nothing new", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner)
    const key = factories.createIdempotencyKey()
    const entries = [{ accountId: bank.id, actualBalance: "111000" }]

    const first = await runBatch(owner, entries, key)
    const replay = await runBatch(owner, entries, key)

    expect(replay).toEqual(first)
    expect(await pitStopAnchors(owner)).toHaveLength(1)
    expect(await balanceOf(owner, bank.id)).toBe(111000n)
  })

  test("a replay is not fooled by entries arriving in a different order", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const a = await makeAccount(owner, { name: "A" })
    const b = await makeAccount(owner, { name: "B" })
    const key = factories.createIdempotencyKey()

    const first = await runBatch(
      owner,
      [
        { accountId: a.id, actualBalance: "1000" },
        { accountId: b.id, actualBalance: "2000" },
      ],
      key
    )
    const replay = await runBatch(
      owner,
      [
        { accountId: b.id, actualBalance: "2000" },
        { accountId: a.id, actualBalance: "1000" },
      ],
      key
    )
    expect(replay).toEqual(first)
    expect(await pitStopAnchors(owner)).toHaveLength(2)
  })

  test("the same key with a different payload is a conflict and changes nothing", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner)
    const key = factories.createIdempotencyKey()

    await runBatch(
      owner,
      [{ accountId: bank.id, actualBalance: "100000" }],
      key
    )
    await expect(
      runBatch(owner, [{ accountId: bank.id, actualBalance: "999999" }], key)
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    expect(await pitStopAnchors(owner)).toHaveLength(1)
    expect(await balanceOf(owner, bank.id)).toBe(100000n)
  })

  test("rejects holdings/valuation-tracked accounts with a clear message and writes nothing", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner)
    const tracked = await makeInvestmentAccount(factories, owner, "Reksadana")

    const attempt = runBatch(owner, [
      { accountId: bank.id, actualBalance: "100000" },
      { accountId: tracked.id, actualBalance: "5000000" },
    ])
    await expect(attempt).rejects.toBeInstanceOf(PitStopError)
    await expect(attempt).rejects.toThrow(/holdings|market value/i)

    expect(await pitStopAnchors(owner)).toHaveLength(0)
    expect(await balanceOf(owner, bank.id)).toBe(150000n)
  })

  test("rejects a closed (deleted) account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner)
    await harness.withFamily(owner.family.id, (tx) =>
      tx.account.update({
        where: { id: bank.id },
        data: {
          deletedAt: new Date(),
          status: "closed",
          archivedAt: new Date(),
        },
      })
    )
    await expect(
      runBatch(owner, [{ accountId: bank.id, actualBalance: "1" }])
    ).rejects.toBeInstanceOf(PitStopError)
  })

  test("tenant isolation: another family's account is rejected and nothing is written in either family", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const stranger = await factories.createAuthenticatedOnboardedUser()
    const mine = await makeAccount(owner, { name: "Mine" })
    const theirs = await makeAccount(stranger, { name: "Theirs" })

    await expect(
      runBatch(owner, [
        { accountId: mine.id, actualBalance: "1000" },
        { accountId: theirs.id, actualBalance: "1000" },
      ])
    ).rejects.toBeInstanceOf(PitStopError)

    expect(await pitStopAnchors(owner)).toHaveLength(0)
    expect(await pitStopAnchors(stranger)).toHaveLength(0)
    expect(await balanceOf(stranger, theirs.id)).toBe(150000n)
  })

  test("reads the canonical balance inside the transaction: a stale stored balance does not matter", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, { openingBalance: "150000" })
    // A real, dated-yesterday expense: canonical balance is 100000.
    await createTransactionForFamily({
      data: {
        type: "expense",
        amount: "50000",
        description: "Groceries",
        accountId: bank.id,
        date: daysAgo(1),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    // Corrupt the materialized cache: whatever a stale client cached, the
    // database's canonical answer is what must be reported as `before`.
    await harness.withFamily(owner.family.id, (tx) =>
      tx.account.update({ where: { id: bank.id }, data: { balance: 999n } })
    )

    const result = await runBatch(owner, [
      { accountId: bank.id, actualBalance: "100000" },
    ])

    expect(result.results[0]).toMatchObject({
      before: "100000",
      after: "100000",
      delta: "0",
    })
    expect(await balanceOf(owner, bank.id)).toBe(100000n)
  })

  test("a zero-difference entry still writes an anchor and refreshes last-checked", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, { openingBalance: "150000" })

    const overviewBefore = await listPitStopAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(overviewBefore.accounts[0]?.lastCheckedAt).toBeNull()

    const result = await runBatch(owner, [
      { accountId: bank.id, actualBalance: "150000" },
    ])

    expect(result.results[0]?.delta).toBe("0")
    expect(result.unrecordedByCurrency).toEqual([
      { currency: "IDR", delta: "0" },
    ])
    expect(await pitStopAnchors(owner)).toHaveLength(1)

    const overviewAfter = await listPitStopAccountsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(overviewAfter.accounts[0]?.lastCheckedAt).toBe(
      new Date().toISOString().slice(0, 10)
    )
  })

  test("sums the unrecorded movement per currency across accounts and currencies", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const idrA = await makeAccount(owner, {
      name: "IDR A",
      openingBalance: "100000",
    })
    const idrB = await makeAccount(owner, {
      name: "IDR B",
      accountType: "E_WALLET",
      openingBalance: "50000",
    })
    const usd = await makeAccount(owner, {
      name: "USD",
      currency: "USD",
      openingBalance: "10000",
    })

    const result = await runBatch(owner, [
      { accountId: idrA.id, actualBalance: "70000" }, // -30000
      { accountId: idrB.id, actualBalance: "80000" }, // +30000 -> nets to 0
      { accountId: usd.id, actualBalance: "12500" }, // +2500 USD
    ])

    expect(result.unrecordedByCurrency).toEqual([
      { currency: "IDR", delta: "0" },
      { currency: "USD", delta: "2500" },
    ])
  })

  test("a credit card is asserted as the amount OWED and moves in net-worth terms", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const card = await makeAccount(owner, {
      name: "Card",
      accountType: "CREDIT",
      openingBalance: "300000",
    })

    const result = await runBatch(owner, [
      { accountId: card.id, actualBalance: "500000" },
    ])

    expect(result.results[0]).toMatchObject({
      before: "-300000",
      after: "-500000",
      delta: "-200000",
      matchesActual: true,
    })
    expect(await balanceOf(owner, card.id)).toBe(-500000n)
  })

  test("reports matchesActual=false when same-day transactions are counted on top of the anchor (ADR-0043 date-only segmentation)", async () => {
    // KNOWN LIMITATION, pinned so it cannot regress silently: a ground-truth
    // anchor is date-only (`t.date > valuationDate`), so a transaction dated
    // LATER ON THE ANCHOR'S OWN calendar day is post-anchor flow even if it was
    // recorded before the check. Pit Stop reports the truth (`after`) and flags
    // it instead of hiding it. If ADR-0043's segmentation is refined to be
    // instant-aware, this test should flip to `matchesActual: true`.
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, { openingBalance: "150000" })
    await createTransactionForFamily({
      data: {
        type: "expense",
        amount: "50000",
        description: "Lunch",
        accountId: bank.id,
        date: new Date(),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const result = await runBatch(owner, [
      { accountId: bank.id, actualBalance: "100000" },
    ])

    expect(result.results[0]).toMatchObject({
      before: "100000",
      delta: "0",
      after: "50000",
      matchesActual: false,
    })
  })

  test("rejects duplicate accounts, empty batches and a future as-of date at the schema", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner)
    const entry = { accountId: bank.id, actualBalance: "1000" }

    await expect(runBatch(owner, [entry, entry])).rejects.toThrow(/once/i)
    await expect(runBatch(owner, [])).rejects.toThrow()
    await expect(
      batchReconcileForFamily({
        data: {
          idempotencyKey: factories.createIdempotencyKey(),
          entries: [entry],
          valuationDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/future/i)
    expect(await pitStopAnchors(owner)).toHaveLength(0)
  })

  describe("listing", () => {
    test("lists only active transaction-flow cash-like accounts, with owners and the current user's person", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const bank = await makeAccount(owner, { name: "Bank" })
      await makeAccount(owner, { name: "Cash", accountType: "CASH" })
      await makeAccount(owner, { name: "Card", accountType: "CREDIT" })
      await makeInvestmentAccount(factories, owner, "Reksadana")
      const closed = await makeAccount(owner, { name: "Closed" })
      await harness.withFamily(owner.family.id, (tx) =>
        tx.account.update({
          where: { id: closed.id },
          data: { status: "closed", archivedAt: new Date() },
        })
      )
      const person = await harness.withFamily(owner.family.id, async (tx) => {
        const created = await tx.zakatPayer.create({
          data: {
            familyId: owner.family.id,
            displayName: "Hendri",
            linkedUserId: owner.user.id,
          },
        })
        await tx.account.update({
          where: { id: bank.id },
          data: { zakatPayerId: created.id },
        })
        return created
      })

      const overview = await listPitStopAccountsForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })

      expect(overview.accounts.map((a) => a.name)).toEqual([
        "Bank",
        "Card",
        "Cash",
      ])
      expect(overview.currentPersonId).toBe(person.id)
      expect(overview.people).toEqual([
        { id: person.id, displayName: "Hendri" },
      ])
      const listedBank = overview.accounts.find((a) => a.id === bank.id)
      expect(listedBank).toMatchObject({
        ownerPersonId: person.id,
        jointOwnerPersonId: null,
        balance: "150000",
        lastCheckedAt: null,
      })
    })

    test("currentPersonId is null when the user has no linked person, and another family is never listed", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const stranger = await factories.createAuthenticatedOnboardedUser()
      await makeAccount(owner, { name: "Mine" })
      await makeAccount(stranger, { name: "Theirs" })

      const overview = await listPitStopAccountsForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(overview.currentPersonId).toBeNull()
      expect(overview.accounts.map((a) => a.name)).toEqual(["Mine"])
    })
  })

  describe("capability gate (ledger:write)", () => {
    const addMember = async (familyId: string, role: FamilyRole) => {
      const user = await factories.createUser({ familyId })
      await factories.createFamilyMember({ familyId, userId: user.id, role })
      const authenticated = await factories.authenticateUser(user)
      return { request: authenticated.request, user }
    }

    test("a viewer is rejected by the middleware", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const bank = await makeAccount(owner)
      const viewer = await addMember(owner.family.id, "viewer")

      const outcome = await callServerFnAs(viewer, batchReconcileFn, {
        idempotencyKey: factories.createIdempotencyKey(),
        entries: [{ accountId: bank.id, actualBalance: "1000" }],
      })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("the gate must not let a viewer through")
      expect(isAuthError(outcome.error)).toBe(true)
      if (!(outcome.error instanceof AppError)) throw new Error("AppError")
      expect(outcome.error.code).toBe("FORBIDDEN")
    })

    test("a member (ledger:write) passes the gate", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const bank = await makeAccount(owner)
      const member = await addMember(owner.family.id, "member")

      const outcome = await callServerFnAs(member, batchReconcileFn, {
        idempotencyKey: factories.createIdempotencyKey(),
        entries: [{ accountId: bank.id, actualBalance: "1000" }],
      })
      expect(outcome.ok).toBe(true)
    })
  })
})
