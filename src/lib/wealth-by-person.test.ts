import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"

import { encodeRate } from "./fx"
import { normalizeNetWorthAt, type RateResolver } from "./net-worth"
import {
  computeWealthByPerson,
  type WealthAccount,
  type WealthByPerson,
  type WealthHolding,
  type WealthPerson,
} from "./wealth-by-person"

const PEOPLE: WealthPerson[] = [
  { id: "p-hendri", displayName: "Hendri" },
  { id: "p-rahayu", displayName: "Rahayu" },
  { id: "p-dina", displayName: "Dina" },
]

const USD_IDR = encodeRate("16123.457")
const resolveRate: RateResolver = (currency) =>
  currency === "USD" ? USD_IDR : null

function account(
  partial: Partial<WealthAccount> & { id: string }
): WealthAccount {
  return {
    accountClass: "ASSET",
    currency: "IDR",
    balance: 0n,
    ownerId: null,
    jointOwnerId: null,
    jointSharePercent: null,
    ...partial,
  }
}

function run(
  accounts: WealthAccount[],
  holdings: WealthHolding[] = [],
  people: WealthPerson[] = PEOPLE
): WealthByPerson {
  return computeWealthByPerson({
    accounts,
    holdings,
    people,
    resolveRate,
    baseCurrency: "IDR",
  })
}

const nw = (result: WealthByPerson, personId: string) =>
  result.people.find((p) => p.person.id === personId)!.netWorth

