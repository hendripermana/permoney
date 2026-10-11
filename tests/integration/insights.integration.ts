import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { INSIGHTS_ENGINE_VERSION } from "@/lib/insights"
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

  test("marks savings_flow partially recorded when a live gap intersects its month", async () => {
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
      amount: 500_000n,
      date: new Date("2026-06-10T03:00:00.000Z"),
    })
    // A separate account carries the hole so no recorded activity explains it:
    // asserting 120,000 at June 28 while the June 1 assertion was 100,000.
    const gapAccount = await account(owner, "Gap account", {
      accountSubtype: "checking",
    })
    await addAnchor(
      owner,
      gapAccount.id,
      "100000",
      new Date("2026-06-01T03:00:00.000Z")
    )
    await addAnchor(
      owner,
      gapAccount.id,
      "120000",
      new Date("2026-06-28T03:00:00.000Z")
    )

    const report = await insightsAt(owner, COMPLETENESS_NOW)
    const insight = report.insights.find((entry) => entry.id === "savings_flow")
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

  test("leaves the qualifier off when the insight's window has no gap", async () => {
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
      amount: 500_000n,
      date: new Date("2026-06-10T03:00:00.000Z"),
    })
    // A real hole — but in JANUARY, far outside the June window.
    const gapAccount = await account(owner, "Gap account", {
      accountSubtype: "checking",
    })
    await addAnchor(
      owner,
      gapAccount.id,
      "100000",
      new Date("2026-01-05T03:00:00.000Z")
    )
    await addAnchor(
      owner,
      gapAccount.id,
      "120000",
      new Date("2026-01-20T03:00:00.000Z")
    )

    const report = await insightsAt(owner, COMPLETENESS_NOW)
    const insight = report.insights.find((entry) => entry.id === "savings_flow")
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
  })

  test("ignores migration-softened gaps (imported history is known by design)", async () => {
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
      amount: 500_000n,
      date: new Date("2026-06-10T03:00:00.000Z"),
    })
    const imported = await account(owner, "Imported", {
      accountSubtype: "checking",
    })
    await addAnchor(
      owner,
      imported.id,
      "100000",
      new Date("2026-06-01T03:00:00.000Z"),
      "migration:sure"
    )
    await addAnchor(
      owner,
      imported.id,
      "120000",
      new Date("2026-06-28T03:00:00.000Z"),
      "migration:sure"
    )

    const report = await insightsAt(owner, COMPLETENESS_NOW)
    const insight = report.insights.find((entry) => entry.id === "savings_flow")
    expect(insight?.periodPartial).toBe(false)
    expect(insight?.periodGaps).toEqual([])
  })
})
