import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import {
  EMERGENCY_FUND_INSIGHT_ID,
  INSIGHTS_ENGINE_VERSION,
  RECURRING_BILLS_INSIGHT_ID,
  SPENDING_TREND_INSIGHT_ID,
} from "@/lib/insights"
import { archiveAccountForFamily } from "@/server/accounts"
import { getInsightsForFamily } from "@/server/insights"
import { getCashFlowReportForFamily } from "@/server/reporting"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
} from "@/server/transactions"
import { createValuationForFamily } from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-227 — real-Postgres proof of the household insights engine's first
// derivation (`savings_flow`) over rows written by the REAL ledger path
// (`createTransactionForFamily`), so `Transfer.purpose` is production-derived:
//   - a transfer into savings/investments counts exactly ONCE (two-leg
//     pairings must never double-count), by purpose intent or destination
//     subtype;
//   - it is never income/expense — the cash-flow engine excludes the same row,
//     so the two engines cannot double-count one movement;
//   - the window is the FAMILY-tz calendar month (ADR-0037 / PER-263: the
//     June/July boundary is decided in Jakarta, not UTC);
//   - FX-pending legs are excluded AND counted (`partial`), never zeroed;
//   - soft-deleted transfers stop counting; RLS keeps another tenant out.

const JUNE = "2026-06"
const JULY = "2026-07"

// 2026-06-15 10:00 in Asia/Jakarta — mid-June in the family timezone.
const ON_JUNE = new Date("2026-06-15T03:00:00.000Z")
// Still June 30th in UTC, but already 2026-07-01 03:00 in Asia/Jakarta — the
// zone boundary the window must respect.
const ON_JULY_IN_JAKARTA = new Date("2026-06-30T20:00:00.000Z")