describe("computeWealthByPerson — attribution rules", () => {
  it("attributes a single-owner account wholly to that person", () => {
    const r = run([
      account({ id: "a", balance: 1_000_00n, ownerId: "p-hendri" }),
    ])
    expect(nw(r, "p-hendri")).toBe(1_000_00n)
    expect(nw(r, "p-rahayu")).toBe(0n)
    expect(r.unassigned.netWorth).toBe(0n)
    expect(r.unassigned.accountCount).toBe(0)
  })

  it("sends an account with no owner to Shared / unassigned", () => {
    const r = run([account({ id: "a", balance: 500_00n })])
    expect(r.unassigned.netWorth).toBe(500_00n)
    expect(r.unassigned.accountCount).toBe(1)
  })

  it("splits a joint account by the co-owner's share; rounding goes to the primary", () => {
    // 1_001 split 33% to the joint owner: trunc(330.33) = 330 -> primary 671.
    const r = run([
      account({
        id: "a",
        balance: 1_001n,
        ownerId: "p-hendri",
        jointOwnerId: "p-rahayu",
        jointSharePercent: 33,
      }),
    ])
    expect(nw(r, "p-rahayu")).toBe(330n)
    expect(nw(r, "p-hendri")).toBe(671n)
  })

  it("splits a negative (liability) joint balance without creating or losing money", () => {
    const r = run([
      account({
        id: "loan",
        accountClass: "LIABILITY",
        balance: -1_001n,
        ownerId: "p-hendri",
        jointOwnerId: "p-rahayu",
        jointSharePercent: 50,
      }),
    ])
    expect(nw(r, "p-rahayu") + nw(r, "p-hendri")).toBe(-1_001n)
    expect(r.people.every((p) => p.liabilities >= 0n)).toBe(true)
  })

  it("a holding's own owner beats the account owner; the rest follows the account", () => {
    const r = run(
      [
        account({
          id: "bibit",
          balance: 1_000n,
          ownerId: "p-hendri",
        }),
      ],
      [
        { accountId: "bibit", ownerPersonId: "p-rahayu", valueMinor: 300n },
        // Unowned holdings do not matter; they stay in the account remainder.
        { accountId: "bibit", ownerPersonId: null, valueMinor: 200n },
      ]
    )
    expect(nw(r, "p-rahayu")).toBe(300n)
    expect(nw(r, "p-hendri")).toBe(700n) // 200 unowned + 500 residual
    expect(r.unassigned.netWorth).toBe(0n)
  })

  it("an owned holding on an unowned account leaves the remainder unassigned", () => {
    const r = run(
      [account({ id: "bibit", balance: 1_000n })],
      [{ accountId: "bibit", ownerPersonId: "p-rahayu", valueMinor: 400n }]
    )
    expect(nw(r, "p-rahayu")).toBe(400n)
    expect(r.unassigned.netWorth).toBe(600n)
  })

  it("splits the account-level remainder jointly after holding slices", () => {
    const r = run(
      [
        account({
          id: "bibit",
          balance: 1_000n,
          ownerId: "p-hendri",
          jointOwnerId: "p-dina",
          jointSharePercent: 50,
        }),
      ],
      [{ accountId: "bibit", ownerPersonId: "p-rahayu", valueMinor: 400n }]
    )
    expect(nw(r, "p-rahayu")).toBe(400n)
    expect(nw(r, "p-hendri")).toBe(300n)
    expect(nw(r, "p-dina")).toBe(300n)
  })

  it("ignores a holding owner or account owner that is not a known person", () => {
    const r = run(
      [account({ id: "a", balance: 100n, ownerId: "ghost" })],
      [{ accountId: "a", ownerPersonId: "ghost-2", valueMinor: 40n }]
    )
    expect(r.unassigned.netWorth).toBe(100n)
  })

  it("ignores a malformed joint (same person, bad share, no primary)", () => {
    for (const joint of [
      { ownerId: "p-hendri", jointOwnerId: "p-hendri", jointSharePercent: 50 },
      { ownerId: "p-hendri", jointOwnerId: "p-rahayu", jointSharePercent: 0 },
      { ownerId: "p-hendri", jointOwnerId: "p-rahayu", jointSharePercent: 100 },
      { ownerId: null, jointOwnerId: "p-rahayu", jointSharePercent: 50 },
    ]) {
      const r = run([account({ id: "a", balance: 100n, ...joint })])
      const total =
        r.people.reduce((sum, p) => sum + p.netWorth, 0n) +
        r.unassigned.netWorth
      expect(total).toBe(100n)
      expect(nw(r, "p-rahayu")).toBe(0n)
    }
  })

  it("reuses the family normalizer: the family total equals normalizeNetWorthAt", () => {
    const accounts = [
      account({ id: "a", balance: 5_000_00n, ownerId: "p-hendri" }),
      account({
        id: "b",
        currency: "USD",
        balance: 123_45n,
        ownerId: "p-rahayu",
      }),
      account({ id: "c", currency: "EUR", balance: 99n }), // no rate
    ]
    const r = run(accounts)
    const expected = normalizeNetWorthAt(
      accounts.map((a) => ({
        accountClass: a.accountClass,
        currency: a.currency,
        native: a.balance,
      })),
      resolveRate,
      "IDR"
    )
    expect(r.family).toEqual(expected)
    // The unconverted EUR follows its (absent) owner: unassigned.
    expect(r.unassigned.unconverted).toEqual([{ currency: "EUR", native: 99n }])
  })

  it("conserves where splitting NATIVE amounts and converting each half would drift", () => {
    // convertMinor rounds, so convert(a) + convert(b) can differ from
    // convert(a + b) by a minor unit. Find a balance where a 50/50 native split
    // really drifts, then prove the module still conserves it.
    const convertUsd = (n: bigint) =>
      normalizeNetWorthAt(
        [{ accountClass: "ASSET", currency: "USD", native: n }],
        resolveRate,
        "IDR"
      ).netWorth
    let balance = 1n
    while (
      convertUsd(balance / 2n) + convertUsd(balance - balance / 2n) ===
      convertUsd(balance)
    ) {
      balance += 1n
      expect(balance).toBeLessThan(10_000n)
    }
    const r = run([
      account({
        id: "a",
        currency: "USD",
        balance,
        ownerId: "p-hendri",
        jointOwnerId: "p-rahayu",
        jointSharePercent: 50,
      }),
    ])
    expect(nw(r, "p-hendri") + nw(r, "p-rahayu")).toBe(r.family.netWorth)
  })
})

