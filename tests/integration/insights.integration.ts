import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { getInsightsForFamily } from "@/server/insights"
import { getCashFlowReportForFamily } from "@/server/reporting"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
} from "@/server/transactions"
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

describe("household insights — savings_flow (PER-227)", () => {
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
    expect(report.engineVersion).toBe(1)
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
    expect(report.skipped).toEqual([
      {
        id: "savings_flow",
        reason: "no savings or investment transfers in the window",
      },
    ])
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
})
