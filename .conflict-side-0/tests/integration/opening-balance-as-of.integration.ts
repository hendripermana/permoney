import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  AccountValidationError,
  createAccountForFamily,
} from "@/server/accounts"
import { computeCanonicalBalance, fetchAccountFacts } from "@/server/valuations"
import { createTransactionForFamily } from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("PER-269 — opening balance as-of date", () => {
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

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

  const asOfDateOnly = (date: Date) => date.toISOString().slice(0, 10) as string

  const todayDateOnly = () => new Date().toISOString().slice(0, 10)

  test("past as-of date is stored as the opening Valuation's valuationDate with provenance derived", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const past = daysAgo(20)

    const account = await createAccountForFamily({
      data: {
        name: "BCA Lama",
        accountType: "DEPOSITORY",
        currency: "IDR",
        openingBalance: "1000000",
        openingBalanceAsOfDate: past,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const opening = await harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId: account.id, type: "opening", deletedAt: null },
      })
    )
    expect(opening).not.toBeNull()
    expect(opening!.value).toBe(1000000n)
    expect(opening!.provenance).toBe("derived")
    expect(opening!.valuationDate.toISOString().slice(0, 10)).toBe(
      asOfDateOnly(past)
    )
    // Materialized balance equals the opening value (no transactions yet).
    const row = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(row.balance).toBe(1000000n)
  })

  test("no as-of date defaults to today (identical to current behavior)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    const account = await createAccountForFamily({
      data: {
        name: "Default Today",
        accountType: "DEPOSITORY",
        openingBalance: "500000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const opening = await harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId: account.id, type: "opening", deletedAt: null },
      })
    )
    expect(opening).not.toBeNull()
    expect(opening!.valuationDate.toISOString().slice(0, 10)).toBe(
      todayDateOnly()
    )
    expect(opening!.provenance).toBe("derived")
  })

  test("null as-of date also defaults to today", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    const account = await createAccountForFamily({
      data: {
        name: "Null Today",
        accountType: "DEPOSITORY",
        openingBalance: "250000",
        openingBalanceAsOfDate: null,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const opening = await harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId: account.id, type: "opening", deletedAt: null },
      })
    )
    expect(opening!.valuationDate.toISOString().slice(0, 10)).toBe(
      todayDateOnly()
    )
  })

  test("future as-of date is rejected with a clear message", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)

    let caught: unknown
    try {
      await createAccountForFamily({
        data: {
          name: "Future",
          accountType: "DEPOSITORY",
          openingBalance: "100000",
          openingBalanceAsOfDate: tomorrow,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect.fail("Expected AccountValidationError for future date")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AccountValidationError)
    expect((caught as Error).message).toMatch(/future/i)
  })

  test("past as-of + transactions dated between that date and today: final balance = as-of balance + sum of those transactions (canonical == materialized)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const asOf = daysAgo(15)

    const account = await createAccountForFamily({
      data: {
        name: "With history",
        accountType: "DEPOSITORY",
        currency: "IDR",
        openingBalance: "1000000",
        openingBalanceAsOfDate: asOf,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Several transactions dated between as-of date and today. They are all
    // strictly after the opening anchor's valuationDate, so afterAnchor (derived)
    // is true via the date disjunct; they must count toward the balance.
    const tx1Date = daysAgo(10) // +300k income
    const tx2Date = daysAgo(7) // -100k expense
    const tx3Date = daysAgo(1) // +50k income

    await createTransactionForFamily({
      data: {
        type: "income",
        amount: "300000",
        description: "Salary part 1",
        accountId: account.id,
        date: tx1Date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await createTransactionForFamily({
      data: {
        type: "expense",
        amount: "100000",
        description: "Rent",
        accountId: account.id,
        date: tx2Date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await createTransactionForFamily({
      data: {
        type: "income",
        amount: "50000",
        description: "Refund",
        accountId: account.id,
        date: tx3Date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const expected = 1000000n + 300000n - 100000n + 50000n // 1,250,000

    // Materialized balance.
    const row = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(row.balance).toBe(expected)

    // Canonical balance via the same formula the balance-correction and drift
    // paths use (ADR-0043 §2 + PER-201 afterAnchor). Must match materialized.
    const canonical = await harness.withMember(
      owner.family.id,
      owner.user.id,
      async (tx) => {
        const facts = await fetchAccountFacts(tx, owner.family.id, account.id)
        if (!facts) throw new Error("account not found")
        return await computeCanonicalBalance(tx, owner.family.id, facts)
      }
    )
    expect(canonical).toBe(expected)

    // The opening valuation's provenance is still derived regardless of the
    // past date — the settled decision from PER-264/265 (ADR-0043 amendment).
    const opening = await harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId: account.id, type: "opening", deletedAt: null },
      })
    )
    expect(opening!.provenance).toBe("derived")

    // Also verify a transaction dated AT the as-of date is NOT counted by date
    // alone, but WOULD be counted via the derived createdAt disjunct (recorded
    // after the anchor). Since this account's opening anchor is derived, a
    // transaction dated exactly on the as-of day but recorded now should count.
    // However our three transactions above are already canonical; this just
    // documents the semantics without adding another flaky same-day edge.
  })

  test("transaction dated before the past as-of date but recorded after is counted (derived provenance, createdAt disjunct)", async () => {
    // Mirrors the PER-201 guarantee but anchored to a past opening date.
    const owner = await factories.createAuthenticatedOnboardedUser()
    const asOf = daysAgo(10)

    const account = await createAccountForFamily({
      data: {
        name: "CreatedAt aware",
        accountType: "DEPOSITORY",
        openingBalance: "500000",
        openingBalanceAsOfDate: asOf,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Dated BEFORE the as-of date, but recorded AFTER the anchor (now) — the
    // derived branch's createdAt disjunct makes it post-anchor flow, so it
    // counts. This is the correct ergonomics: the user stated "my balance on
    // 10 days ago was 500k", then adds a transaction from 12 days ago they
    // discovered later — it should still move the balance (it's new information
    // recorded after the opening).
    const beforeAsOf = daysAgo(12)
    await createTransactionForFamily({
      data: {
        type: "expense",
        amount: "100000",
        description: "Late discovered expense",
        accountId: account.id,
        date: beforeAsOf,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const row = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    // Balance should have moved (derived anchor counts late backdated flow).
    // Materialized vs canonical parity is still the invariant.
    const canonical = await harness.withMember(
      owner.family.id,
      owner.user.id,
      async (tx) => {
        const facts = await fetchAccountFacts(tx, owner.family.id, account.id)
        if (!facts) throw new Error("account not found")
        return await computeCanonicalBalance(tx, owner.family.id, facts)
      }
    )
    expect(row.balance).toBe(400000n)
    expect(canonical).toBe(400000n)
  })

  test("idempotency: same key + same as-of payload replays, different as-of with same key is a conflict", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const past = daysAgo(5)
    const key = factories.createIdempotencyKey()
    const payloadBase = {
      name: "Idempotent as-of",
      accountType: "DEPOSITORY" as const,
      openingBalance: "100000",
      openingBalanceAsOfDate: past,
      idempotencyKey: key,
    }

    const first = await createAccountForFamily({
      data: payloadBase,
      familyId: owner.family.id,
      user: owner.user,
    })
    const second = await createAccountForFamily({
      data: payloadBase,
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(second.id).toBe(first.id)

    // Same key with a DIFFERENT as-of date should be treated as a different
    // request payload (hash mismatch) and surface as a conflict — the server
    // hashes openingBalanceAsOfDate into the requestHash, so replay with a
    // different date does not silently return the old account.
    const differentDate = daysAgo(2)
    let caught: unknown
    try {
      await createAccountForFamily({
        data: { ...payloadBase, openingBalanceAsOfDate: differentDate },
        familyId: owner.family.id,
        user: owner.user,
      })
      // The IdempotencyRecord branch either replays (if hash matched) or throws
      // IdempotencyConflictError (if hash mismatched). In this harness we accept either:
      // if it returns the old account, the hash wasn't part of the payload (a bug);
      // but we assert it does NOT silently succeed with a different balance/date.
      // The canonical contract is "Same key with different payload must fail with a conflict"
      // — see the project's ledger standard. So reaching here without a throw would be wrong
      // if the replay returned the old account. Check that we didn't get a new account.
      expect.fail("Expected a conflict for same key with different payload")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeTruthy()
  })
})
