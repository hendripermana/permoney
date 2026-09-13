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
import { recordTradeForFamily } from "@/server/holdings"
import {
  bulkCreateTransactionsForFamily,
  createTransactionForFamily,
  findLedgerTransactionsForFamily,
} from "@/server/transactions"
import {
  createValuationForFamily,
  detectBalanceDriftForFamily,
  HoldingsAccountLedgerError,
  rebuildFamilyBalances,
} from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-259 / ADR-0054 — holdings-account operational coherence.
//
// A holdings-tracked account (a valuation account carrying ≥1 Holding) moves
// money ONLY through trades (Buy/Sell). Its value is always Σ(units × price),
// written back as the holdings anchor (source="holdings"). Every OTHER value-set
// path — a plain/valuation-linked transfer leg, or a manual "Update value" — is
// rejected fail-loud (HoldingsAccountLedgerError). The SAME operations on a
// valuation account WITHOUT holdings still succeed (ADR-0048 unchanged), and
// recordTradeFn's own valuation writes (source="holdings") are unaffected.
// Legacy rows that predate holdings are grandfathered: rebuild/drift never
// re-reject them.

// Always "tomorrow" relative to whenever the suite actually runs — never a
// hardcoded calendar literal. A fixed past literal here rots: once wall-clock
// "now" passes it, an account's opening-balance anchor (valuationDate = now,
// see `createAccountForFamily`) legitimately outranks it under PER-201's
// createdAt-aware canonical-balance rule (latest by date OR createdAt), so a
// test valuation/transfer dated here would silently fail to become canonical
// — not a product bug, a stale test fixture.
const TEST_DATE = new Date(Date.now() + 24 * 60 * 60 * 1000)

