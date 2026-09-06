import type { AccountType } from "@/lib/accounts"
import { createAccountForFamily } from "@/server/accounts"
import { recordTradeForFamily } from "@/server/holdings"
import type { AuthenticatedOnboardedUser, TestFactories } from "./factories"

// Shared holdings-test fixtures — extracted from position-moves/switches/
// distributions/fees integration tests, which had each grown their own
// near-identical copy of "make an investment account", "make a cash
// account", and "seed a position via a Buy" (SonarCloud flagged the
// resulting cross-file duplication on PER-259 Slice 6's new tests). Only
// `position-moves.integration.ts` has been migrated to this shared module so
// far — the other three keep their own copies for now; migrating them is a
// separate, out-of-scope cleanup, not bundled into this PR.

export const makeInvestmentAccount = async (
  factories: TestFactories,
  owner: AuthenticatedOnboardedUser,
  name = "Reksadana",
  currencyOverride?: string
) =>
  await createAccountForFamily({
    data: {
      name,
      accountType: "TRACKED_ASSET" as AccountType,
      accountSubtype: "brokerage",
      openingBalance: "0",
      ...(currencyOverride ? { currency: currencyOverride } : {}),
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId: owner.family.id,
    user: owner.user,
  })

export const makeCashAccount = async (
  factories: TestFactories,
  owner: AuthenticatedOnboardedUser,
  name = "Checking",
  openingBalance = "5000000"
) =>
  await createAccountForFamily({
    data: {
      name,
      accountType: "DEPOSITORY" as AccountType,
      openingBalance,
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId: owner.family.id,
    user: owner.user,
  })

// Buys `quantity` units @ `unitPrice` in `investmentId`, funded from
// `fundingId`. `instrument` creates a brand-new Instrument row inline; pass
// an existing `instrumentId` instead to buy a SECOND position in the SAME
// instrument (e.g. seeding an existing destination holding to move into) —
// an inline `instrument` object is never deduplicated by name, so reusing the
// same literal across two calls would silently create two distinct
// instruments.
export const seedPosition = async (
  factories: TestFactories,
  owner: AuthenticatedOnboardedUser,
  investmentId: string,
  fundingId: string,
  instrument: { kind: "mutual_fund"; name: string } | { instrumentId: string },
  quantity: string,
  unitPrice: string
) => {
  const cashAmount = (BigInt(quantity) * BigInt(unitPrice)).toString()
  const buy = await recordTradeForFamily({
    data: {
      investmentAccountId: investmentId,
      fundingAccountId: fundingId,
      ...("instrumentId" in instrument
        ? { instrumentId: instrument.instrumentId }
        : { instrument }),
      side: "buy",
      cashAmount,
      quantity,
      unitPrice,
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId: owner.family.id,
    user: owner.user,
  })
  return {
    instrumentId: buy.holding?.instrumentId ?? "",
    holdingId: buy.holding?.id ?? "",
  }
}
