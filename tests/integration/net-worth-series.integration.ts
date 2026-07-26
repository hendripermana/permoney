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
import { normalizeNetWorthAt, type PointBalance } from "@/lib/net-worth"
import { createAccountForFamily } from "@/server/accounts"
import { createTransactionForFamily } from "@/server/transactions"
import { createValuationForFamily } from "@/server/valuations"
import {
  getFxOverviewForFamily,
  upsertFxRateSnapshotForFamily,
} from "@/server/fx"
import {
  getNetWorthSeriesForFamily,
  type SerializedNetWorthPoint,
} from "@/server/reporting"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

describe("net-worth time series (PER-154 / ADR-0038)", () => {
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

  const makeAccount = async (
    owner: AuthenticatedOnboardedUser,
    opts: {
      name: string
      accountType?: AccountType
      currency?: string
      openingBalance: string
      openingDate: string // backdated inception (YYYY-MM-DD)
    }
  ) => {
    const account = await createAccountForFamily({
      data: {
        name: opts.name,
        accountType: opts.accountType ?? "DEPOSITORY",
        currency: opts.currency ?? "IDR",
        openingBalance: opts.openingBalance,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    // The real create path stamps the opening valuation at `now`; backdate it so
    // the account has a deterministic inception for historical sampling.
    await harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: account.id, type: "opening" },
        data: { valuationDate: new Date(`${opts.openingDate}T00:00:00.000Z`) },
      })
    )
    return account
  }

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

  const expense = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    amount: bigint,
    date: string,
    currency = "IDR"
  ) =>
    createTransactionForFamily({
      data: {
        type: "expense",
        amount,
        currency,
        accountId,
        description: "net-worth test expense",
        date: new Date(`${date}T00:00:00.000Z`),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Assert a fresh balance at a date — a `reconciliation` anchor. Pass the
  // POSITIVE magnitude; the server signs it for the account class (a LIABILITY
  // magnitude becomes a negative signed value). This is the Sure-migrated shape:
  // the effective anchor is a reconciliation, never the `opening`.
  const reconcile = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    magnitude: string,
    date: string
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value: magnitude,
        type: "reconciliation",
        valuationDate: new Date(`${date}T00:00:00.000Z`),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const series = (
    owner: AuthenticatedOnboardedUser,
    from: string,
    to: string,
    interval: "day" | "week" | "month",
    userId = owner.user.id
  ) =>
    getNetWorthSeriesForFamily({
      data: { from, to, interval },
      familyId: owner.family.id,
      userId,
    })

  const pointAt = (
    points: SerializedNetWorthPoint[],
    date: string
  ): SerializedNetWorthPoint => {
    const point = points.find((p) => p.date === date)
    if (!point) throw new Error(`no point for ${date}`)
    return point
  }

  // Recompute the live card total exactly as `NetWorthInBaseCard` does (shared
  // `normalizeNetWorthAt` over materialized balances + latest rate per currency),
  // and the raw Σ signed Account.balance. For an all-base-currency family the two
  // coincide; both must equal the series' last point (ADR-0038 §6).
  const materializedCardTotal = async (owner: AuthenticatedOnboardedUser) => {
    const accounts = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findMany({
        where: { familyId: owner.family.id },
        select: { accountClass: true, currency: true, balance: true },
      })
    )
    const sumSignedBalance = accounts.reduce((acc, a) => acc + a.balance, 0n)
    const overview = await getFxOverviewForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const latest = new Map<string, bigint>()
    for (const rate of overview.rates) {
      if (rate.toCurrency !== overview.baseCurrency) continue
      if (!latest.has(rate.fromCurrency)) {
        latest.set(rate.fromCurrency, BigInt(rate.rateScaled))
      }
    }
    const balances: PointBalance[] = accounts.map((a) => ({
      accountClass: a.accountClass,
      currency: a.currency,
      native: a.balance,
    }))
    const cardTotal = normalizeNetWorthAt(
      balances,
      (currency) => latest.get(currency) ?? null,
      overview.baseCurrency
    ).netWorth
    return { cardTotal, sumSignedBalance }
  }

  // A rich mixed family used by several assertions.
  const seedMixedFamily = async (owner: AuthenticatedOnboardedUser) => {
    await setFamilyDefaults(owner, "IDR", "UTC")
    const cash = await makeAccount(owner, {
      name: "Cash",
      accountType: "DEPOSITORY",
      openingBalance: "1000000",
      openingDate: "2026-01-01",
    })
    const card = await makeAccount(owner, {
      name: "Card",
      accountType: "CREDIT",
      openingBalance: "200000",
      openingDate: "2026-01-01",
    })
    const usd = await makeAccount(owner, {
      name: "USD savings",
      accountType: "DEPOSITORY",
      currency: "USD",
      openingBalance: "100",
      openingDate: "2026-01-01",
    })
    const gold = await makeAccount(owner, {
      name: "Gold",
      accountType: "TRACKED_ASSET",
      openingBalance: "5000000",
      openingDate: "2026-01-01",
    })
    // A cash expense mid-January (so it lands in the Feb/Mar points, not Jan).
    // Positive magnitude in; the server signs the expense negative on the account.
    await expense(owner, cash.id, 100_000n, "2026-01-15")
    // Gold re-valued upward on 2026-03-01.
    await createValuationForFamily({
      data: {
        accountId: gold.id,
        value: "6000000",
        type: "market",
        valuationDate: new Date("2026-03-01T00:00:00.000Z"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    // FX: USD strengthens from 16,000 to 17,000 on 2026-03-01.
    await seedRate(owner, "USD", "16000", "2026-01-01")
    await seedRate(owner, "USD", "17000", "2026-03-01")
    return { cash, card, usd, gold }
  }

  // ---- correctness -----------------------------------------------------------

  test("derives a correct series across cash, tracked, and multi-currency accounts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(owner)

    const result = await series(owner, "2026-01-01", "2026-03-01", "month")
    expect(result.baseCurrency).toBe("IDR")
    expect(result.points.map((p) => p.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ])

    const usdAt16k = convertMinor(
      100n,
      "USD",
      "IDR",
      encodeRate("16000")
    ) as bigint
    const usdAt17k = convertMinor(
      100n,
      "USD",
      "IDR",
      encodeRate("17000")
    ) as bigint

    // 2026-01-01: openings only (cash 1,000,000; card -200,000; usd@16k; gold 5,000,000).
    const jan = pointAt(result.points, "2026-01-01")
    expect(jan.assets).toBe((1_000_000n + usdAt16k + 5_000_000n).toString())
    expect(jan.liabilities).toBe("200000")
    expect(jan.netWorth).toBe(
      (1_000_000n + usdAt16k + 5_000_000n - 200_000n).toString()
    )
    expect(jan.isPartial).toBe(false)

    // 2026-02-01: cash expense applied (900,000); USD still @16k; gold still 5,000,000.
    const feb = pointAt(result.points, "2026-02-01")
    expect(feb.netWorth).toBe(
      (900_000n + usdAt16k + 5_000_000n - 200_000n).toString()
    )

    // 2026-03-01: USD re-values @17k; gold market valuation 6,000,000.
    const mar = pointAt(result.points, "2026-03-01")
    expect(mar.netWorth).toBe(
      (900_000n + usdAt17k + 6_000_000n - 200_000n).toString()
    )
  })

  test("every point satisfies netWorth === assets − liabilities", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(owner)
    const result = await series(owner, "2026-01-01", "2026-03-01", "month")
    for (const point of result.points) {
      expect(BigInt(point.netWorth)).toBe(
        BigInt(point.assets) - BigInt(point.liabilities)
      )
    }
  })

  test("historical values are stable: a later rate does not move an earlier point", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(owner)
    const result = await series(owner, "2026-01-01", "2026-03-01", "month")
    const usdAt16k = convertMinor(
      100n,
      "USD",
      "IDR",
      encodeRate("16000")
    ) as bigint
    // Feb point must use the 16k rate even though a 17k rate exists (dated Mar).
    const feb = pointAt(result.points, "2026-02-01")
    expect(feb.netWorth).toBe(
      (900_000n + usdAt16k + 5_000_000n - 200_000n).toString()
    )
  })

  test("FX-pending: a foreign account before its first rate is excluded and flagged", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    await makeAccount(owner, {
      name: "IDR",
      openingBalance: "500000",
      openingDate: "2026-01-01",
    })
    await makeAccount(owner, {
      name: "USD",
      currency: "USD",
      openingBalance: "100",
      openingDate: "2026-01-01",
    })
    // USD rate only exists from 2026-02-01 onward.
    await seedRate(owner, "USD", "16000", "2026-02-01")

    const result = await series(owner, "2026-01-01", "2026-02-01", "month")
    const early = pointAt(result.points, "2026-01-01")
    expect(early.isPartial).toBe(true)
    expect(early.unconverted).toEqual([{ currency: "USD", native: "100" }])
    expect(early.netWorth).toBe("500000") // USD excluded, not zeroed

    const later = pointAt(result.points, "2026-02-01")
    expect(later.isPartial).toBe(false)
    const usdAt16k = convertMinor(
      100n,
      "USD",
      "IDR",
      encodeRate("16000")
    ) as bigint
    expect(later.netWorth).toBe((500_000n + usdAt16k).toString())
  })

  test("activity dated before `from` shifts the first point", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const cash = await makeAccount(owner, {
      name: "Cash",
      openingBalance: "1000000",
      openingDate: "2026-01-01",
    })
    await expense(owner, cash.id, 250_000n, "2026-01-10") // before `from`

    const result = await series(owner, "2026-02-01", "2026-02-01", "day")
    expect(pointAt(result.points, "2026-02-01").netWorth).toBe("750000")
  })

  test("a closed/archived account still contributes its derived balance", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const cash = await makeAccount(owner, {
      name: "Old wallet",
      openingBalance: "300000",
      openingDate: "2026-01-01",
    })
    // Simulate a closed account that still holds a residual balance.
    await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.updateMany({
        where: { id: cash.id },
        data: { status: "closed", archivedAt: new Date() },
      })
    )
    const result = await series(owner, "2026-01-01", "2026-01-01", "day")
    expect(pointAt(result.points, "2026-01-01").netWorth).toBe("300000")
  })

  // ---- live-card invariant ---------------------------------------------------

  test("the last point equals the NetWorthInBaseCard total (shared helper)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(owner)

    const today = new Date().toISOString().slice(0, 10)
    const result = await series(owner, "2026-01-01", today, "month")
    const last = result.points[result.points.length - 1]
    expect(last.date).toBe(today)

    // Recompute the card total exactly as NetWorthInBaseCard does: status-agnostic
    // materialized balances + latest rate per currency, via the shared helper.
    const accounts = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findMany({
        where: { familyId: owner.family.id },
        select: { accountClass: true, currency: true, balance: true },
      })
    )
    const overview = await getFxOverviewForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const latest = new Map<string, bigint>()
    for (const rate of overview.rates) {
      if (rate.toCurrency !== overview.baseCurrency) continue
      if (!latest.has(rate.fromCurrency)) {
        latest.set(rate.fromCurrency, BigInt(rate.rateScaled))
      }
    }
    const balances: PointBalance[] = accounts.map((a) => ({
      accountClass: a.accountClass,
      currency: a.currency,
      native: a.balance,
    }))
    const cardTotal = normalizeNetWorthAt(
      balances,
      (currency) => latest.get(currency) ?? null,
      overview.baseCurrency
    ).netWorth

    expect(last.netWorth).toBe(cardTotal.toString())
  })

  // ---- ADR-0038 §6 invariant: the reconciliation-anchor regression -----------
  //
  // The bug PER-204 fixes: the fold only recognized `opening` anchors, so any
  // account whose effective anchor is a RECONCILIATION (every Sure-migrated /
  // reconciled account) folded to 0. This is the guard that keeps the batch
  // fold and `computeCanonicalBalance` in exact parity: the series' last point
  // must equal the live card AND Σ Account.balance, on data that mirrors the
  // failure — reconciliation-anchored accounts, a back-dated post-anchor txn
  // (the createdAt disjunct), and a liability (the sign path).
  test("last point == Σ Account.balance == card for reconciliation-anchored accounts (PER-204)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")

    // Sure-migrated shape: opening 0, then the REAL anchor is a reconciliation.
    const cash = await makeAccount(owner, {
      name: "Migrated cash",
      accountType: "DEPOSITORY",
      openingBalance: "0",
      openingDate: "2025-07-24",
    })
    const loan = await makeAccount(owner, {
      name: "Migrated loan",
      accountType: "LOAN",
      openingBalance: "0",
      openingDate: "2025-07-24",
    })

    // Pre-reconciliation activity the anchor absorbs (dated + recorded before it).
    await expense(owner, cash.id, 999_999n, "2026-01-10")

    // The effective anchors (latest <= now): a reconciliation on each account.
    await reconcile(owner, cash.id, "210000000", "2026-06-30")
    await reconcile(owner, loan.id, "128000000", "2026-06-30") // signed → -128,000,000

    // Post-anchor flow, dated after the anchor.
    await expense(owner, cash.id, 5_000_000n, "2026-07-05")
    // Back-dated flow RECORDED after the reconciliation: dated before the anchor
    // but created now → genuine post-anchor activity (the createdAt disjunct).
    await expense(owner, cash.id, 1_000_000n, "2026-06-01")

    const today = new Date().toISOString().slice(0, 10)
    const result = await series(owner, "2025-07-01", today, "month")
    const last = result.points[result.points.length - 1]
    expect(last.date).toBe(today)

    const { cardTotal, sumSignedBalance } = await materializedCardTotal(owner)
    // The invariant (ADR-0038 §6). Under the old opening-only fold this was 0.
    expect(last.netWorth).toBe(cardTotal.toString())
    expect(last.netWorth).toBe(sumSignedBalance.toString())

    // Materially non-zero, with the liability REDUCING net worth (sign path):
    // cash 210,000,000 − 5,000,000 − 1,000,000 = 204,000,000; loan −128,000,000.
    expect(last.netWorth).toBe("76000000")
    expect(last.assets).toBe("204000000")
    expect(last.liabilities).toBe("128000000")
  })

  // No-anchor edge (head-eng point 3): an account with NO anchor of any type
  // must not be dropped. The fold folds it as an implicit opening-0 (Σ all flow),
  // which equals the stored `Account.balance` that `computeCanonicalBalance`
  // falls back to — so the invariant still holds.
  test("no-anchor account: last point == Σ Account.balance (opening-0 fallback)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(owner, "IDR", "UTC")
    const cash = await makeAccount(owner, {
      name: "Anchor-less",
      openingBalance: "0",
      openingDate: "2026-01-01",
    })
    await expense(owner, cash.id, 40_000n, "2026-01-10")
    // Soft-delete the opening valuation → the account now has zero anchors, while
    // its materialized balance (−40,000) is untouched. Mirrors a raw/legacy row.
    await harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: cash.id, type: "opening" },
        data: { deletedAt: new Date() },
      })
    )

    const today = new Date().toISOString().slice(0, 10)
    const result = await series(owner, "2026-01-01", today, "month")
    const last = result.points[result.points.length - 1]

    const { cardTotal, sumSignedBalance } = await materializedCardTotal(owner)
    expect(last.netWorth).toBe(sumSignedBalance.toString())
    expect(last.netWorth).toBe(cardTotal.toString())
    expect(last.netWorth).toBe("-40000") // opening-0 + Σ flow, not dropped to 0
  })

  // ---- interval bucketing ----------------------------------------------------
  //
  // day / week / month must each produce strictly time-ascending buckets, end at
  // `to`, and agree with the live card at the last point (here `to` is past the
  // family's last activity, so the last point equals the current balance). A
  // date sampled by two intervals resolves to one identical value.
  test("interval bucketing: day/week/month are monotonic and agree at the last point", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(owner)
    const to = "2026-03-01" // no activity after this → last point == current balance
    const [byDay, byWeek, byMonth] = await Promise.all([
      series(owner, "2026-01-01", to, "day"),
      series(owner, "2026-01-01", to, "week"),
      series(owner, "2026-01-01", to, "month"),
    ])
    const { cardTotal } = await materializedCardTotal(owner)
    for (const s of [byDay, byWeek, byMonth]) {
      for (let i = 1; i < s.points.length; i++) {
        // strictly ascending calendar dates (monotonic in time)
        expect(s.points[i].date > s.points[i - 1].date).toBe(true)
      }
      expect(s.points[s.points.length - 1].date).toBe(to)
      expect(s.points[s.points.length - 1].netWorth).toBe(cardTotal.toString())
    }
    // Finer intervals never yield fewer buckets than coarser ones.
    expect(byDay.points.length).toBeGreaterThanOrEqual(byWeek.points.length)
    expect(byWeek.points.length).toBeGreaterThanOrEqual(byMonth.points.length)
    // A date sampled by both day and month resolves to one identical value.
    expect(pointAt(byDay.points, "2026-02-01").netWorth).toBe(
      pointAt(byMonth.points, "2026-02-01").netWorth
    )
  })

  // ---- tenant isolation ------------------------------------------------------

  test("tenant isolation: a non-member user reading the family sees nothing", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(ownerA)
    const ownerB = await factories.createAuthenticatedOnboardedUser()

    // User B is not a member of family A: the RLS membership guard (app.user_id)
    // yields zero rows, so the series is all-zero rather than leaking A's data.
    const leaked = await series(
      ownerA,
      "2026-01-01",
      "2026-03-01",
      "month",
      ownerB.user.id
    )
    for (const point of leaked.points) {
      expect(point.netWorth).toBe("0")
      expect(point.assets).toBe("0")
      expect(point.liabilities).toBe("0")
    }
  })

  test("tenant isolation: family B's series reflects only B's accounts", async () => {
    const ownerA = await factories.createAuthenticatedOnboardedUser()
    await seedMixedFamily(ownerA)
    const ownerB = await factories.createAuthenticatedOnboardedUser()
    await setFamilyDefaults(ownerB, "IDR", "UTC")
    await makeAccount(ownerB, {
      name: "B cash",
      openingBalance: "42000",
      openingDate: "2026-01-01",
    })

    const result = await series(ownerB, "2026-01-01", "2026-01-01", "day")
    expect(pointAt(result.points, "2026-01-01").netWorth).toBe("42000")
  })
})