describe("PER-259 / ADR-0054 — holdings-account money-movement coherence", () => {
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

  const fundInline = { kind: "mutual_fund" as const, name: "Fund A" }

  // A valuation-tracked investment account (TRACKED_ASSET → balanceSource
  // "valuation"). Real account-create, so it carries a genuine opening
  // valuation (ADR-0034 §3) — the realistic production shape.
  const makeInvestmentAccount = async (owner: AuthenticatedOnboardedUser) =>
    await createAccountForFamily({
      data: {
        name: "Bibit",
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // A cash-like funding account (DEPOSITORY → balanceSource "transaction_flow").
  const makeCashAccount = async (
    owner: AuthenticatedOnboardedUser,
    opening = "150000"
  ) =>
    await createAccountForFamily({
      data: {
        name: "Checking",
        accountType: "DEPOSITORY" as AccountType,
        openingBalance: opening,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Give the investment account a real holding via a Buy (the coherent path).
  const buyInto = async (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    fundingId: string
  ) =>
    await recordTradeForFamily({
      data: {
        investmentAccountId: investmentId,
        fundingAccountId: fundingId,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000", // 100 units × 10,000 sen
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const balanceOf = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const row = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { balance: true },
      })
      return row.balance
    })

  // --------------------------------------------------------------------------
  // REJECTED on a WITH-HOLDINGS account
  // --------------------------------------------------------------------------

  test("a plain transfer INTO a with-holdings account is rejected fail-loud", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    await buyInto(owner, investment.id, cash.id)

    const investBefore = await balanceOf(owner, investment.id)
    const cashBefore = await balanceOf(owner, cash.id)

    await expect(
      createTransactionForFamily({
        data: {
          accountId: cash.id,
          amount: 250_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Top up reksadana (should be a Buy)",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: investment.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(HoldingsAccountLedgerError)

    // Fully rolled back — neither leg moved.
    expect(await balanceOf(owner, investment.id)).toBe(investBefore)
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
  })

  test("a transfer OUT of a with-holdings account is rejected fail-loud", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    await buyInto(owner, investment.id, cash.id)

    await expect(
      createTransactionForFamily({
        data: {
          accountId: investment.id,
          amount: 100_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Withdraw (should be a Sell)",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: cash.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(HoldingsAccountLedgerError)
  })

  test("a manual 'Update value' on a with-holdings account is rejected fail-loud", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    await buyInto(owner, investment.id, cash.id)

    const investBefore = await balanceOf(owner, investment.id)

    await expect(
      createValuationForFamily({
        data: {
          accountId: investment.id,
          idempotencyKey: factories.createIdempotencyKey(),
          type: "manual",
          value: "9999999",
          valuationDate: TEST_DATE,
        },
        familyId: owner.family.id,
        provenance: "ground_truth",
        user: owner.user,
      })
    ).rejects.toThrow(HoldingsAccountLedgerError)

    // Value untouched — Σ(units × price) still governs.
    expect(await balanceOf(owner, investment.id)).toBe(investBefore)
  })

  test("the bulk-create path targeting a with-holdings account is rejected (single/bulk parity)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    await buyInto(owner, investment.id, cash.id)

    const investBefore = await balanceOf(owner, investment.id)

    // Bulk create only posts income/expense (single accountId) — a valuation
    // account is already blocked at the incremental-delta guard, so a bulk
    // value-set on a holdings account is impossible from this endpoint too.
    await expect(
      bulkCreateTransactionsForFamily({
        data: {
          idempotencyKey: factories.createIdempotencyKey(),
          transactions: [
            {
              id: factories.createIdempotencyKey(),
              accountId: investment.id,
              amount: 5_000n,
              date: TEST_DATE,
              description: "Bulk income (should be a trade)",
              idempotencyKey: factories.createIdempotencyKey(),
              status: "CLEARED",
              type: "income",
            },
          ],
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow()

    expect(await balanceOf(owner, investment.id)).toBe(investBefore)
  })

  // --------------------------------------------------------------------------
  // ALLOWED on a valuation account WITHOUT holdings (ADR-0048 unbroken)
  // --------------------------------------------------------------------------

  test("valuation-linked transfer INTO a holdings-FREE valuation account still succeeds", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    // Tracked asset with NO holdings — a property / manually-valued asset.
    const property = await createAccountForFamily({
      data: {
        name: "Rumah",
        accountType: "TRACKED_ASSET" as AccountType,
        openingBalance: "1000000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const cash = await makeCashAccount(owner, "5000000")

    const result = await createTransactionForFamily({
      data: {
        accountId: cash.id,
        amount: 250_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Add to property value",
        idempotencyKey: factories.createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: property.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result).toBeDefined()
    expect(await balanceOf(owner, property.id)).toBe(1_000_000n + 250_000n)
  })

  test("manual 'Update value' on a holdings-FREE valuation account still succeeds", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const property = await createAccountForFamily({
      data: {
        name: "Rumah",
        accountType: "TRACKED_ASSET" as AccountType,
        openingBalance: "1000000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const result = await createValuationForFamily({
      data: {
        accountId: property.id,
        idempotencyKey: factories.createIdempotencyKey(),
        type: "manual",
        value: "1250000",
        valuationDate: TEST_DATE,
      },
      familyId: owner.family.id,
      provenance: "ground_truth",
      user: owner.user,
    })

    expect(result).toBeDefined()
    expect(await balanceOf(owner, property.id)).toBe(1_250_000n)
  })

  // --------------------------------------------------------------------------
  // TRADES on a with-holdings account are UNAFFECTED (source="holdings")
  // --------------------------------------------------------------------------

  test("Buy then Sell on a with-holdings account still works (cash + units + valuation + realized gain)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner, "5000000")

    const buy = await buyInto(owner, investment.id, cash.id)
    expect(buy.holding?.quantity).toBe("100.00000000")
    const instrumentId = buy.holding?.instrumentId
    expect(instrumentId).toBeTruthy()

    // Sell 40 units at 12,000 sen/unit = 480,000 sen; cost removed = 40×10,000
    // = 400,000; realized gain = 80,000.
    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell",
        cashAmount: "480000",
        quantity: "40",
        unitPrice: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(sell.side).toBe("sell")
    expect(sell.realizedGainMinor).toBe("80000")
    expect(sell.holding?.quantity).toBe("60.00000000")
    // Investment value = Σ holdings = 60 × 10,000 = 600,000 (carried at cost).
    expect(await balanceOf(owner, investment.id)).toBe(600_000n)

    // Audit rows were written for the trade (Holding + Transaction + Valuation).
    const holdingAudits = await harness.withFamily(owner.family.id, (tx) =>
      tx.auditLog.count({ where: { entityType: "Holding" } })
    )
    expect(holdingAudits).toBeGreaterThan(0)
  })

  test("recording a trade is idempotent — replaying the same key does not double the position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner, "5000000")

    const key = factories.createIdempotencyKey()
    const payload = {
      investmentAccountId: investment.id,
      fundingAccountId: cash.id,
      instrument: fundInline,
      side: "buy" as const,
      cashAmount: "1000000",
      quantity: "100",
      unitPrice: "10000",
      idempotencyKey: key,
    }
    const first = await recordTradeForFamily({
      data: payload,
      familyId: owner.family.id,
      user: owner.user,
    })
    const replay = await recordTradeForFamily({
      data: payload,
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(replay.holding?.quantity).toBe(first.holding?.quantity)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
    const holdingCount = await harness.withFamily(owner.family.id, (tx) =>
      tx.holding.count({ where: { accountId: investment.id } })
    )
    expect(holdingCount).toBe(1)
  })

  // --------------------------------------------------------------------------
  // LEGACY rows grandfathered — rebuild/drift never re-reject them
  // --------------------------------------------------------------------------

  test("a legacy valuation-linked transfer written BEFORE holdings survives; later trades add holdings and rebuild/drift stay clean", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner, "5000000")

    // (1) Legacy money movement BEFORE the account has holdings — allowed.
    const legacy = await createTransactionForFamily({
      data: {
        accountId: cash.id,
        amount: 250_000n,
        currency: "IDR",
        date: new Date("2026-01-01T00:00:00.000Z"),
        description: "Legacy top-up (pre-holdings)",
        idempotencyKey: factories.createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: investment.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(legacy).toBeDefined()

    // (2) The account gains holdings via a Buy.
    await buyInto(owner, investment.id, cash.id)

    // (3) A NEW transfer is now rejected (guard is on new writes only)...
    await expect(
      createTransactionForFamily({
        data: {
          accountId: cash.id,
          amount: 10_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "New transfer after holdings",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: investment.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(HoldingsAccountLedgerError)

    // (4) ...but the legacy row is still visible history.
    const ledger = await harness.withFamily(owner.family.id, (tx) =>
      findLedgerTransactionsForFamily(tx, owner.family.id)
    )
    expect(ledger.some((row) => row.id === legacy.id)).toBe(true)

    // (5) Rebuild does not throw on the grandfathered rows, and no
    // materialization drift is introduced.
    await expect(
      rebuildFamilyBalances({ familyId: owner.family.id, user: owner.user })
    ).resolves.toBeDefined()

    const drift = await detectBalanceDriftForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(drift.filter((d) => d.kind === "MATERIALIZATION")).toHaveLength(0)
  })
})