// ---- conservation property ---------------------------------------------------

const CURRENCIES = ["IDR", "USD", "JPY", "EUR"] as const // EUR has no rate

const accountArb = (index: number): fc.Arbitrary<WealthAccount> =>
  fc
    .record({
      isLiability: fc.boolean(),
      currency: fc.constantFrom(...CURRENCIES),
      magnitude: fc.bigInt({ min: 0n, max: 10n ** 13n }),
      ownerIdx: fc.integer({ min: -1, max: PEOPLE.length }), // -1 none, len = ghost
      jointIdx: fc.integer({ min: -1, max: PEOPLE.length }),
      share: fc.integer({ min: 0, max: 100 }),
    })
    .map(({ isLiability, currency, magnitude, ownerIdx, jointIdx, share }) => ({
      id: `acct-${index}`,
      accountClass: isLiability ? "LIABILITY" : "ASSET",
      currency,
      balance: isLiability ? -magnitude : magnitude,
      ownerId: ownerIdx < 0 ? null : (PEOPLE[ownerIdx]?.id ?? "ghost"),
      jointOwnerId: jointIdx < 0 ? null : (PEOPLE[jointIdx]?.id ?? "ghost"),
      jointSharePercent: share === 0 ? null : share,
    }))

const scenarioArb = fc.integer({ min: 0, max: 8 }).chain((count) =>
  fc.tuple(
    fc.tuple(...Array.from({ length: count }, (_, i) => accountArb(i))),
    fc.array(
      fc.record({
        accountIdx: fc.integer({ min: 0, max: Math.max(count - 1, 0) }),
        ownerIdx: fc.integer({ min: -1, max: PEOPLE.length }),
        value: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      }),
      { maxLength: 12 }
    )
  )
)

describe("computeWealthByPerson — conservation property (ADR-0058 D3)", () => {
  it("Σ people + unassigned === family total, exactly, for every component", () => {
    fc.assert(
      fc.property(scenarioArb, ([accounts, rawHoldings]) => {
        const holdings: WealthHolding[] = rawHoldings.flatMap((h) =>
          accounts[h.accountIdx]
            ? [
                {
                  accountId: accounts[h.accountIdx]!.id,
                  ownerPersonId:
                    h.ownerIdx < 0 ? null : (PEOPLE[h.ownerIdx]?.id ?? "ghost"),
                  valueMinor: h.value,
                },
              ]
            : []
        )
        const r = run(accounts, holdings)
        const parts = [...r.people, r.unassigned]
        const sum = (pick: (p: (typeof parts)[number]) => bigint) =>
          parts.reduce((total, p) => total + pick(p), 0n)

        expect(sum((p) => p.netWorth)).toBe(r.family.netWorth)
        expect(sum((p) => p.assets)).toBe(r.family.assets)
        expect(sum((p) => p.liabilities)).toBe(r.family.liabilities)

        // Unconverted currencies conserve too (zero-sum entries are hidden on
        // the per-person side only).
        const familyUnconverted = new Map(
          r.family.unconverted
            .filter((u) => u.native !== 0n)
            .map((u) => [u.currency, u.native])
        )
        const partUnconverted = new Map<string, bigint>()
        for (const p of parts) {
          for (const u of p.unconverted) {
            partUnconverted.set(
              u.currency,
              (partUnconverted.get(u.currency) ?? 0n) + u.native
            )
          }
        }
        const nonZeroParts = new Map(
          [...partUnconverted].filter(([, native]) => native !== 0n)
        )
        expect(nonZeroParts).toEqual(familyUnconverted)
      }),
      { numRuns: 500 }
    )
  })
})
