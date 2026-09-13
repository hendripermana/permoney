import { describe, expect, test } from "vite-plus/test"
import {
  computeZakatForPayers,
  type ZakatCalculationAccount,
} from "./zakat-calculation"
import { hijriAnniversary } from "./zakat-hijri"
import { type AnalyticsTxn } from "./account-analytics"

const HAWL_START = new Date("2025-01-01T00:00:00.000Z")
const ANNIVERSARY = hijriAnniversary(HAWL_START, 1)
const AFTER_ANNIVERSARY = new Date(ANNIVERSARY.getTime() + 86_400_000)
const NISAB = 80_000_000n

function cashAccount(
  overrides: Partial<ZakatCalculationAccount> = {}
): ZakatCalculationAccount {
  return {
    id: "acc",
    name: "Cash account",
    accountClass: "ASSET",
    accountType: "DEPOSITORY",
    balance: 0n,
    zakatPayerId: null,
    zakatJointPayerId: null,
    zakatJointSharePercent: null,
    transactions: [],
    ...overrides,
  }
}

function expense(accountId: string, amount: bigint, date: Date): AnalyticsTxn {
  return { date, amount, type: "expense", accountId }
}
function income(accountId: string, amount: bigint, date: Date): AnalyticsTxn {
  return { date, amount, type: "income", accountId }
}

