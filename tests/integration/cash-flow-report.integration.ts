import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { convertMinor, encodeRate } from "@/lib/fx"
import { upsertFxRateSnapshotForFamily } from "@/server/fx"
import {
  getCashFlowReportForFamily,
  type CashFlowReportResult,
} from "@/server/reporting"
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

// PER-155 / R2 — Real-Postgres proof of the cash-flow contract over rows written
// by the REAL ledger path (`createTransactionForFamily`): transfers excluded by
// `type` while liability interest/fee stay counted as finance-cost expenses,
// split attribution per child, multi-currency via the frozen `baseAmount`
// projection (stable as later rates arrive), FX-pending exclusion+flag, and RLS
// tenant isolation.

const FROM = "2026-06-01"
const TO = "2026-06-30"
const ON = (d = "2026-06-15") => new Date(`${d}T03:00:00.000Z`)

describe("cash-flow report (PER-155 / R2)", () => {
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

  // ---- helpers ---------------------------------------------------------------

  const setFamilyDefaults = (
    owner: AuthenticatedOnboardedUser,
    currency: string,
    timezone: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.family.update({
        where: { id: owner.family.id },
        data: { currency, timezone },
      })
    )

  // Seed a generous opening balance with the correct normal-balance sign
  // (ASSET >= 0, LIABILITY <= 0) so posting flow/transfers never trips the
  // account_normal_balance_sign CHECK.
  const account = (
    owner: AuthenticatedOnboardedUser,
    name: string,
    accountType: AccountType = "DEPOSITORY",
    currency = "IDR"
  ) => {
    const isLiability = accountType === "CREDIT" || accountType === "LOAN"
    return factories.createAccount({
      familyId: owner.family.id,
      name,
      accountType,
      currency,
      balance: isLiability ? -100_000_000n : 100_000_000n,
    })
  }

  const create = (
    owner: AuthenticatedOnboardedUser,
    data: Omit<
      Parameters<typeof createTransactionForFamily>[0]["data"],
      "idempotencyKey"
    >
  ) =>
    createTransactionForFamily({
      data: { idempotencyKey: factories.createIdempotencyKey(), ...data },
      familyId: owner.family.id,
      user: owner.user,
    })

  const seedRate = (
    owner: AuthenticatedOnboardedUser,
    fromCurrency: string,
    rate: string,
    asOfDate: string
  ) =>
    upsertFxRateSnapshotForFamily({
      data: { fromCurrency, toCurrency: "IDR", rate, asOfDate, source: "seed" },
      familyId: owner.family.id,
      user: owner.user,
    })

  const report = (
    owner: AuthenticatedOnboardedUser,
    userId = owner.user.id
  ): Promise<CashFlowReportResult> =>
    getCashFlowReportForFamily({
      data: { from: FROM, to: TO, interval: "month" },
      familyId: owner.family.id,
      userId,
    })

  const cat = (r: CashFlowReportResult, id: string | null) =>
    r.byCategory.find((g) => g.categoryId === id)
  const merch = (r: CashFlowReportResult, id: string | null) =>
    r.byMerchant.find((g) => g.merchantId === id)

  // ---- aggregation + grouping ------------------------------------------------

  test("aggregates income vs expense and groups by category and merchant", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })
    const salary = await factories.createCategory({
      familyId: owner.family.id,
      type: "income",
      name: "Salary",
    })
    const store = await factories.createMerchant({
      familyId: owner.family.id,
      name: "Store",
    })

    await create(owner, {
      type: "expense",
      amount: 50_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: food.id,
      merchantId: store.id,
      description: "groceries",
      date: ON(),
    })
    await create(owner, {
      type: "income",
      amount: 200_000n,
      currency: "IDR",
      accountId: wallet.id,
      categoryId: salary.id,
      description: "payday",
      date: ON(),
    })

    const r = await report(owner)
    expect(r.baseCurrency).toBe("IDR")
    expect(r.totals.income).toBe("200000")
    expect(r.totals.expense).toBe("50000")
    expect(r.totals.net).toBe("150000")
    expect(cat(r, food.id)?.expense).toBe("50000")
    expect(cat(r, salary.id)?.income).toBe("200000")
    expect(merch(r, store.id)?.expense).toBe("50000")
    // the income row had no merchant => no-merchant line
    expect(merch(r, null)?.income).toBe("200000")
  })

  // ---- transfer exclusion vs liability-cost retention (the core invariant) ----

  test("excludes transfers but keeps liability interest/fee as expenses", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const a = await account(owner, "Checking")
    const b = await account(owner, "Savings")
    const card = await account(owner, "Card", "CREDIT")

    // Pure money movement: asset->asset transfer (funds_movement). Excluded.
    await create(owner, {
      type: "transfer",
      amount: 100_000n,
      currency: "IDR",
      accountId: a.id,
      toAccountId: b.id,
      description: "move to savings",
      date: ON(),
    })
    // Credit-card principal payment (cc_payment, kind derived). Excluded.
    await create(owner, {
      type: "transfer",
      amount: 40_000n,
      currency: "IDR",
      accountId: a.id,
      toAccountId: card.id,
      description: "card payment",
      date: ON(),
    })
    // Finance costs: liability interest + fee ARE real expenses. Counted.
    await create(owner, {
      type: "expense",
      kind: "liability_interest",
      amount: 7_000n,
      currency: "IDR",
      accountId: a.id,
      toAccountId: card.id,
      description: "card interest",
      date: ON(),
    })
    await create(owner, {
      type: "expense",
      kind: "liability_fee",
      amount: 3_000n,
      currency: "IDR",
      accountId: a.id,
      toAccountId: card.id,
      description: "late fee",
      date: ON(),
    })
    // Ordinary spending on the card. Counted.
    await create(owner, {
      type: "expense",
      amount: 50_000n,
      currency: "IDR",
      accountId: card.id,
      description: "dinner on card",
      date: ON(),
    })

    const r = await report(owner)
    // 7,000 interest + 3,000 fee + 50,000 spending; the two transfers excluded.
    expect(r.totals.expense).toBe("60000")
    expect(r.totals.income).toBe("0")
    expect(r.totals.net).toBe("-60000")
  })

  // ---- split attribution -----------------------------------------------------

  test("attributes split entries to their child categories and merchants", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const wallet = await account(owner, "Wallet")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })
    const fun = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Fun",
    })

    await create(owner, {
      type: "expense",
      amount: 100_000n,
      currency: "IDR",
      accountId: wallet.id,
      description: "split receipt",
      date: ON(),
      isSplit: true,
      splitEntries: [
        { description: "groceries", amount: 60_000n, categoryId: food.id },
        { description: "movie", amount: 40_000n, categoryId: fun.id },
      ],
    })

    const r = await report(owner)
    expect(cat(r, food.id)?.expense).toBe("60000")
    expect(cat(r, fun.id)?.expense).toBe("40000")
    expect(r.totals.expense).toBe("100000")
    // Parent category is null on a split; it must not double-count.
    expect(cat(r, null)).toBeUndefined()
  })

  // ---- multi-currency via frozen baseAmount, stable over time ----------------

  test("normalizes foreign rows via baseAmount; a later rate does not move history", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const usd = await account(owner, "USD wallet", "DEPOSITORY", "USD")
    const food = await factories.createCategory({
      familyId: owner.family.id,
      type: "expense",
      name: "Food",
    })
    await seedRate(owner, "USD", "16000", "2026-06-01")

    await create(owner, {
      type: "expense",
      amount: 1_000n, // 10.00 USD
      currency: "USD",
      accountId: usd.id,
      categoryId: food.id,
      description: "usd lunch",
      date: ON(),
    })

    const expected = (
      convertMinor(1_000n, "USD", "IDR", encodeRate("16000")) as bigint
    ).toString()

    const before = await report(owner)
    expect(before.totals.expense).toBe(expected)
    expect(before.totals.unconvertedCount).toBe(0)

    // A later-dated rate must NOT change the already-frozen historical value.
    await seedRate(owner, "USD", "17000", "2026-06-20")
    const after = await report(owner)
    expect(after.totals.expense).toBe(expected)
  })

  test("FX-pending foreign row is excluded from totals and flagged", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const usd = await account(owner, "USD wallet", "DEPOSITORY", "USD")
    // No USD rate seeded => baseAmount is null (FX-pending).
    await create(owner, {
      type: "expense",
      amount: 1_000n,
      currency: "USD",
      accountId: usd.id,
      description: "unconverted",
      date: ON(),
    })

    const r = await report(owner)
    expect(r.totals.expense).toBe("0") // excluded, not zeroed into the figure
    expect(r.totals.unconvertedCount).toBe(1)
    expect(r.series.some((b) => b.isPartial)).toBe(true)
  })

  // ---- tenant isolation ------------------------------------------------------

  test("a non-member reading the family sees an all-zero report", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerA, "IDR", "UTC")
    const wallet = await account(ownerA, "Wallet")
    await create(ownerA, {
      type: "expense",
      amount: 50_000n,
      currency: "IDR",
      accountId: wallet.id,
      description: "groceries",
      date: ON(),
    })
    const ownerB = await factories.createAuthenticatedOnboardedUser()

    const leaked = await report(ownerA, ownerB.user.id)
    expect(leaked.totals.income).toBe("0")
    expect(leaked.totals.expense).toBe("0")
    expect(leaked.byCategory).toHaveLength(0)
    expect(leaked.byMerchant).toHaveLength(0)
  })

  test("family B's report reflects only B's ledger", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerA, "IDR", "UTC")
    const aWallet = await account(ownerA, "A wallet")
    await create(ownerA, {
      type: "expense",
      amount: 99_999n,
      currency: "IDR",
      accountId: aWallet.id,
      description: "A spend",
      date: ON(),
    })

    const ownerB = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerB, "IDR", "UTC")
    const bWallet = await account(ownerB, "B wallet")
    await create(ownerB, {
      type: "income",
      amount: 42_000n,
      currency: "IDR",
      accountId: bWallet.id,
      description: "B income",
      date: ON(),
    })

    const r = await report(ownerB)
    expect(r.totals.income).toBe("42000")
    expect(r.totals.expense).toBe("0")
  })
})
