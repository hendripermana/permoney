import {
  normalizeNetWorthAt,
  type NetWorthBreakdown,
  type RateResolver,
} from "@/lib/net-worth"

// =============================================================================
// ADR-0058 D3 — Wealth by person.
//
// Pure, derived-on-read attribution of the family's net worth to PEOPLE (the
// existing `ZakatPayer` rows). It never re-implements FX or anchor math: every
// converted amount comes out of `normalizeNetWorthAt`, the SAME normalizer the
// family `NetWorthInBaseCard` and the net-worth series use (ADR-0038 §5).
//
// Effective owner of value, most specific first:
//   1. a holding's own owner (`Holding.ownerPersonId`);
//   2. the account's owner, with a joint co-owner taking `jointSharePercent`
//      of the account-level remainder and the PRIMARY owner keeping every
//      integer-rounding leftover;
//   3. nobody -> "Shared / unassigned".
// A holdings account's balance minus Σ owned holdings (unowned holdings plus any
// anchor residual) is the "account-level remainder" of step 2.
//
// CONSERVATION (the invariant this module exists to keep): Σ people +
// unassigned === family total, to the minor unit, for assets, liabilities, net
// worth and every unconverted currency. To make that TRUE under FX rounding
// (`convertMinor` is not additive: convert(a) + convert(b) may differ from
// convert(a + b) by a minor unit), attribution is done at the BASE-currency
// level: each account's WHOLE contribution is converted once, each owned
// holding's slice is converted on its own, and the remainder is defined as
// whole − Σ slices (absorbing any rounding), then split by integer arithmetic.
// Splitting native amounts and converting each piece would drift.
// =============================================================================

export interface WealthPerson {
  id: string
  displayName: string
}

export interface WealthAccount {
  id: string
  accountClass: string
  currency: string
  /** Signed native minor units (ASSET >= 0, LIABILITY <= 0). */
  balance: bigint
  ownerId: string | null
  jointOwnerId: string | null
  /** The JOINT co-owner's share (1-99); the primary owner keeps the rest. */
  jointSharePercent: number | null
}

export interface WealthHolding {
  accountId: string
  /** Only holdings WITH an owner matter; unowned ones fall to the account. */
  ownerPersonId: string | null
  /** Value in the account's currency, minor units (>= 0). */
  valueMinor: bigint
}

export interface WealthShare extends NetWorthBreakdown {
  /** Accounts that contribute any value to this share (holding slices count). */
  accountCount: number
}

export interface PersonWealth extends WealthShare {
  person: WealthPerson
}

export interface WealthByPerson {
  people: PersonWealth[]
  /** "Shared / unassigned": value with no effective owner. */
  unassigned: WealthShare
  /** The family total, computed exactly as the family net-worth card does. */
  family: NetWorthBreakdown
}

interface Accumulator {
  assets: bigint
  liabilities: bigint
  unconverted: Map<string, bigint>
  accountIds: Set<string>
}

function newAccumulator(): Accumulator {
  return {
    assets: 0n,
    liabilities: 0n,
    unconverted: new Map(),
    accountIds: new Set(),
  }
}

type Converted =
  | { kind: "base"; base: bigint }
  | { kind: "unconverted"; native: bigint }

/** Converts ONE native amount through the shared normalizer. */
function convertPart(
  accountClass: string,
  currency: string,
  native: bigint,
  resolveRate: RateResolver,
  baseCurrency: string
): Converted {
  const result = normalizeNetWorthAt(
    [{ accountClass, currency, native }],
    resolveRate,
    baseCurrency
  )
  if (result.unconverted.length > 0) return { kind: "unconverted", native }
  return {
    kind: "base",
    // normalizeNetWorthAt adds a LIABILITY's base as `liabilities += -base`.
    base: accountClass === "LIABILITY" ? -result.liabilities : result.assets,
  }
}

function credit(
  acc: Accumulator,
  accountId: string,
  accountClass: string,
  currency: string,
  part: Converted
): void {
  acc.accountIds.add(accountId)
  if (part.kind === "unconverted") {
    acc.unconverted.set(
      currency,
      (acc.unconverted.get(currency) ?? 0n) + part.native
    )
    return
  }
  if (accountClass === "LIABILITY") acc.liabilities += -part.base
  else acc.assets += part.base
}