describe("computeZakatForPayers", () => {
  describe("single payer, constant wealth", () => {
    test("below nisab throughout: never eligible, zero owed", () => {
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts: [cashAccount({ id: "a1", balance: 40_000_000n })],
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(result.eligible).toBe(false)
      expect(result.zakatOwedMinor).toBe(0n)
    })

    test("above nisab throughout: eligible at the anniversary, owes exactly 2.5%", () => {
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts: [cashAccount({ id: "a1", balance: 100_000_000n })],
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(result.eligible).toBe(true)
      expect(result.snapshotNetWealthMinor).toBe(100_000_000n)
      expect(result.zakatOwedMinor).toBe(2_500_000n)
      expect(result.hawlAnniversaryDate.getTime()).toBe(ANNIVERSARY.getTime())
    })

    test("Hawl not yet complete: not eligible even with ample wealth", () => {
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts: [cashAccount({ id: "a1", balance: 500_000_000n })],
        nisabValueMinor: NISAB,
        now: new Date(HAWL_START.getTime() + 30 * 86_400_000),
      })
      expect(result.eligible).toBe(false)
      expect(result.zakatOwedMinor).toBe(0n)
    })
  })

  describe("jumhur_continuous vs hanafi_start_end on the SAME dip-then-recover data", () => {
    const dipDate = new Date(HAWL_START.getTime() + 100 * 86_400_000)
    const recoverDate = new Date(HAWL_START.getTime() + 200 * 86_400_000)
    const accounts: ZakatCalculationAccount[] = [
      cashAccount({
        id: "a1",
        balance: 100_000_000n,
        transactions: [
          expense("a1", 95_000_000n, dipDate), // -> 5,000,000 (below nisab)
          income("a1", 95_000_000n, recoverDate), // -> back to 100,000,000
        ],
      }),
    ]

    test("jumhur_continuous: the mid-year dip breaks the Hawl, hawlBrokenAt is the exact dip date", () => {
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(result.eligible).toBe(false)
      expect(result.zakatOwedMinor).toBe(0n)
      expect(result.hawlBrokenAt?.getTime()).toBe(dipDate.getTime())
    })

    test("hanafi_start_end: the SAME dip is irrelevant — only start/end matter, so this payer IS eligible", () => {
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "hanafi_start_end",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(result.eligible).toBe(true)
      expect(result.hawlBrokenAt).toBeNull()
      expect(result.snapshotNetWealthMinor).toBe(100_000_000n)
      expect(result.zakatOwedMinor).toBe(2_500_000n)
    })

    test("a NEW Hawl beginning from the broken date computes correctly on a subsequent call", () => {
      const [first] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      const newStart = first.hawlBrokenAt!
      expect(newStart.getTime()).toBe(dipDate.getTime())
      const newAnniversary = hijriAnniversary(newStart, 1)

      // A completely fresh, independent calculation — the household's wealth
      // recovered and has stayed flat and above nisab from `newStart`
      // onward, so the SAME function, given the confirmed new start date,
      // reports a clean, unbroken Hawl (proving the reset is not "sticky"
      // state carried between calls — this module is pure/stateless).
      const [second] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: newStart,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts: [cashAccount({ id: "a1", balance: 100_000_000n })],
        nisabValueMinor: NISAB,
        now: new Date(newAnniversary.getTime() + 86_400_000),
      })
      expect(second.hawlBrokenAt).toBeNull()
      expect(second.eligible).toBe(true)
      expect(second.zakatOwedMinor).toBe(2_500_000n)
    })
  })

  describe("two payers — never pooled (ADR-0056's central correction)", () => {
    test("both individually under nisab: pooled total would cross it, but NEITHER owes anything", () => {
      const accounts: ZakatCalculationAccount[] = [
        cashAccount({ id: "a1", balance: 40_000_000n, zakatPayerId: "p1" }),
        cashAccount({ id: "a2", balance: 40_000_000n, zakatPayerId: "p2" }),
      ]
      // Pooled: 80,000,000 == nisab (would cross/meet it if wrongly pooled).
      const results = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [
          { id: "p1", displayName: "Suami" },
          { id: "p2", displayName: "Istri" },
        ],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(results).toHaveLength(2)
      for (const r of results) {
        expect(r.eligible).toBe(false)
        expect(r.zakatOwedMinor).toBe(0n)
      }
    })

    test("one above, one below: only the above-nisab payer owes anything, on THEIR wealth only", () => {
      const accounts: ZakatCalculationAccount[] = [
        cashAccount({ id: "a1", balance: 100_000_000n, zakatPayerId: "p1" }),
        cashAccount({ id: "a2", balance: 40_000_000n, zakatPayerId: "p2" }),
      ]
      const [p1, p2] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [
          { id: "p1", displayName: "Suami" },
          { id: "p2", displayName: "Istri" },
        ],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(p1.eligible).toBe(true)
      expect(p1.snapshotNetWealthMinor).toBe(100_000_000n)
      expect(p1.zakatOwedMinor).toBe(2_500_000n)
      expect(p2.eligible).toBe(false)
      expect(p2.zakatOwedMinor).toBe(0n)
    })

    test("an untagged account is excluded from EVERY payer's total and listed as unattributed", () => {
      const accounts: ZakatCalculationAccount[] = [
        cashAccount({ id: "a1", balance: 100_000_000n, zakatPayerId: "p1" }),
        cashAccount({ id: "a2", balance: 40_000_000n, zakatPayerId: "p2" }),
        cashAccount({ id: "a3", balance: 999_000_000n, zakatPayerId: null }),
      ]
      const [p1, p2] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [
          { id: "p1", displayName: "Suami" },
          { id: "p2", displayName: "Istri" },
        ],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(p1.snapshotNetWealthMinor).toBe(100_000_000n)
      expect(p2.snapshotNetWealthMinor).toBe(40_000_000n)
      expect(p1.unattributedAccountIds).toEqual(["a3"])
      expect(p2.unattributedAccountIds).toEqual(["a3"])
    })

    test("joint 50:50 account's dip is attributed to BOTH owners at the correct proportion, historically", () => {
      const dipDate = new Date(HAWL_START.getTime() + 100 * 86_400_000)
      const recoverDate = new Date(HAWL_START.getTime() + 200 * 86_400_000)
      const jointAccount = cashAccount({
        id: "joint",
        balance: 200_000_000n, // 100M / 100M split
        zakatPayerId: "p1",
        zakatJointPayerId: "p2",
        zakatJointSharePercent: 50,
        transactions: [
          expense("joint", 60_000_000n, dipDate), // -> 140M (70M/70M, BOTH below 80M nisab)
          income("joint", 60_000_000n, recoverDate), // -> back to 200M
        ],
      })

      const jumhurResults = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [
          { id: "p1", displayName: "Suami" },
          { id: "p2", displayName: "Istri" },
        ],
        accounts: [jointAccount],
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      for (const r of jumhurResults) {
        expect(r.hawlBrokenAt?.getTime()).toBe(dipDate.getTime())
        expect(r.eligible).toBe(false)
      }

      const hanafiResults = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "hanafi_start_end",
          hawlStartDate: HAWL_START,
        },
        payers: [
          { id: "p1", displayName: "Suami" },
          { id: "p2", displayName: "Istri" },
        ],
        accounts: [jointAccount],
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      for (const r of hanafiResults) {
        expect(r.eligible).toBe(true)
        expect(r.snapshotNetWealthMinor).toBe(100_000_000n) // 50% of 200M
        expect(r.zakatOwedMinor).toBe(2_500_000n)
      }
    })
  })

  describe("debt deduction", () => {
    test("CREDIT deducts the full outstanding balance", () => {
      const accounts: ZakatCalculationAccount[] = [
        cashAccount({ id: "cash", balance: 100_000_000n }),
        cashAccount({
          id: "cc",
          accountClass: "LIABILITY",
          accountType: "CREDIT",
          balance: -30_000_000n,
        }),
      ]
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      expect(result.snapshotNetWealthMinor).toBe(70_000_000n)
      expect(result.eligible).toBe(false) // 70M < 80M nisab
    })

    test("LOAN deducts only the next-due installment, never the full remaining principal", () => {
      // 24 payments, 30 days apart, the LAST one landing exactly on `now`
      // (AFTER_ANNIVERSARY) — this test is about the DEDUCTION AMOUNT
      // (next installment only, never the full principal), not about the
      // recurring-cadence honesty guard's staleness cutoff.
      const loanPayments: AnalyticsTxn[] = Array.from(
        { length: 24 },
        (_, i) => ({
          date: new Date(
            AFTER_ANNIVERSARY.getTime() - (23 - i) * 30 * 86_400_000
          ),
          amount: 5_000_000n,
          type: "transfer",
          kind: "loan_payment",
          accountId: "cash",
          toAccountId: "loan",
        })
      )
      const accounts: ZakatCalculationAccount[] = [
        cashAccount({ id: "cash", balance: 100_000_000n }),
        cashAccount({
          id: "loan",
          accountClass: "LIABILITY",
          accountType: "LOAN",
          balance: -120_000_000n, // full remaining principal — must NOT be deducted wholesale
          transactions: loanPayments,
        }),
      ]
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      // 100,000,000 - 5,000,000 (one installment) = 95,000,000 >= nisab.
      // If the full principal were wrongly deducted: 100M - 120M < 0.
      expect(result.snapshotNetWealthMinor).toBe(95_000_000n)
      expect(result.eligible).toBe(true)
      expect(result.zakatOwedMinor).toBe(2_375_000n)
      const loanEntry = result.debtDeducted.find((d) => d.accountId === "loan")
      expect(loanEntry?.attributedAmountMinor).toBe(5_000_000n)
    })

    // Real bug caught in review: applying today's loan-deduction constant to
    // every reconstructed historical day — including dates before the loan
    // was ever taken out — would fabricate a debt that didn't exist yet and
    // could wrongly report a Hawl-breaking dip at a point where the payer's
    // real wealth never actually fell. A loan must only reduce wealth from
    // its own first transaction (the draw) onward.
    test("a loan taken out MID-HAWL never reduces wealth before its own first transaction", () => {
      const loanTakenOutDate = new Date(HAWL_START.getTime() + 200 * 86_400_000)
      const loanPayments: AnalyticsTxn[] = [
        {
          date: loanTakenOutDate,
          amount: 90_000_000n,
          type: "transfer",
          kind: "liability_draw",
          accountId: "loan",
          toAccountId: "cash",
        },
        // 3 monthly repayments so estimateNextLoanInstallment can determine
        // a cadence (matches account-recurring.ts's minOccurrences).
        ...Array.from({ length: 3 }, (_, i) => ({
          date: new Date(
            loanTakenOutDate.getTime() + (i + 1) * 30 * 86_400_000
          ),
          amount: 5_000_000n,
          type: "transfer" as const,
          kind: "loan_payment",
          accountId: "cash",
          toAccountId: "loan",
        })),
      ]
      // Opening cash (before the loan exists) is 82,000,000 — comfortably
      // above the 80,000,000 nisab ON ITS OWN, but would WRONGLY dip below
      // it if the loan's 5,000,000 next-installment deduction were (bug)
      // backdated onto this period. This is what actually discriminates the
      // fix from the bug — a test where the pre-loan balance is already far
      // above nisab either way would pass under both the buggy and fixed
      // code and prove nothing.
      const accounts: ZakatCalculationAccount[] = [
        cashAccount({
          id: "cash",
          balance: 157_000_000n, // 82M opening + 90M draw − 15M repaid
          transactions: [
            income("cash", 90_000_000n, loanTakenOutDate),
            expense("cash", 5_000_000n, new Date(loanPayments[1]!.date)),
            expense("cash", 5_000_000n, new Date(loanPayments[2]!.date)),
            expense("cash", 5_000_000n, new Date(loanPayments[3]!.date)),
          ],
        }),
        cashAccount({
          id: "loan",
          accountClass: "LIABILITY",
          accountType: "LOAN",
          balance: -75_000_000n, // -90M draw + 15M repaid
          transactions: loanPayments,
        }),
      ]
      const [result] = computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [{ id: "p1", displayName: "Saya" }],
        accounts,
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
      // Before the loan existed (days 0-200), reconstructed cash sat flat at
      // 82,000,000 — above nisab. The loan's later deduction must NOT be
      // backdated onto that period (the bug this test catches), so the Hawl
      // stays unbroken.
      expect(result.hawlBrokenAt).toBeNull()
      expect(result.eligible).toBe(true)
      // At the anniversary: 157,000,000 cash − 5,000,000 next installment.
      expect(result.snapshotNetWealthMinor).toBe(152_000_000n)
    })
  })

  test("throws when called with zero payers (server must always synthesize an implicit one)", () => {
    expect(() =>
      computeZakatForPayers({
        settings: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: HAWL_START,
        },
        payers: [],
        accounts: [],
        nisabValueMinor: NISAB,
        now: AFTER_ANNIVERSARY,
      })
    ).toThrow()
  })
})
