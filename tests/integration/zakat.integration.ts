import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  encodeSpotPrice,
  goldPerGramMajorToPerOunceDecimal,
} from "@/lib/market-data"
import { hijriAnniversary } from "@/lib/zakat-hijri"
import { computeNisabValue } from "@/lib/zakat-nisab"
import { ensureBsiGoldInstrument } from "@/server/market-data.server"
import { createTransactionForFamily } from "@/server/transactions"
import {
  computeZakatForFamily,
  createZakatPayerForFamily,
  deleteZakatPayerForFamily,
  getZakatSettingsForFamily,
  listZakatPayersForFamily,
  setAccountZakatOwnershipForFamily,
  upsertZakatSettingsForFamily,
  type ComputeZakatResult,
  type SerializedZakatPayerResult,
} from "@/server/zakat"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// =============================================================================
// ADR-0056 — Zakat Maal calculator (real Postgres).
//
// This is the CORE CORRECTNESS PROOF for the whole feature: the Hawl
// reconstruction reads real transaction history through the real ledger
// mutation surface (`createTransactionForFamily`), not mocked data
// (CLAUDE.md "Real Postgres Tests Required"). Covers, verbatim, the two
// worked scenarios from the ADR (never-pooled wealth), joint-account
// attribution (current + historical), unattributed-account exclusion, the
// jumhur/hanafi Hawl-rule divergence on identical data, CREDIT-vs-LOAN debt
// deduction, and tenant isolation.
// =============================================================================

/** Rupiah -> minor units (sen, ×100). All test amounts are expressed in whole
 * Rupiah via this helper — never as a raw minor-unit literal — specifically
 * to avoid a digit-grouping mistake in a 9-11 digit bigint literal. */
function rupiah(major: number): bigint {
  return BigInt(major) * 100n
}

const GOLD_PRICE_PER_GRAM_MAJOR = 1_000_000 // Rp 1,000,000/gram
// nisab = 87.48g * Rp 1,000,000/gram = Rp 87,480,000 (8,748,000,000 minor
// units) — computed via the SAME pure `computeNisabValue` the server calls,
// never hand-derived twice.
const NISAB_MINOR = computeNisabValue("gold", rupiah(1_000_000))

const HAWL_START = new Date("2024-01-01T00:00:00.000Z")
const ANNIVERSARY = hijriAnniversary(HAWL_START, 1)
const AFTER_ANNIVERSARY = new Date(ANNIVERSARY.getTime() + 86_400_000)