function subtract(whole: Converted, slices: Converted[]): Converted {
  if (whole.kind === "unconverted") {
    return {
      kind: "unconverted",
      native: slices.reduce(
        (sum, s) => sum - (s.kind === "unconverted" ? s.native : 0n),
        whole.native
      ),
    }
  }
  return {
    kind: "base",
    base: slices.reduce(
      (sum, s) => sum - (s.kind === "base" ? s.base : 0n),
      whole.base
    ),
  }
}

/** Integer split of a signed amount: (jointPart, primaryPart), sum exact. */
function splitJoint(
  amount: Converted,
  jointSharePercent: number
): { joint: Converted; primary: Converted } {
  const pct = BigInt(jointSharePercent)
  if (amount.kind === "unconverted") {
    const joint = (amount.native * pct) / 100n // BigInt division truncates
    return {
      joint: { kind: "unconverted", native: joint },
      primary: { kind: "unconverted", native: amount.native - joint },
    }
  }
  const joint = (amount.base * pct) / 100n
  return {
    joint: { kind: "base", base: joint },
    primary: { kind: "base", base: amount.base - joint },
  }
}

function finish(acc: Accumulator): WealthShare {
  return {
    assets: acc.assets,
    liabilities: acc.liabilities,
    netWorth: acc.assets - acc.liabilities,
    unconverted: [...acc.unconverted.entries()]
      .filter(([, native]) => native !== 0n)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, native]) => ({ currency, native })),
    accountCount: acc.accountIds.size,
  }
}

export function computeWealthByPerson({
  accounts,
  holdings,
  people,
  resolveRate,
  baseCurrency,
}: {
  accounts: ReadonlyArray<WealthAccount>
  holdings: ReadonlyArray<WealthHolding>
  people: ReadonlyArray<WealthPerson>
  resolveRate: RateResolver
  baseCurrency: string
}): WealthByPerson {
  const personIds = new Set(people.map((p) => p.id))
  const byPerson = new Map<string, Accumulator>(
    people.map((p) => [p.id, newAccumulator()])
  )
  const unassigned = newAccumulator()
  const bucketFor = (personId: string | null): Accumulator =>
    (personId !== null ? byPerson.get(personId) : undefined) ?? unassigned

  const ownedHoldingsByAccount = new Map<string, WealthHolding[]>()
  for (const holding of holdings) {
    if (holding.ownerPersonId === null) continue
    if (!personIds.has(holding.ownerPersonId)) continue
    const list = ownedHoldingsByAccount.get(holding.accountId) ?? []
    list.push(holding)
    ownedHoldingsByAccount.set(holding.accountId, list)
  }

  for (const account of accounts) {
    const convert = (native: bigint) =>
      convertPart(
        account.accountClass,
        account.currency,
        native,
        resolveRate,
        baseCurrency
      )
    const whole = convert(account.balance)

    // 1. Holding slices go to their own owners.
    const slices: Converted[] = []
    for (const holding of ownedHoldingsByAccount.get(account.id) ?? []) {
      const slice = convert(holding.valueMinor)
      slices.push(slice)
      credit(
        bucketFor(holding.ownerPersonId),
        account.id,
        account.accountClass,
        account.currency,
        slice
      )
    }

    // 2./3. The account-level remainder: the owner (with joint split) or nobody.
    const remainder = subtract(whole, slices)
    const primaryKnown =
      account.ownerId !== null && personIds.has(account.ownerId)
    const jointValid =
      primaryKnown &&
      account.jointOwnerId !== null &&
      account.jointOwnerId !== account.ownerId &&
      personIds.has(account.jointOwnerId) &&
      account.jointSharePercent !== null &&
      account.jointSharePercent >= 1 &&
      account.jointSharePercent <= 99
    if (jointValid) {
      const { joint, primary } = splitJoint(
        remainder,
        account.jointSharePercent as number
      )
      credit(
        bucketFor(account.ownerId),
        account.id,
        account.accountClass,
        account.currency,
        primary
      )
      credit(
        bucketFor(account.jointOwnerId),
        account.id,
        account.accountClass,
        account.currency,
        joint
      )
    } else {
      credit(
        bucketFor(primaryKnown ? account.ownerId : null),
        account.id,
        account.accountClass,
        account.currency,
        remainder
      )
    }
  }

  const family = normalizeNetWorthAt(
    accounts.map((a) => ({
      accountClass: a.accountClass,
      currency: a.currency,
      native: a.balance,
    })),
    resolveRate,
    baseCurrency
  )

  return {
    people: people.map((person) => ({
      person,
      ...finish(byPerson.get(person.id)!),
    })),
    unassigned: finish(unassigned),
    family,
  }
}