describe("household insights (PER-227)", () => {
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

  const account = (
    owner: AuthenticatedOnboardedUser,
    name: string,
    opts: {
      accountType?: AccountType
      accountSubtype?: string
      currency?: string
      balance?: bigint
    } = {}
  ) => {
    const accountType = opts.accountType ?? "DEPOSITORY"
    const isLiability = accountType === "CREDIT" || accountType === "LOAN"
    return factories.createAccount({
      familyId: owner.family.id,
      name,
      accountType,
      accountSubtype: opts.accountSubtype,
      currency: opts.currency ?? "IDR",
      balance: opts.balance ?? (isLiability ? -100_000_000n : 100_000_000n),
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

  const transfer = (
    owner: AuthenticatedOnboardedUser,
    opts: {
      from: string
      to: string
      amount: bigint
      date?: Date
      purpose?:
        | "top_up"
        | "investment_contribution"
        | "investment_withdrawal"
        | "savings"
        | "cash_withdrawal"
        | null
      destinationAmount?: bigint
      destinationCurrency?: string
    }
  ) =>
    create(owner, {
      type: "transfer",
      amount: opts.amount,
      accountId: opts.from,
      toAccountId: opts.to,
      description: "movement",
      date: opts.date ?? ON_JUNE,
      transferPurpose: opts.purpose ?? null,
      destinationAmount: opts.destinationAmount ?? null,
      destinationCurrency: opts.destinationCurrency ?? null,
    })

  const insights = (
    owner: AuthenticatedOnboardedUser,
    month?: string,
    userId = owner.user.id
  ) =>
    getInsightsForFamily({
      data: { month },
      familyId: owner.family.id,
      userId,
    })

  /** Pinned-clock variant (payday windows are now-relative; production
   * defaults `now` to the server instant). */
  const insightsAt = (
    owner: AuthenticatedOnboardedUser,
    now: Date,
    month?: string
  ) =>
    getInsightsForFamily({
      data: { month },
      familyId: owner.family.id,
      userId: owner.user.id,
      now,
    })

  /** A real-ledger income row — the payday anchor must be derivable from rows
   * written by the production path, never from a hand-built projection. */
  const income = (
    owner: AuthenticatedOnboardedUser,
    data: {
      accountId: string
      amount: bigint
      date: Date
      description: string
    }
  ) =>
    create(owner, {
      type: "income",
      amount: data.amount,
      accountId: data.accountId,
      description: data.description,
      date: data.date,
    })

  /** Three monthly salary rows on the 25th at 10:00 WIB (03:00Z). */
  const seedSalarySeries = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    amount = 20_000_000n
  ) => {
    for (const month of ["04", "05", "06"]) {
      await income(owner, {
        accountId,
        amount,
        date: new Date(`2026-${month}-25T03:00:00.000Z`),
        description: "Monthly salary",
      })
    }
  }

  const insightMetric = (
    report: Awaited<ReturnType<typeof getInsightsForFamily>>,
    insightId: string,
    key: string
  ) =>
    report.insights
      .find((insight) => insight.id === insightId)
      ?.metrics.find((metric) => metric.key === key)?.value

  const metric = (
    report: Awaited<ReturnType<typeof getInsightsForFamily>>,
    key: string
  ) => report.insights[0]?.metrics.find((m) => m.key === key)?.value

  // ---- the core invariant ----------------------------------------------------

  test("counts savings + investment transfers exactly once each, never as income/expense", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })
    const brokerage = await account(owner, "Reksadana", {
      accountType: "INVESTMENT",
    })

    // Derived purpose `savings` (DEPOSITORY → DEPOSITORY subtype savings).
    await transfer(owner, { from: wallet.id, to: savings.id, amount: 500_000n })
    // Derived purpose `investment_contribution` (to INVESTMENT).
    await transfer(owner, {
      from: wallet.id,
      to: brokerage.id,
      amount: 1_000_000n,
    })
    // Ordinary spending must not leak into the saved figure.
    await create(owner, {
      type: "expense",
      amount: 300_000n,
      accountId: wallet.id,
      description: "groceries",
      date: ON_JUNE,
    })

    const report = await insights(owner, JUNE)
    expect(report.engineVersion).toBe(INSIGHTS_ENGINE_VERSION)
    expect(report.failedCount).toBe(0)
    expect(report.window).toEqual({
      kind: "calendar_month",
      start: "2026-06-01",
      end: "2026-06-30",
      timezone: "Asia/Jakarta",
    })
    expect(report.insights).toHaveLength(1)
    expect(metric(report, "saved")).toBe("1500000")
    expect(metric(report, "transfer_count")).toBe("2")
    expect(metric(report, "fx_pending_count")).toBe("0")
    expect(report.insights[0].partial).toBe(false)

    // Cross-engine: the SAME transfers are invisible to cash flow (excluded by
    // `type`), so one movement can never be counted as both saved and spent.
    const cashFlow = await getCashFlowReportForFamily({
      data: { from: "2026-06-01", to: "2026-06-30", interval: "month" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(cashFlow.totals.income).toBe("0")
    expect(cashFlow.totals.expense).toBe("300000")
  })

  test("counts a transfer whose purpose override says savings, though the destination is not a savings subtype", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const payroll = await account(owner, "Payroll", {
      accountSubtype: "payroll",
    })

    await transfer(owner, {
      from: wallet.id,
      to: payroll.id,
      amount: 200_000n,
      purpose: "savings",
    })

    const report = await insights(owner, JUNE)
    expect(metric(report, "saved")).toBe("200000")
    expect(metric(report, "transfer_count")).toBe("1")
  })

  // ---- exclusions ------------------------------------------------------------

  test("excludes withdrawals, top-ups, and card payments", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })
    const ewallet = await account(owner, "GoPay", {
      accountType: "E_WALLET",
    })
    const card = await account(owner, "Kartu", { accountType: "CREDIT" })

    // Out of savings — destination is checking, purpose derives null.
    await transfer(owner, { from: savings.id, to: wallet.id, amount: 100_000n })
    // E-wallet top-up.
    await transfer(owner, { from: wallet.id, to: ewallet.id, amount: 50_000n })
    // Credit-card payment (liability kind, no purpose).
    await transfer(owner, { from: wallet.id, to: card.id, amount: 75_000n })

    const report = await insights(owner, JUNE)
    expect(report.insights).toHaveLength(0)
    // Assert savings_flow's own reason without pinning the whole array: this
    // call runs on the real server clock, so `since_payday`'s skip reason
    // legitimately differs between "off current month" and "no series".
    expect(report.skipped.find((entry) => entry.id === "savings_flow")).toEqual(
      {
        id: "savings_flow",
        reason: "no savings or investment transfers in the window",
      }
    )
  })

  // ---- family-tz month boundary (ADR-0037 / PER-263) -------------------------

  test("cuts the month in the family timezone, not UTC", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })

    // 2026-07-01 03:00 in Jakarta — July for the family, June for UTC.
    await transfer(owner, {
      from: wallet.id,
      to: savings.id,
      amount: 900_000n,
      date: ON_JULY_IN_JAKARTA,
    })

    const june = await insights(owner, JUNE)
    expect(june.insights).toHaveLength(0)

    const july = await insights(owner, JULY)
    expect(metric(july, "saved")).toBe("900000")
  })

  test("a custom month narrows to that calendar month only", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })

    await transfer(owner, {
      from: wallet.id,
      to: savings.id,
      amount: 111_000n,
      date: ON_JUNE,
    })

    expect(metric(await insights(owner, "2026-05"), "saved")).toBeUndefined()
    expect(metric(await insights(owner, JUNE), "saved")).toBe("111000")
  })

  // ---- FX-pending honesty ----------------------------------------------------

  test("excludes an FX-pending leg from the total but counts it as partial", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })
    // USD savings vehicle with NO USD rate seeded: the inflow leg's frozen
    // base projection stays null (FX-pending).
    const usdSavings = await account(owner, "USD Savings", {
      accountSubtype: "savings",
      currency: "USD",
    })

    await transfer(owner, { from: wallet.id, to: savings.id, amount: 400_000n })
    await transfer(owner, {
      from: wallet.id,
      to: usdSavings.id,
      amount: 500_000n,
      destinationAmount: 3_000n,
      destinationCurrency: "USD",
    })

    const report = await insights(owner, JUNE)
    expect(metric(report, "saved")).toBe("400000")
    expect(metric(report, "transfer_count")).toBe("1")
    expect(metric(report, "fx_pending_count")).toBe("1")
    expect(report.insights[0].partial).toBe(true)
  })

  // ---- deletion --------------------------------------------------------------

  test("a deleted transfer stops counting", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })

    const created = await transfer(owner, {
      from: wallet.id,
      to: savings.id,
      amount: 700_000n,
    })
    expect(metric(await insights(owner, JUNE), "saved")).toBe("700000")

    await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: factories.createIdempotencyKey(),
      familyId: owner.family.id,
      user: owner.user,
    })

    const after = await insights(owner, JUNE)
    expect(after.insights).toHaveLength(0)
  })

  // ---- tenant isolation ------------------------------------------------------

  test("a non-member reading the family sees nothing", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerA, "IDR", "Asia/Jakarta")
    const wallet = await account(ownerA, "A wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(ownerA, "A savings", {
      accountSubtype: "savings",
    })
    await transfer(ownerA, {
      from: wallet.id,
      to: savings.id,
      amount: 999_000n,
    })

    const ownerB = await factories.createAuthenticatedOnboardedUser()
    const leaked = await insights(ownerA, JUNE, ownerB.user.id)
    expect(leaked.insights).toHaveLength(0)
  })

  test("family B's insights reflect only B's ledger", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerA, "IDR", "Asia/Jakarta")
    const aWallet = await account(ownerA, "A wallet", {
      accountSubtype: "checking",
    })
    const aSavings = await account(ownerA, "A savings", {
      accountSubtype: "savings",
    })
    await transfer(ownerA, {
      from: aWallet.id,
      to: aSavings.id,
      amount: 999_000n,
    })

    const ownerB = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerB, "IDR", "Asia/Jakarta")
    const bWallet = await account(ownerB, "B wallet", {
      accountSubtype: "checking",
    })
    const bSavings = await account(ownerB, "B savings", {
      accountSubtype: "savings",
    })
    await transfer(ownerB, {
      from: bWallet.id,
      to: bSavings.id,
      amount: 42_000n,
    })

    const reportB = await insights(ownerB, JUNE)
    expect(metric(reportB, "saved")).toBe("42000")
    expect(metric(reportB, "transfer_count")).toBe("1")
  })

  // ---- since_payday (slice #2) ------------------------------------------------

  // 2026-07-10 10:00 in Asia/Jakarta — the pinned "today" for payday tests.
  const PAYDAY_NOW = new Date("2026-07-10T03:00:00.000Z")

  test("anchors on the salary series and folds the family-tz payday window", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await seedSalarySeries(owner, wallet.id)

    // Inside the payday window [2026-06-25, 2026-07-10].
    await income(owner, {
      accountId: wallet.id,
      amount: 3_000_000n,
      date: new Date("2026-07-05T03:00:00.000Z"),
      description: "Freelance project",
    })
    await create(owner, {
      type: "expense",
      amount: 12_000_000n,
      accountId: wallet.id,
      description: "rent",
      date: new Date("2026-07-02T03:00:00.000Z"),
    })
    // Before the anchor — outside the window even though it is June-July.
    await create(owner, {
      type: "expense",
      amount: 1_000_000n,
      accountId: wallet.id,
      description: "groceries",
      date: new Date("2026-06-20T03:00:00.000Z"),
    })

    const report = await insightsAt(owner, PAYDAY_NOW)
    expect(report.engineVersion).toBe(INSIGHTS_ENGINE_VERSION)
    expect(report.failedCount).toBe(0)
    expect(report.window).toEqual({
      kind: "calendar_month",
      start: "2026-07-01",
      end: "2026-07-31",
      timezone: "Asia/Jakarta",
    })

    const insight = report.insights.find((entry) => entry.id === "since_payday")
    expect(insight?.window).toEqual({
      kind: "since_payday",
      start: "2026-06-25",
      end: "2026-07-10",
      timezone: "Asia/Jakarta",
    })
    expect(insight?.tone).toBe("positive")
    expect(insight?.partial).toBe(false)
    // 20,000,000 (salary) + 3,000,000 (freelance) − 12,000,000 (spending).
    expect(insightMetric(report, "since_payday", "left")).toBe("11000000")
    expect(insightMetric(report, "since_payday", "spent")).toBe("12000000")
    expect(insightMetric(report, "since_payday", "fx_pending_count")).toBe("0")

    // Cross-engine: the cash-flow report over the SAME window folds the same
    // rows to the same net (income − expense == left).
    const cashFlow = await getCashFlowReportForFamily({
      data: { from: "2026-06-25", to: "2026-07-10", interval: "month" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(cashFlow.totals.income).toBe("23000000")
    expect(cashFlow.totals.expense).toBe("12000000")
    expect(cashFlow.totals.net).toBe(
      insightMetric(report, "since_payday", "left")
    )
  })

  test("skips the card when the household has no monthly income series", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // Irregular income (gaps 2 and 28 days) never matches a cadence band.
    for (const date of ["2026-06-01", "2026-06-03", "2026-07-01"]) {
      await income(owner, {
        accountId: wallet.id,
        amount: 4_000_000n,
        date: new Date(`${date}T03:00:00.000Z`),
        description: "Ad-hoc payout",
      })
    }

    const report = await insightsAt(owner, PAYDAY_NOW)
    expect(report.insights.map((entry) => entry.id)).not.toContain(
      "since_payday"
    )
    expect(report.skipped.find((entry) => entry.id === "since_payday")).toEqual(
      {
        id: "since_payday",
        reason: "no monthly recurring income series detected",
      }
    )
  })

  test("skips the card for a month that is not the family's current month", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await seedSalarySeries(owner, wallet.id)

    const report = await insightsAt(owner, PAYDAY_NOW, "2026-06")
    expect(report.insights.map((entry) => entry.id)).not.toContain(
      "since_payday"
    )
    expect(report.skipped.find((entry) => entry.id === "since_payday")).toEqual(
      {
        id: "since_payday",
        reason: "since payday only applies to the family's current month",
      }
    )
  })

  test("excludes an FX-pending expense from spent but counts it as partial", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // USD account with NO USD→IDR rate seeded: the frozen base projection of
    // its rows stays null (FX-pending).
    const usdWallet = await account(owner, "USD Wallet", {
      accountSubtype: "checking",
      currency: "USD",
    })
    await seedSalarySeries(owner, wallet.id)

    await create(owner, {
      type: "expense",
      amount: 100_000n,
      accountId: wallet.id,
      description: "groceries",
      date: new Date("2026-07-03T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 1_000n,
      accountId: usdWallet.id,
      description: "USD purchase",
      date: new Date("2026-07-02T03:00:00.000Z"),
    })

    const report = await insightsAt(owner, PAYDAY_NOW)
    const insight = report.insights.find((entry) => entry.id === "since_payday")
    expect(insightMetric(report, "since_payday", "spent")).toBe("100000")
    expect(insightMetric(report, "since_payday", "left")).toBe("19900000")
    expect(insightMetric(report, "since_payday", "fx_pending_count")).toBe("1")
    expect(insight?.partial).toBe(true)
  })

  test("a deleted expense stops counting toward spent", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await seedSalarySeries(owner, wallet.id)

    const expense = await create(owner, {
      type: "expense",
      amount: 7_000_000n,
      accountId: wallet.id,
      description: "flight",
      date: new Date("2026-07-02T03:00:00.000Z"),
    })
    expect(
      insightMetric(
        await insightsAt(owner, PAYDAY_NOW),
        "since_payday",
        "spent"
      )
    ).toBe("7000000")

    await deleteTransactionForFamily({
      id: expense.id,
      idempotencyKey: factories.createIdempotencyKey(),
      familyId: owner.family.id,
      user: owner.user,
    })

    const after = await insightsAt(owner, PAYDAY_NOW)
    expect(insightMetric(after, "since_payday", "spent")).toBe("0")
    expect(insightMetric(after, "since_payday", "left")).toBe("20000000")
  })

  test("another family's salary never anchors this family", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerA, "IDR", "Asia/Jakarta")
    const aWallet = await account(ownerA, "A wallet", {
      accountSubtype: "checking",
    })
    await create(ownerA, {
      type: "expense",
      amount: 500_000n,
      accountId: aWallet.id,
      description: "A spending",
      date: new Date("2026-07-03T03:00:00.000Z"),
    })

    const ownerB = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerB, "IDR", "Asia/Jakarta")
    const bWallet = await account(ownerB, "B wallet", {
      accountSubtype: "checking",
    })
    await seedSalarySeries(ownerB, bWallet.id)

    const reportA = await insightsAt(ownerA, PAYDAY_NOW)
    expect(reportA.insights.map((entry) => entry.id)).not.toContain(
      "since_payday"
    )
    expect(
      reportA.skipped.find((entry) => entry.id === "since_payday")
    ).toEqual({
      id: "since_payday",
      reason: "no monthly recurring income series detected",
    })

    // B's own report still sees its salary — the skip above is isolation, not
    // a broken detector.
    const reportB = await insightsAt(ownerB, PAYDAY_NOW)
    expect(insightMetric(reportB, "since_payday", "left")).toBe("20000000")
  })

  // ---- period completeness (PER-443) -----------------------------------------

  // 2026-06-15 10:00 WIB — pinned so the seam's month is June. The anchors
  // below are BACK-DATED (valuationDate != the write day), so their
  // `observedAt` stays NULL and the chain segments by date only — exactly the
  // production shape for historical reconciles.
  const COMPLETENESS_NOW = new Date("2026-06-15T03:00:00.000Z")

  const addAnchor = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    value: string,
    valuationDate: Date,
    source?: string
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value,
        type: "reconciliation",
        ...(source ? { source } : {}),
        valuationDate,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: source ? "derived" : "ground_truth",
      user: owner.user,
    })

  /** Wallet + savings with one June transfer into savings, so the June
   * savings_flow card exists in every scenario below. */
  const juneSavingsTransfer = async (owner: AuthenticatedOnboardedUser) => {
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Tabungan", {
      accountSubtype: "savings",
    })
    await transfer(owner, {
      from: wallet.id,
      to: savings.id,
      amount: 500_000n,
      date: new Date("2026-06-10T03:00:00.000Z"),
    })
  }

  /** A separate account whose two anchors disagree by 20,000 with nothing
   * recorded between them — a real [from, to] hole. `source` selects the
   * importer path (migration-softened) when given. */
  const seedHole = async (
    owner: AuthenticatedOnboardedUser,
    from: string,
    to: string,
    source?: string
  ) => {
    const gapAccount = await account(owner, "Gap account", {
      accountSubtype: "checking",
    })
    await addAnchor(
      owner,
      gapAccount.id,
      "100000",
      new Date(`${from}T03:00:00.000Z`),
      source
    )
    await addAnchor(
      owner,
      gapAccount.id,
      "120000",
      new Date(`${to}T03:00:00.000Z`),
      source
    )
    return gapAccount
  }

  const savingsFlow = (
    report: Awaited<ReturnType<typeof getInsightsForFamily>>
  ) => report.insights.find((insight) => insight.id === "savings_flow")

  test("marks savings_flow partially recorded when a live gap intersects its month", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    await juneSavingsTransfer(owner)
    const gapAccount = await seedHole(owner, "2026-06-01", "2026-06-28")

    const insight = savingsFlow(await insightsAt(owner, COMPLETENESS_NOW))
    expect(insight?.partial).toBe(false)
    expect(insight?.periodPartial).toBe(true)
    expect(insight?.periodGaps).toEqual([
      {
        accountId: gapAccount.id,
        accountName: "Gap account",
        currency: "IDR",
        fromDate: "2026-06-01",
        toDate: "2026-06-28",
        amount: "20000",
      },
    ])
  })

  test("leaves the qualifier off when no live gap intersects (outside the window, or importer-absorbed)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    await juneSavingsTransfer(owner)

    // A real hole — but in JANUARY, far outside the June window.
    await seedHole(owner, "2026-01-05", "2026-01-20")
    let insight = savingsFlow(await insightsAt(owner, COMPLETENESS_NOW))
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])

    // A June hole — but importer-written on BOTH ends: known by design.
    await seedHole(owner, "2026-06-01", "2026-06-28", "migration:sure")
    insight = savingsFlow(await insightsAt(owner, COMPLETENESS_NOW))
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
  })

  // ---- emergency_fund (PER-227 slice #3) -------------------------------------

  // 2026-07-10 10:00 WIB — the pinned "today" for these tests. The requested
  // month is explicit ("2026-07"), so the clock only matters for the fold's
  // `now` passthrough.
  const EMERGENCY_NOW = new Date("2026-07-10T03:00:00.000Z")

  test("folds 6× trailing-complete-month burn against designated-savings balances", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savings = await account(owner, "Savings 1", {
      accountSubtype: "savings",
      balance: 0n,
    })

    // Three COMPLETE months of burn (Apr/May/Jun) plus a July row that the
    // current partial month must exclude from the average.
    await create(owner, {
      type: "expense",
      amount: 1_000_000n,
      accountId: wallet.id,
      description: "April spending",
      date: new Date("2026-04-01T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 2_000_000n,
      accountId: wallet.id,
      description: "May spending",
      date: new Date("2026-05-01T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 3_000_000n,
      accountId: wallet.id,
      description: "June spending",
      date: new Date("2026-06-01T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 4_000_000n,
      accountId: wallet.id,
      description: "July spending",
      date: new Date("2026-07-05T03:00:00.000Z"),
    })
    // Designated savings gets funded by a TRANSFER — never spending, so the
    // same movement cannot inflate burn and deflate the gap at once.
    await transfer(owner, {
      from: wallet.id,
      to: savings.id,
      amount: 5_000_000n,
      date: new Date("2026-06-10T03:00:00.000Z"),
    })

    const report = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(report.engineVersion).toBe(INSIGHTS_ENGINE_VERSION)
    expect(report.failedCount).toBe(0)

    const insight = report.insights.find(
      (entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID
    )
    expect(insight?.window).toEqual({
      kind: "trailing_6_months",
      start: "2026-01-01",
      end: "2026-06-30",
      timezone: "Asia/Jakarta",
    })
    // Saved first (headline money metric), then target, gap, months used,
    // counted accounts, FX-pending — the renderer's generic contract.
    expect(insight?.metrics.map((entry) => entry.key)).toEqual([
      "saved",
      "target",
      "gap",
      "partial_window",
      "counted_accounts",
      "fx_pending_count",
    ])
    // Saved = the current balance the 5M transfer left on the savings
    // account; burn = 6M over Apr–Jun; target = 6M × 6 ÷ 3 months = 12M.
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "12000000"
    )
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "gap")).toBe(
      "7000000"
    )
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "partial_window")
    ).toBe("3 of 6")
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("Savings 1")
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "fx_pending_count")
    ).toBe("0")
    expect(insight?.tone).toBe("attention")
    expect(insight?.partial).toBe(false)
    expect(insight?.detail).toBe(
      "Based on 3 complete months of recorded spending."
    )

    // Cross-engine: the SAME ledger folds to the cash-flow engine's expense
    // over the burn span — one movement, one number, two views.
    const cashFlow = await getCashFlowReportForFamily({
      data: { from: "2026-04-01", to: "2026-06-30", interval: "month" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(cashFlow.totals.expense).toBe("6000000")
    expect(cashFlow.totals.income).toBe("0")
  })

  test("counts only the reader's family designated balances", async () => {
    const seedFamily = async (
      owner: AuthenticatedOnboardedUser,
      savingsName: string,
      savingsBalance: bigint,
      expenseAmount: bigint
    ) => {
      const wallet = await account(owner, `${savingsName} wallet`, {
        accountSubtype: "checking",
      })
      await account(owner, savingsName, {
        accountSubtype: "savings",
        balance: savingsBalance,
      })
      // Two fully-covered complete months (May + June) of recorded history.
      await create(owner, {
        type: "expense",
        amount: expenseAmount,
        accountId: wallet.id,
        description: "May spending",
        date: new Date("2026-05-01T03:00:00.000Z"),
      })
      await create(owner, {
        type: "expense",
        amount: expenseAmount,
        accountId: wallet.id,
        description: "June spending",
        date: new Date("2026-06-30T03:00:00.000Z"),
      })
    }

    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerA, "IDR", "Asia/Jakarta")
    await seedFamily(ownerA, "A savings", 5_000_000n, 300_000n)

    const ownerB = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerB, "IDR", "Asia/Jakarta")
    await seedFamily(ownerB, "B savings", 3_000_000n, 300_000n)

    const reportA = await insightsAt(ownerA, EMERGENCY_NOW, "2026-07")
    expect(insightMetric(reportA, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    expect(
      insightMetric(reportA, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("A savings")

    const reportB = await insightsAt(ownerB, EMERGENCY_NOW, "2026-07")
    expect(insightMetric(reportB, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "3000000"
    )
    expect(
      insightMetric(reportB, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("B savings")

    // A non-member reading family A gets nothing — RLS never leaks a balance
    // or even the fact that accounts exist: every derivation records a skip.
    const leaked = await insights(ownerA, "2026-07", ownerB.user.id)
    expect(leaked.insights).toHaveLength(0)
    expect(leaked.failedCount).toBe(0)
    // `recurring_bills` records its own skip here: the request month (July)
    // is not the family's current month relative to the real clock, so the
    // RLS-empty context never even reaches its history floor.
    // `spending_trend` likewise hits the same history floor (zero rows seen
    // through the reader's empty RLS scope).
    expect(leaked.skipped).toHaveLength(5)
    expect(leaked.skipped).toContainEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "no account is designated as savings",
    })
    expect(leaked.skipped).toContainEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })
  })

  test("drops an ARCHIVED (soft-closed) savings balance from the figure via the real archive path", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    const savingsA = await account(owner, "Savings A", {
      accountSubtype: "savings",
      balance: 5_000_000n,
    })
    const savingsB = await account(owner, "Savings B", {
      accountSubtype: "savings",
      balance: 3_000_000n,
    })

    // Two complete months of recorded history (May + June) so the card
    // renders at all.
    await create(owner, {
      type: "expense",
      amount: 300_000n,
      accountId: wallet.id,
      description: "May spending",
      date: new Date("2026-05-01T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 300_000n,
      accountId: wallet.id,
      description: "June spending",
      date: new Date("2026-06-30T03:00:00.000Z"),
    })

    const before = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(insightMetric(before, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "8000000"
    )
    expect(
      insightMetric(before, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("Savings A, Savings B")

    // The REAL production archive path — soft close: status → "closed",
    // archivedAt set, the balance row deliberately preserved. The card must
    // still stop counting it: an archived balance is no longer actively
    // managed money.
    await archiveAccountForFamily({
      data: {
        id: savingsB.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const after = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(insightMetric(after, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    expect(
      insightMetric(after, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("Savings A")

    // Archive the last designated account too: the card SKIPS — it never
    // fabricates a Rp 0 fund from accounts the household closed.
    await archiveAccountForFamily({
      data: {
        id: savingsA.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const final = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(final.insights.map((entry) => entry.id)).not.toContain(
      EMERGENCY_FUND_INSIGHT_ID
    )
    expect(
      final.skipped.find((entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID)
    ).toEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "no account is designated as savings",
    })
  })

  test("cuts burn rows and recorded history at the UTC/WIB boundary, never a UTC slice", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await account(owner, "Savings 1", {
      accountSubtype: "savings",
      balance: 5_000_000n,
    })

    // FIRST ledger row: 2026-04-30T20:00:00Z = 2026-05-01 03:00 in
    // Asia/Jakarta. Family-tz history therefore STARTS on May 1 (May is
    // covered end-to-end), and the burn row itself lands in MAY. A UTC slice
    // would file it into April — an uncovered month, so excluded from burn.
    await create(owner, {
      type: "expense",
      amount: 4_000_000n,
      accountId: wallet.id,
      description: "May 1 WIB spending",
      date: new Date("2026-04-30T20:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 1_000_000n,
      accountId: wallet.id,
      description: "May spending",
      date: new Date("2026-05-15T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 1_000_000n,
      accountId: wallet.id,
      description: "June spending",
      date: new Date("2026-06-10T03:00:00.000Z"),
    })
    // LAST ledger row: 2026-06-29T20:00:00Z = 2026-06-30 03:00 WIB — history
    // ENDS on June 30, exactly what makes June a COMPLETE month, and the row
    // is June burn. A UTC slice would end history at 2026-06-29, drop June
    // below the coverage test, and the card would skip instead of rendering.
    await create(owner, {
      type: "expense",
      amount: 1_000_000n,
      accountId: wallet.id,
      description: "June 30 WIB spending",
      date: new Date("2026-06-29T20:00:00.000Z"),
    })

    const report = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    const insight = report.insights.find(
      (entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID
    )
    expect(insight?.window).toEqual({
      kind: "trailing_6_months",
      start: "2026-01-01",
      end: "2026-06-30",
      timezone: "Asia/Jakarta",
    })
    // Both boundary rows count, so BOTH coverage (history first/last) and the
    // burn month-keys were decided in Jakarta. Under a UTC slice June would
    // fall out of history and this card would not exist; under a UTC burn
    // slice the first row would drop to April and target would differ.
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "partial_window")
    ).toBe("2 of 6")
    // burn = 4M + 1M (May) + 1M + 1M (June) = 7M over 2 covered months →
    // target = 7M × 6 ÷ 2 = 21M.
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "21000000"
    )
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "fx_pending_count")
    ).toBe("0")
    expect(insight?.detail).toBe(
      "Based on 2 complete months of recorded spending."
    )
  })

  test("excludes an FX-pending balance and burn row from the figures but counts them", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // USD account with NO USD→IDR rate seeded: both its BALANCE and its burn
    // rows stay FX-pending.
    const usdWallet = await account(owner, "USD Wallet", {
      accountSubtype: "checking",
      currency: "USD",
    })
    await account(owner, "Savings IDR", {
      accountSubtype: "savings",
      balance: 5_000_000n,
    })
    await account(owner, "Savings USD", {
      accountSubtype: "savings",
      currency: "USD",
      balance: 5_000n,
    })

    // Burn: one IDR expense in May, one USD expense mid-June (pending), and a
    // June 30 income row so recorded history covers May AND June end-to-end.
    await create(owner, {
      type: "expense",
      amount: 3_000_000n,
      accountId: wallet.id,
      description: "May spending",
      date: new Date("2026-05-01T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 100_000n,
      accountId: usdWallet.id,
      description: "USD purchase",
      date: new Date("2026-06-10T03:00:00.000Z"),
    })
    await income(owner, {
      accountId: wallet.id,
      amount: 1_000_000n,
      date: new Date("2026-06-30T03:00:00.000Z"),
      description: "June income",
    })

    const report = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    // Saved = the IDR balance only; target = 3M × 6 ÷ 2 months = 9M.
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "5000000"
    )
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "9000000"
    )
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "gap")).toBe(
      "4000000"
    )
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "partial_window")
    ).toBe("2 of 6")
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("Savings IDR")
    // One pending balance + one pending burn row — excluded AND counted,
    // never silently zeroed.
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "fx_pending_count")
    ).toBe("2")
    const insight = report.insights.find(
      (entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID
    )
    expect(insight?.partial).toBe(true)
  })

  test("skips when every designated savings balance is pending an exchange rate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    await account(owner, "Savings USD", {
      accountSubtype: "savings",
      currency: "USD",
      balance: 5_000n,
    })

    const report = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(report.insights.map((entry) => entry.id)).not.toContain(
      EMERGENCY_FUND_INSIGHT_ID
    )
    expect(
      report.skipped.find((entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID)
    ).toEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "every designated savings balance is pending an exchange rate",
    })
  })

  test("counts an INVESTMENT account designated as savings, valuation balance included", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // A money-market fund: INVESTMENT class, `savings` product subtype — the
    // Indonesian household norm, and it MUST count.
    const mmf = await account(owner, "MMF", {
      accountType: "INVESTMENT",
      accountSubtype: "savings",
      balance: 0n,
    })
    // A plain brokerage: INVESTMENT class but NOT the savings subtype — it
    // must not leak into the figure despite its 100M balance.
    await account(owner, "Brokerage", { accountType: "INVESTMENT" })
    // The MMF's balance is materialized from a reconciliation valuation, not
    // a transfer — designated savings counts regardless of balance source.
    await addAnchor(
      owner,
      mmf.id,
      "25000000",
      new Date("2026-05-01T03:00:00.000Z")
    )

    await create(owner, {
      type: "expense",
      amount: 3_000_000n,
      accountId: wallet.id,
      description: "May spending",
      date: new Date("2026-05-01T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 3_000_000n,
      accountId: wallet.id,
      description: "June spending",
      date: new Date("2026-06-30T03:00:00.000Z"),
    })

    const report = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "saved")).toBe(
      "25000000"
    )
    // Burn 6M over two months → target 18M; saved 25M beats it.
    expect(insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "target")).toBe(
      "18000000"
    )
    expect(
      insightMetric(report, EMERGENCY_FUND_INSIGHT_ID, "counted_accounts")
    ).toBe("MMF")
    const insight = report.insights.find(
      (entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID
    )
    expect(insight?.tone).toBe("positive")
  })

  test("skips below two complete recorded months even with savings present", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await account(owner, "Savings 1", {
      accountSubtype: "savings",
      balance: 5_000_000n,
    })

    // History starts mid-May: only June is covered end-to-end — one complete
    // month, below the two-month floor.
    await create(owner, {
      type: "expense",
      amount: 200_000n,
      accountId: wallet.id,
      description: "Mid-May spending",
      date: new Date("2026-05-15T03:00:00.000Z"),
    })
    await create(owner, {
      type: "expense",
      amount: 200_000n,
      accountId: wallet.id,
      description: "June spending",
      date: new Date("2026-06-30T03:00:00.000Z"),
    })

    const report = await insightsAt(owner, EMERGENCY_NOW, "2026-07")
    expect(report.insights.map((entry) => entry.id)).not.toContain(
      EMERGENCY_FUND_INSIGHT_ID
    )
    expect(
      report.skipped.find((entry) => entry.id === EMERGENCY_FUND_INSIGHT_ID)
    ).toEqual({
      id: EMERGENCY_FUND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })
  })

  // ---- recurring bills (PER-227 slice #4) ------------------------------------

  /** A real-ledger bill occurrence — the projection must be derivable from
   * rows written by the production path, never a hand-built series. */
  const bill = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    isoDate: string,
    amount: bigint,
    description: string
  ) =>
    create(owner, {
      type: "expense",
      amount,
      accountId,
      description,
      date: new Date(isoDate),
    })

  /** The four-occurrence Netflix cadence (30-day gaps) shared by the
   * prediction and tenant-isolation tests: mean 222,500, next expected
   * 2026-06-29 — due inside the [06-15, 07-15] window. The June one-off
   * extends recorded history past 2026-05-31 so Mar–May count as COMPLETE
   * months (Rule E) without forming a series of its own. */
  const seedNetflix = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) => {
    const occurrences: ReadonlyArray<readonly [string, bigint]> = [
      ["2026-03-01T03:00:00.000Z", 220_000n],
      ["2026-03-31T03:00:00.000Z", 220_000n],
      ["2026-04-30T03:00:00.000Z", 230_000n],
      ["2026-05-30T03:00:00.000Z", 220_000n],
    ]
    for (const [isoDate, amount] of occurrences) {
      await bill(owner, accountId, isoDate, amount, "Netflix")
    }
    await bill(
      owner,
      accountId,
      "2026-06-10T03:00:00.000Z",
      45_000n,
      "Groceries"
    )
  }

  test("predicts a due-soon bill from real ledger rows and labels the estimate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await seedNetflix(owner, wallet.id)

    const report = await insightsAt(owner, ON_JUNE)
    expect(report.failedCount).toBe(0)
    const insight = report.insights.find(
      (entry) => entry.id === RECURRING_BILLS_INSIGHT_ID
    )
    expect(insight?.tone).toBe("neutral")
    expect(insight?.window).toEqual({
      kind: "next_30_days",
      start: "2026-06-15",
      end: "2026-07-15",
      timezone: "Asia/Jakarta",
    })
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
    // 890,000 ÷ 4 occurrences — a PREDICTION, labelled as one.
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "predicted_total")
    ).toBe("222500")
    expect(
      report.insights
        .find((entry) => entry.id === RECURRING_BILLS_INSIGHT_ID)
        ?.metrics.find((m) => m.key === "predicted_total")?.label
    ).toBe("Predicted from 4 past payments")
    expect(insight?.summary).toBe(
      "Predicted recurring outflows over the next 30 days — an estimate from recorded payments, not money already spent."
    )
    // History starts 2026-03-01: Mar, Apr, May are the complete months.
    expect(insight?.detail).toBe(
      "Based on 4 past payments across 3 months of recorded history."
    )
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "series_count")
    ).toBe("1")
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "nearest_bill")
    ).toBe("222500")
    expect(
      report.insights
        .find((entry) => entry.id === RECURRING_BILLS_INSIGHT_ID)
        ?.metrics.find((m) => m.key === "nearest_bill")?.label
    ).toBe("Nearest (Netflix, due in 14 days)")
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "cadence_mix")
    ).toBe("1 monthly")
    expect(insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "due_bills")).toBe(
      "Netflix"
    )
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "history_months")
    ).toBe("3")
  })

  test("counts only the reader's family bill series — an identical series in another tenant never doubles the prediction", async () => {
    const seedFamily = async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
      const wallet = await account(owner, "Wallet", {
        accountSubtype: "checking",
      })
      await seedNetflix(owner, wallet.id)
      return owner
    }
    const ownerA = await seedFamily()
    const ownerB = await seedFamily()

    // A leak of B's four Netflix rows into A's detector would report 8 past
    // payments (and double the typical amount) — the label and the figure
    // together pin the tenant boundary at the series level, not just the row.
    const reportA = await insightsAt(ownerA, ON_JUNE)
    expect(
      insightMetric(reportA, RECURRING_BILLS_INSIGHT_ID, "predicted_total")
    ).toBe("222500")
    expect(
      reportA.insights
        .find((entry) => entry.id === RECURRING_BILLS_INSIGHT_ID)
        ?.metrics.find((m) => m.key === "predicted_total")?.label
    ).toBe("Predicted from 4 past payments")

    const reportB = await insightsAt(ownerB, ON_JUNE)
    expect(
      insightMetric(reportB, RECURRING_BILLS_INSIGHT_ID, "predicted_total")
    ).toBe("222500")
    expect(
      insightMetric(reportB, RECURRING_BILLS_INSIGHT_ID, "due_bills")
    ).toBe("Netflix")
  })

  test("still counts an overdue bill: 30 days past the projection, no lower bound", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // 31/29-day gaps average to 30, projecting 2026-04-16 + 30 = 2026-05-16
    // — 30 days overdue at the pinned clock. The last occurrence is 60 days
    // old: inside the detector's two-monthly-band staleness bound (70
    // days), so the series is still live. The June one-off extends recorded
    // history to cover Mar–May end-to-end without forming a series.
    await bill(
      owner,
      wallet.id,
      "2026-02-15T03:00:00.000Z",
      100_000n,
      "Netflix"
    )
    await bill(
      owner,
      wallet.id,
      "2026-03-16T03:00:00.000Z",
      100_000n,
      "Netflix"
    )
    await bill(
      owner,
      wallet.id,
      "2026-04-16T03:00:00.000Z",
      100_000n,
      "Netflix"
    )
    await bill(
      owner,
      wallet.id,
      "2026-06-10T03:00:00.000Z",
      45_000n,
      "Groceries"
    )

    const report = await insightsAt(owner, ON_JUNE)
    const insight = report.insights.find(
      (entry) => entry.id === RECURRING_BILLS_INSIGHT_ID
    )
    expect(insight).toBeDefined()
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "series_count")
    ).toBe("1")
    expect(
      insightMetric(report, RECURRING_BILLS_INSIGHT_ID, "predicted_total")
    ).toBe("100000")
    expect(
      report.insights
        .find((entry) => entry.id === RECURRING_BILLS_INSIGHT_ID)
        ?.metrics.find((m) => m.key === "nearest_bill")?.label
    ).toBe("Nearest (Netflix, 30 days overdue)")
  })

  test("skips a fresh family with the distinct history reason, never a confident prediction", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // One recent row: recorded history spans a single day, so no month is
    // complete — "predicted from recorded payments" would be a guess.
    await bill(
      owner,
      wallet.id,
      "2026-06-10T03:00:00.000Z",
      45_000n,
      "Groceries"
    )

    const report = await insightsAt(owner, ON_JUNE)
    expect(report.insights.map((entry) => entry.id)).not.toContain(
      RECURRING_BILLS_INSIGHT_ID
    )
    expect(
      report.skipped.find((entry) => entry.id === RECURRING_BILLS_INSIGHT_ID)
    ).toEqual({
      id: RECURRING_BILLS_INSIGHT_ID,
      reason: "fewer than three complete months of recorded history",
    })
  })

  // ---- spending trend (PER-227 slice #5) ------------------------------------

  /** A real-ledger expense — like-for-like membership must be derivable
   * from rows written by the production path, never a hand-built fold. */
  const spend = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    isoDate: string,
    amount: bigint,
    description: string
  ) =>
    create(owner, {
      type: "expense",
      amount,
      accountId,
      description,
      date: new Date(isoDate),
    })

  test("compares the same days of each month against a real ledger — the previous month's later spend never leaks into the delta", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })

    // Previous month, days 1..15 (the compared baseline window).
    await spend(
      owner,
      wallet.id,
      "2026-05-01T03:00:00.000Z",
      50_000n,
      "Rent share"
    )
    await spend(
      owner,
      wallet.id,
      "2026-05-07T03:00:00.000Z",
      200_000n,
      "Groceries"
    )
    // Previous month, AFTER day 15: context figure only — if it ever leaks
    // into `spent_previous_period`, the cutoff is gone and this test fails.
    await spend(
      owner,
      wallet.id,
      "2026-05-20T03:00:00.000Z",
      700_000n,
      "Laptop"
    )
    await spend(owner, wallet.id, "2026-05-31T03:00:00.000Z", 300_000n, "Party")
    // Current month, days 1..15 (the clock is pinned to 2026-06-15 10:00 WIB).
    await spend(
      owner,
      wallet.id,
      "2026-06-03T03:00:00.000Z",
      100_000n,
      "Groceries"
    )
    await spend(owner, wallet.id, "2026-06-12T03:00:00.000Z", 45_000n, "Coffee")

    const report = await insightsAt(owner, ON_JUNE)
    expect(report.failedCount).toBe(0)
    const insight = report.insights.find(
      (entry) => entry.id === SPENDING_TREND_INSIGHT_ID
    )
    expect(insight?.tone).toBe("neutral")
    // The envelope's baseline window: days 1–15 of the PREVIOUS month.
    expect(insight?.window).toEqual({
      kind: "previous_month",
      start: "2026-05-01",
      end: "2026-05-15",
      timezone: "Asia/Jakarta",
    })
    // June is in progress — `partial` says so; no FX rows, so the FX badge
    // stays off (the renderer keys it off `fxPendingCount`, not `partial`).
    expect(insight?.partial).toBe(true)
    expect(insight?.fxPendingCount).toBe(0)
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "spent_current_period")
    ).toBe("145000")
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "spent_previous_period")
    ).toBe("250000")
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "previous_month_total")
    ).toBe("1250000")
    expect(insightMetric(report, SPENDING_TREND_INSIGHT_ID, "delta")).toBe(
      "-105000"
    )
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "percent_change")
    ).toBe("-42%")
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "days_elapsed")
    ).toBe("1–15 vs 1–15")
    expect(insight?.summary).toBe(
      "Days 1–15 of this month versus days 1–15 of last month — the same days of each month, never a partial month against a complete one."
    )
    expect(
      insight?.metrics.find((m) => m.key === "previous_month_total")?.label
    ).toBe("Full May 2026 — complete month, for context")
  })

  test("counts only the reader's family spend — another tenant's month never moves the delta", async () => {
    const seedFamily = async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
      const wallet = await account(owner, "Wallet", {
        accountSubtype: "checking",
      })
      return { owner, wallet }
    }

    const a = await seedFamily()
    // Family A: identical seed to the like-for-like test (delta −105,000).
    await spend(
      a.owner,
      a.wallet.id,
      "2026-05-01T03:00:00.000Z",
      50_000n,
      "Rent share"
    )
    await spend(
      a.owner,
      a.wallet.id,
      "2026-05-07T03:00:00.000Z",
      200_000n,
      "Groceries"
    )
    await spend(
      a.owner,
      a.wallet.id,
      "2026-05-20T03:00:00.000Z",
      700_000n,
      "Laptop"
    )
    await spend(
      a.owner,
      a.wallet.id,
      "2026-06-03T03:00:00.000Z",
      100_000n,
      "Groceries"
    )
    await spend(
      a.owner,
      a.wallet.id,
      "2026-06-12T03:00:00.000Z",
      45_000n,
      "Coffee"
    )

    const b = await seedFamily()
    // Family B: bigger rows on both sides — a leak of B's spend into A's
    // fold would move A's delta toward B's +200,000.
    await spend(
      b.owner,
      b.wallet.id,
      "2026-05-01T03:00:00.000Z",
      400_000n,
      "B rent share"
    )
    await spend(
      b.owner,
      b.wallet.id,
      "2026-05-10T03:00:00.000Z",
      400_000n,
      "B groceries"
    )
    await spend(
      b.owner,
      b.wallet.id,
      "2026-05-28T03:00:00.000Z",
      400_000n,
      "B furniture"
    )
    await spend(
      b.owner,
      b.wallet.id,
      "2026-06-05T03:00:00.000Z",
      500_000n,
      "B groceries"
    )
    await spend(
      b.owner,
      b.wallet.id,
      "2026-06-14T03:00:00.000Z",
      500_000n,
      "B dinner"
    )

    const reportA = await insightsAt(a.owner, ON_JUNE)
    expect(
      insightMetric(reportA, SPENDING_TREND_INSIGHT_ID, "spent_current_period")
    ).toBe("145000")
    expect(
      insightMetric(reportA, SPENDING_TREND_INSIGHT_ID, "spent_previous_period")
    ).toBe("250000")
    expect(insightMetric(reportA, SPENDING_TREND_INSIGHT_ID, "delta")).toBe(
      "-105000"
    )

    const reportB = await insightsAt(b.owner, ON_JUNE)
    expect(
      insightMetric(reportB, SPENDING_TREND_INSIGHT_ID, "spent_current_period")
    ).toBe("1000000")
    expect(
      insightMetric(reportB, SPENDING_TREND_INSIGHT_ID, "spent_previous_period")
    ).toBe("800000")
    expect(insightMetric(reportB, SPENDING_TREND_INSIGHT_ID, "delta")).toBe(
      "200000"
    )
    expect(
      insightMetric(reportB, SPENDING_TREND_INSIGHT_ID, "percent_change")
    ).toBe("+25%")
  })

  test("a past-month request renders both COMPLETE months with partial false", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    await spend(
      owner,
      wallet.id,
      "2026-03-01T03:00:00.000Z",
      20_000n,
      "March start"
    )
    await spend(
      owner,
      wallet.id,
      "2026-03-05T03:00:00.000Z",
      250_000n,
      "March groceries"
    )
    await spend(
      owner,
      wallet.id,
      "2026-03-30T03:00:00.000Z",
      50_000n,
      "March medicine"
    )
    await spend(
      owner,
      wallet.id,
      "2026-04-10T03:00:00.000Z",
      300_000n,
      "April groceries"
    )
    await spend(
      owner,
      wallet.id,
      "2026-04-25T03:00:00.000Z",
      100_000n,
      "April visit"
    )
    await spend(
      owner,
      wallet.id,
      "2026-04-30T03:00:00.000Z",
      25_000n,
      "April close"
    )

    const report = await insightsAt(owner, ON_JUNE, "2026-04")
    expect(report.failedCount).toBe(0)
    const insight = report.insights.find(
      (entry) => entry.id === SPENDING_TREND_INSIGHT_ID
    )
    expect(insight).toBeDefined()
    // Both sides COMPLETE: the baseline window is the whole previous month.
    expect(insight?.window).toEqual({
      kind: "previous_month",
      start: "2026-03-01",
      end: "2026-03-31",
      timezone: "Asia/Jakarta",
    })
    expect(insight?.partial).toBe(false)
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "spent_current_period")
    ).toBe("425000")
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "spent_previous_period")
    ).toBe("320000")
    expect(insightMetric(report, SPENDING_TREND_INSIGHT_ID, "delta")).toBe(
      "105000"
    )
    expect(
      insightMetric(report, SPENDING_TREND_INSIGHT_ID, "days_elapsed")
    ).toBe("1–30 vs 1–31")
    expect(insight?.summary).toBe(
      "April 2026 versus March 2026 — both months are complete, so the comparison is like for like."
    )
  })

  test("skips a freshly seeded family with the distinct history reason, never a comparison against nothing", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "Asia/Jakarta")
    const wallet = await account(owner, "Wallet", {
      accountSubtype: "checking",
    })
    // Recorded history begins mid-current-month: May never existed on this
    // ledger, so there is nothing to compare days 1–15 against.
    await spend(
      owner,
      wallet.id,
      "2026-06-05T03:00:00.000Z",
      150_000n,
      "Groceries"
    )
    await spend(owner, wallet.id, "2026-06-10T03:00:00.000Z", 45_000n, "Coffee")

    const report = await insightsAt(owner, ON_JUNE)
    expect(report.insights.map((entry) => entry.id)).not.toContain(
      SPENDING_TREND_INSIGHT_ID
    )
    expect(
      report.skipped.find((entry) => entry.id === SPENDING_TREND_INSIGHT_ID)
    ).toEqual({
      id: SPENDING_TREND_INSIGHT_ID,
      reason: "fewer than two complete months of recorded history",
    })
  })
})
