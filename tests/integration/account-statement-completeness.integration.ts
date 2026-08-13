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
  createTransactionForFamily,
  findLedgerTransactionsForFamily,
} from "@/server/transactions"
import { applyFilters } from "@/lib/transaction-filters"
import {
  orderStatementRows,
  rangeCutoff,
  type AccountRange,
} from "@/lib/account-analytics"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-247 (TASK B) — per-account statement COMPLETENESS under the real client
// pipeline, on real Postgres. The creator reported that on an account detail
// page the range defaults to "3M" and clicking "All" still doesn't surface the
// most recent (heavily back-dated) entries during reconciliation. The lead
// could not reproduce a data-loss defect from code (no server LIMIT, "All"
// cutoff is null, applyFilters matches accountId OR toAccountId). This test
// proves that against real data: every back-dated row and both transfer
// directions ARE present once the range is "All". The actual surfaced problem
// was ORDER, not completeness — the per-account live query is unordered
// (TanStack DB is non-deterministic without orderBy), which is fixed by
// orderStatementRows (unit-tested in account-analytics.test.ts) and asserted
// here to confirm the pipeline yields a deterministic newest-first statement.
describe("account statement completeness (PER-247 TASK B)", () => {
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

  const makeAccount = (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      openingBalance?: string
    } = {}
  ) =>
    createAccountForFamily({
      data: {
        name: overrides.name ?? "Account",
        accountType: overrides.accountType ?? "DEPOSITORY",
        currency: "IDR",
        openingBalance: overrides.openingBalance ?? "1000000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const post = (
    owner: AuthenticatedOnboardedUser,
    data: {
      type: "expense" | "income" | "transfer"
      amount: bigint
      accountId: string
      toAccountId?: string
      description: string
      date: Date
    }
  ) =>
    createTransactionForFamily({
      data: { ...data, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      user: owner.user,
    })

  // The exact per-account client pipeline the detail page runs:
  //   applyFilters({accounts:[id]}) → rangeCutoff/isSameOrAfter → orderStatement.
  // isSameOrAfter mirrors the (route-local) helper in accounts.$accountId.tsx.
  const isSameOrAfter = (date: Date | string, cutoff: Date | null) =>
    !cutoff || new Date(date).getTime() >= cutoff.getTime()

  const accountStatement = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    range: AccountRange,
    now: Date
  ) => {
    const ledger = await harness.withFamily(owner.family.id, (tx) =>
      findLedgerTransactionsForFamily(tx, owner.family.id)
    )
    const perAccount = applyFilters(ledger, { accounts: [accountId] })
    const cutoff = rangeCutoff(range, now)
    const ranged = perAccount.filter((t) => isSameOrAfter(t.date, cutoff))
    return orderStatementRows(ranged)
  }

  test("'All' surfaces every back-dated row and both transfer directions", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "5000000",
    })
    const wallet = await makeAccount(owner, {
      name: "Wallet",
      accountType: "E_WALLET",
      openingBalance: "0",
    })
    const now = new Date("2026-08-12T10:00:00Z")

    // A heavily back-dated expense (dated ~6 months ago, recorded "today"),
    // exactly the reconciliation workflow the creator described.
    const backdated = await post(owner, {
      type: "expense",
      amount: 40_000n,
      accountId: bank.id,
      description: "Backdated groceries",
      date: new Date("2026-02-15T00:00:00Z"),
    })
    // A recent expense inside the 3M default window.
    const recent = await post(owner, {
      type: "expense",
      amount: 25_000n,
      accountId: bank.id,
      description: "Recent coffee",
      date: new Date("2026-08-01T00:00:00Z"),
    })
    // Transfer OUT of Bank (Bank is the source leg's accountId).
    const outgoing = await post(owner, {
      type: "transfer",
      amount: 100_000n,
      accountId: bank.id,
      toAccountId: wallet.id,
      description: "Top up wallet",
      date: new Date("2026-07-20T00:00:00Z"),
    })
    // Transfer INTO Bank (Bank is toAccountId; the surfaced outflow leg's
    // accountId is Wallet — must still appear via the toAccountId clause).
    const incoming = await post(owner, {
      type: "transfer",
      amount: 30_000n,
      accountId: wallet.id,
      toAccountId: bank.id,
      description: "Wallet back to Bank",
      date: new Date("2026-07-25T00:00:00Z"),
    })

    const all = await accountStatement(owner, bank.id, "ALL", now)
    const ids = new Set(all.map((t) => t.id))

    // Completeness: nothing is dropped by the pipeline under "All".
    expect(ids.has(backdated.id)).toBe(true)
    expect(ids.has(recent.id)).toBe(true)
    expect(ids.has(outgoing.id)).toBe(true)
    // The incoming transfer surfaces as its single outflow leg (PER-202).
    expect(ids.has(incoming.id)).toBe(true)
    expect(all).toHaveLength(4)

    // Deterministic newest-date-first order (the fix for "doesn't surface
    // recent"): Recent(Aug 1) → Wallet→Bank(Jul 25) → Bank→Wallet(Jul 20) →
    // Backdated(Feb 15).
    expect(all.map((t) => t.id)).toEqual([
      recent.id,
      incoming.id,
      outgoing.id,
      backdated.id,
    ])
  })

  test("the back-dated row is hidden by the default 3M range, revealed by 'All'", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, { name: "Bank" })
    const now = new Date("2026-08-12T10:00:00Z")

    const backdated = await post(owner, {
      type: "expense",
      amount: 40_000n,
      accountId: bank.id,
      description: "Backdated (Feb)",
      date: new Date("2026-02-15T00:00:00Z"),
    })
    const recent = await post(owner, {
      type: "expense",
      amount: 25_000n,
      accountId: bank.id,
      description: "Recent (Aug)",
      date: new Date("2026-08-01T00:00:00Z"),
    })

    // 3M window (cutoff ~ 2026-05-12) excludes the Feb entry — expected, and
    // the reason the creator must switch to "All" to reconcile old postings.
    const threeMonths = await accountStatement(owner, bank.id, "3M", now)
    expect(threeMonths.map((t) => t.id)).toEqual([recent.id])

    // "All" reveals it — completeness holds, the range was the only filter.
    const all = await accountStatement(owner, bank.id, "ALL", now)
    expect(new Set(all.map((t) => t.id))).toEqual(
      new Set([recent.id, backdated.id])
    )
  })
})