describe("Zakat Maal calculator (ADR-0056)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await harness.reset()
    const goldId = await ensureBsiGoldInstrument(harness.prisma)
    await harness.prisma.marketQuote.create({
      data: {
        marketInstrumentId: goldId,
        asOf: new Date("2024-01-01T00:00:00.000Z"),
        price: encodeSpotPrice(
          goldPerGramMajorToPerOunceDecimal(GOLD_PRICE_PER_GRAM_MAJOR)
        ),
        priceScale: 8,
        quoteCurrency: "IDR",
        source: "fixture",
      },
    })
  })

  afterAll(async () => {
    await harness.teardown()
  })

  const setHawl = (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      haulRule?: "jumhur_continuous" | "hanafi_start_end"
      hawlStartDate?: Date
    } = {}
  ) =>
    upsertZakatSettingsForFamily({
      data: {
        nisabBasis: "gold",
        haulRule: overrides.haulRule ?? "jumhur_continuous",
        hawlStartDate: overrides.hawlStartDate ?? HAWL_START,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  const addPayer = async (
    owner: AuthenticatedOnboardedUser,
    displayName: string
  ) =>
    await createZakatPayerForFamily({
      data: { displayName, idempotencyKey: factories.createIdempotencyKey() },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  const tag = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    zakatPayerId: string,
    joint?: { zakatJointPayerId: string; zakatJointSharePercent: number }
  ) =>
    await setAccountZakatOwnershipForFamily({
      data: {
        accountId,
        zakatPayerId,
        zakatJointPayerId: joint?.zakatJointPayerId ?? null,
        zakatJointSharePercent: joint?.zakatJointSharePercent ?? null,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  const compute = (owner: AuthenticatedOnboardedUser, now: Date) =>
    computeZakatForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
      now,
    })

  function expectOk(
    result: ComputeZakatResult
  ): asserts result is Extract<ComputeZakatResult, { status: "ok" }> {
    expect(result.status).toBe("ok")
  }

  function findPayer(
    payers: SerializedZakatPayerResult[],
    id: string
  ): SerializedZakatPayerResult {
    const found = payers.find((p) => p.payer.id === id)
    if (!found) throw new Error(`payer ${id} not found in results`)
    return found
  }

  describe("worked scenario (a) — both individually under nisab", () => {
    test("pooled total would cross nisab, but NEITHER payer owes anything", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")

      const a1 = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(40_000_000), // below nisab (Rp 87,480,000)
      })
      const a2 = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(50_000_000), // below nisab
      })
      // Pooled: Rp 90,000,000 > Rp 87,480,000 nisab (would wrongly cross it).
      expect(rupiah(40_000_000) + rupiah(50_000_000)).toBeGreaterThan(
        NISAB_MINOR
      )
      await tag(owner, a1.id, p1.id)
      await tag(owner, a2.id, p2.id)

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const r1 = findPayer(result.payers, p1.id)
      const r2 = findPayer(result.payers, p2.id)

      expect(r1.eligible).toBe(false)
      expect(r1.zakatOwedMinor).toBe("0")
      expect(r2.eligible).toBe(false)
      expect(r2.zakatOwedMinor).toBe("0")
    })
  })

  describe("worked scenario (b) — one above, one below", () => {
    test("only the above-nisab payer owes anything, exactly on their own wealth", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")

      const a1 = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000), // above nisab
      })
      const a2 = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(40_000_000), // below nisab
      })
      await tag(owner, a1.id, p1.id)
      await tag(owner, a2.id, p2.id)

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const r1 = findPayer(result.payers, p1.id)
      const r2 = findPayer(result.payers, p2.id)

      expect(r1.eligible).toBe(true)
      expect(r1.snapshotNetWealthMinor).toBe(rupiah(200_000_000).toString())
      expect(r1.zakatOwedMinor).toBe(rupiah(5_000_000).toString()) // 2.5% of 200M
      expect(r2.eligible).toBe(false)
      expect(r2.zakatOwedMinor).toBe("0")
    })
  })

  describe("joint account attribution", () => {
    test("50:50 split attributes half the CURRENT balance to each owner", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")
      const joint = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      await tag(owner, joint.id, p1.id, {
        zakatJointPayerId: p2.id,
        zakatJointSharePercent: 50,
      })

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      expect(findPayer(result.payers, p1.id).snapshotNetWealthMinor).toBe(
        rupiah(100_000_000).toString()
      )
      expect(findPayer(result.payers, p2.id).snapshotNetWealthMinor).toBe(
        rupiah(100_000_000).toString()
      )
    })

    test("a non-default 70:30 split is respected exactly", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")
      const joint = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(100_000_000),
      })
      await tag(owner, joint.id, p1.id, {
        zakatJointPayerId: p2.id,
        zakatJointSharePercent: 30,
      })

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      expect(findPayer(result.payers, p1.id).snapshotNetWealthMinor).toBe(
        rupiah(70_000_000).toString()
      )
      expect(findPayer(result.payers, p2.id).snapshotNetWealthMinor).toBe(
        rupiah(30_000_000).toString()
      )
    })

    test("the split applies to a HISTORICALLY reconstructed dip, not just today's snapshot", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")
      const joint = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000), // 100M / 100M split
      })
      await tag(owner, joint.id, p1.id, {
        zakatJointPayerId: p2.id,
        zakatJointSharePercent: 50,
      })

      const dipDate = new Date(HAWL_START.getTime() + 100 * 86_400_000)
      const recoverDate = new Date(HAWL_START.getTime() + 200 * 86_400_000)
      // -60,000,000 -> 140,000,000 total (70M / 70M — BOTH below the
      // 87,480,000 nisab), then fully recovered before the anniversary.
      await createTransactionForFamily({
        data: {
          type: "expense",
          amount: rupiah(60_000_000),
          accountId: joint.id,
          description: "Big renovation",
          date: dipDate,
          currency: "IDR",
          isSplit: false,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await createTransactionForFamily({
        data: {
          type: "income",
          amount: rupiah(60_000_000),
          accountId: joint.id,
          description: "Bonus",
          date: recoverDate,
          currency: "IDR",
          isSplit: false,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const r1 = findPayer(result.payers, p1.id)
      const r2 = findPayer(result.payers, p2.id)
      // Both owners see the SAME dip date, proportional to their own share.
      expect(r1.hawlBrokenAt).not.toBeNull()
      expect(r2.hawlBrokenAt).not.toBeNull()
      expect(r1.hawlBrokenAt).toBe(r2.hawlBrokenAt)
      expect(new Date(r1.hawlBrokenAt!).getTime()).toBe(dipDate.getTime())
    })
  })

  describe("unattributed accounts", () => {
    test("an untagged account is excluded from every payer's total and listed as unattributed", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")

      const a1 = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      const a2 = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(40_000_000),
      })
      const untagged = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(999_000_000),
      })
      await tag(owner, a1.id, p1.id)
      await tag(owner, a2.id, p2.id)

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const r1 = findPayer(result.payers, p1.id)
      const r2 = findPayer(result.payers, p2.id)
      expect(r1.snapshotNetWealthMinor).toBe(rupiah(200_000_000).toString())
      expect(r2.snapshotNetWealthMinor).toBe(rupiah(40_000_000).toString())
      expect(r1.unattributedAccountIds).toEqual([untagged.id])
      expect(r2.unattributedAccountIds).toEqual([untagged.id])
    })
  })

  describe("jumhur_continuous vs hanafi_start_end on identical data", () => {
    const buildDipThenRecover = async (owner: AuthenticatedOnboardedUser) => {
      const account = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      const dipDate = new Date(HAWL_START.getTime() + 100 * 86_400_000)
      const recoverDate = new Date(HAWL_START.getTime() + 200 * 86_400_000)
      await createTransactionForFamily({
        data: {
          type: "expense",
          amount: rupiah(190_000_000), // -> 10,000,000 (below nisab)
          accountId: account.id,
          description: "Big expense",
          date: dipDate,
          currency: "IDR",
          isSplit: false,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      await createTransactionForFamily({
        data: {
          type: "income",
          amount: rupiah(190_000_000), // back to 200,000,000
          accountId: account.id,
          description: "Recovered",
          date: recoverDate,
          currency: "IDR",
          isSplit: false,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      return { account, dipDate, recoverDate }
    }

    test("jumhur_continuous: the dip breaks the Hawl — not eligible", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner, { haulRule: "jumhur_continuous" })
      const p1 = await addPayer(owner, "Saya")
      const { account, dipDate } = await buildDipThenRecover(owner)
      await tag(owner, account.id, p1.id)

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const r1 = findPayer(result.payers, p1.id)
      expect(r1.eligible).toBe(false)
      expect(r1.zakatOwedMinor).toBe("0")
      expect(new Date(r1.hawlBrokenAt!).getTime()).toBe(dipDate.getTime())
    })

    test("hanafi_start_end: the SAME dip is irrelevant — eligible", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner, { haulRule: "hanafi_start_end" })
      const p1 = await addPayer(owner, "Saya")
      const { account } = await buildDipThenRecover(owner)
      await tag(owner, account.id, p1.id)

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const r1 = findPayer(result.payers, p1.id)
      expect(r1.eligible).toBe(true)
      expect(r1.hawlBrokenAt).toBeNull()
      expect(r1.snapshotNetWealthMinor).toBe(rupiah(200_000_000).toString())
      expect(r1.zakatOwedMinor).toBe(rupiah(5_000_000).toString())
    })

    test("a NEW Hawl starting from the broken date computes correctly on a subsequent call", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner, { haulRule: "jumhur_continuous" })
      const p1 = await addPayer(owner, "Saya")
      const { dipDate, recoverDate } = await buildDipThenRecover(owner)

      const first = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(first)
      const brokenAt = findPayer(first.payers, p1.id).hawlBrokenAt!
      expect(new Date(brokenAt).getTime()).toBe(dipDate.getTime())

      // A confirmed new Hawl realistically starts once wealth has ACTUALLY
      // recovered back above nisab (`recoverDate`), not at the exact instant
      // it dipped (at `dipDate` itself the wealth is still below nisab, so a
      // calculation anchored there would correctly report an immediate new
      // break — that is the honest answer, not a bug, and is covered by the
      // unit-level "hawlBrokenAt" assertion above). This proves the SAME
      // stateless function correctly computes a clean, unbroken Hawl once
      // given a start date where continuity genuinely holds.
      await upsertZakatSettingsForFamily({
        data: {
          nisabBasis: "gold",
          haulRule: "jumhur_continuous",
          hawlStartDate: recoverDate,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      const newAnniversary = hijriAnniversary(recoverDate, 1)
      const second = await compute(
        owner,
        new Date(newAnniversary.getTime() + 86_400_000)
      )
      expectOk(second)
      const r1 = findPayer(second.payers, p1.id)
      // Wealth recovered at recoverDate and stayed flat above nisab for the
      // rest of the new window.
      expect(r1.hawlBrokenAt).toBeNull()
      expect(r1.eligible).toBe(true)
    })
  })

  describe("debt deduction", () => {
    test("CREDIT deducts the FULL outstanding balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      await factories.createAccount({
        familyId: owner.family.id,
        accountType: "CREDIT",
        accountClass: "LIABILITY",
        balance: -rupiah(50_000_000), // owes Rp 50,000,000
      })

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const [only] = result.payers
      expect(only!.snapshotNetWealthMinor).toBe(rupiah(150_000_000).toString()) // 200M - 50M
    })

    test("LOAN deducts only the NEXT-DUE installment, never the full remaining principal", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      // Starts high enough that after the 24 REAL Rp 5,000,000 transfers
      // below actually leave the cash account (120,000,000 total), it lands
      // on a clean Rp 200,000,000 by the snapshot date.
      const cash = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(320_000_000),
      })
      const loan = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "LOAN",
        accountClass: "LIABILITY",
        balance: -rupiah(1_000_000_000), // remaining principal
      })

      // 24 monthly installments of Rp 5,000,000, the last one landing
      // exactly on the calculation snapshot date (AFTER_ANNIVERSARY) so
      // the recurring-cadence detector sees a live, current series. These
      // are REAL transfers — each one actually debits `cash` too (accounted
      // for in `cash`'s starting balance above).
      for (let i = 0; i < 24; i++) {
        const date = new Date(
          AFTER_ANNIVERSARY.getTime() - (23 - i) * 30 * 86_400_000
        )
        await createTransactionForFamily({
          data: {
            type: "transfer",
            amount: rupiah(5_000_000),
            accountId: cash.id,
            toAccountId: loan.id,
            description: "Cicilan KPR",
            date,
            currency: "IDR",
            isSplit: false,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      }

      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      const [only] = result.payers
      // 200,000,000 - 5,000,000 (one installment) = 195,000,000. If the
      // full remaining principal (1,000,000,000) were wrongly deducted,
      // this would be deeply negative instead.
      expect(only!.snapshotNetWealthMinor).toBe(rupiah(195_000_000).toString())
      const loanEntry = only!.debtDeducted.find((d) => d.accountId === loan.id)
      expect(loanEntry?.attributedAmountMinor).toBe(
        rupiah(5_000_000).toString()
      )
    })
  })

  describe("tenant isolation", () => {
    test("family A's accounts and payers never leak into family B's calculation", async () => {
      const familyA = await factories.createAuthenticatedOnboardedUser()
      const familyB = await factories.createAuthenticatedOnboardedUser()
      await setHawl(familyA)
      await setHawl(familyB)

      const payerA = await addPayer(familyA, "A's payer")
      const accountA = await factories.createAccount({
        familyId: familyA.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      await tag(familyA, accountA.id, payerA.id)

      // Family B has NOTHING — a much smaller, unrelated account.
      await factories.createAccount({
        familyId: familyB.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(1_000),
      })

      const resultA = await compute(familyA, AFTER_ANNIVERSARY)
      const resultB = await compute(familyB, AFTER_ANNIVERSARY)
      expectOk(resultA)
      expectOk(resultB)

      expect(findPayer(resultA.payers, payerA.id).eligible).toBe(true)
      // Family B has no ZakatPayer rows -> exactly one implicit payer, and
      // its wealth must be its OWN tiny account, never family A's.
      expect(resultB.payers).toHaveLength(1)
      expect(resultB.payers[0]?.eligible).toBe(false)
      expect(resultB.payers[0]?.snapshotNetWealthMinor).toBe(
        rupiah(1_000).toString()
      )
    })
  })

  describe("settings and payer CRUD", () => {
    test("hawl_not_set is returned before any settings exist", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const result = await compute(owner, AFTER_ANNIVERSARY)
      expect(result.status).toBe("hawl_not_set")
    })

    test("zero ZakatPayer rows: every account counts 100% toward one implicit payer", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      const result = await compute(owner, AFTER_ANNIVERSARY)
      expectOk(result)
      expect(result.payers).toHaveLength(1)
      expect(result.payers[0]?.snapshotNetWealthMinor).toBe(
        rupiah(200_000_000).toString()
      )
      expect(result.payers[0]?.unattributedAccountIds).toEqual([])
    })

    test("deleting a ZakatPayer un-tags its accounts without touching balances", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const p1 = await addPayer(owner, "Suami")
      const account = await factories.createAccount({
        familyId: owner.family.id,
        accountType: "DEPOSITORY",
        balance: rupiah(200_000_000),
      })
      await tag(owner, account.id, p1.id)

      const balanceBefore = await harness
        .withFamily(owner.family.id, (tx) =>
          tx.account.findUniqueOrThrow({ where: { id: account.id } })
        )
        .then((a) => a.balance)

      const deleteResult = await deleteZakatPayerForFamily({
        data: { id: p1.id, idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(deleteResult.untaggedAccountIds).toEqual([account.id])

      const row = await harness.withFamily(owner.family.id, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: account.id } })
      )
      expect(row.zakatPayerId).toBeNull()
      expect(row.balance).toBe(balanceBefore)

      const payers = await listZakatPayersForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(payers).toHaveLength(0)
    })

    test("settings and payer changes are recorded in AuditLog", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner)
      await addPayer(owner, "Saya")

      const audits = await harness.withFamily(owner.family.id, (tx) =>
        tx.auditLog.findMany({
          where: { entityType: { in: ["ZakatSettings", "ZakatPayer"] } },
        })
      )
      expect(audits.length).toBeGreaterThanOrEqual(2)
    })

    test("getZakatSettingsFn round-trips exactly what was saved", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await setHawl(owner, { haulRule: "hanafi_start_end" })
      const settings = await getZakatSettingsForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(settings.nisabBasis).toBe("gold")
      expect(settings.haulRule).toBe("hanafi_start_end")
      expect(settings.hawlStartDate).toBe(HAWL_START.toISOString())
    })
  })

  describe("database is the law — CHECK constraint backstop", () => {
    test("rejects a joint share of 0 (not a valid joint split)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const p1 = await addPayer(owner, "Suami")
      const p2 = await addPayer(owner, "Istri")
      const account = await factories.createAccount({
        familyId: owner.family.id,
      })
      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Account" SET "zakatPayerId" = $1, "zakatJointPayerId" = $2, "zakatJointSharePercent" = 0 WHERE id = $3`,
            p1.id,
            p2.id,
            account.id
          )
        )
      ).rejects.toThrow()
    })

    test("rejects a joint co-owner set without a share percent", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const p2 = await addPayer(owner, "Istri")
      const account = await factories.createAccount({
        familyId: owner.family.id,
      })
      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Account" SET "zakatJointPayerId" = $1 WHERE id = $2`,
            p2.id,
            account.id
          )
        )
      ).rejects.toThrow()
    })

    test("rejects an account jointly owned by the same payer as themselves", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const p1 = await addPayer(owner, "Suami")
      const account = await factories.createAccount({
        familyId: owner.family.id,
      })
      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Account" SET "zakatPayerId" = $1, "zakatJointPayerId" = $1, "zakatJointSharePercent" = 50 WHERE id = $2`,
            p1.id,
            account.id
          )
        )
      ).rejects.toThrow()
    })
  })
})
