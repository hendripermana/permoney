import { z } from "zod"
import { allowsNegativeAssetBalance, type AccountType } from "@/lib/accounts"
import type { CurrencyCode } from "@/lib/data/currencies"
import { negateMoney, parseMoneyInput } from "@/lib/money"

// =============================================================================
// ADR-0058 D4 — Pit Stop: the pure, Prisma-free half of the batch balance check.
//
// The server (src/server/pit-stop.ts) owns every irreversible decision. This
// module owns the shared CONTRACT (eligibility, the input schema) and the pure
// derivations the screen needs (row parsing, difference preview, the "Mine /
// Everyone" filter, the plain-language summary), so both halves stay in lock
// step and the screen holds no money arithmetic of its own.
// =============================================================================

/** Account types a Pit Stop may check: cash-like, transaction-flow accounts. */
export const PIT_STOP_ELIGIBLE_ACCOUNT_TYPES = [
  "DEPOSITORY",
  "CASH",
  "E_WALLET",
  "CREDIT",
] as const satisfies ReadonlyArray<AccountType>

const ELIGIBLE_TYPE_SET: ReadonlySet<string> = new Set(
  PIT_STOP_ELIGIBLE_ACCOUNT_TYPES
)

export function isPitStopEligibleAccountType(accountType: string): boolean {
  return ELIGIBLE_TYPE_SET.has(accountType)
}

/** Upper bound on accounts per batch — a household has tens, not thousands. */
export const PIT_STOP_MAX_ENTRIES = 100

// A signed digit-string of minor units, exactly the `createValuationInputSchema
// .value` convention (a magnitude; a leading `-` only for a real overdraft on a
// carve-out account). 18 digits keeps every value inside BigInt/Postgres range
// with headroom and rejects junk before it reaches the ledger.
const actualBalanceSchema = z
  .string()
  .regex(/^-?\d{1,18}$/, "actualBalance must be a string of 1-18 digits")

export const pitStopEntrySchema = z.object({
  accountId: z.string().min(1),
  actualBalance: actualBalanceSchema,
})

/**
 * The entries array: 1..PIT_STOP_MAX_ENTRIES, every account at most once. The
 * server composes it with the idempotency key and optional as-of date
 * (src/server/pit-stop.ts); the screen reuses it as-is.
 */
export const pitStopEntriesSchema = z
  .array(pitStopEntrySchema)
  .min(1)
  .max(PIT_STOP_MAX_ENTRIES)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>()
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.accountId)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "accountId"],
          message: "An account can only appear once in a Pit Stop",
        })
      }
      seen.add(entry.accountId)
    }
  })

// -----------------------------------------------------------------------------
// Row parsing + difference preview
// -----------------------------------------------------------------------------

export interface PitStopRowFacts {
  accountType: string
  accountClass: string
  currency: string
  /** Canonical balance, signed minor units as a digit-string. */
  balance: string
}

export type PitStopRowEntry =
  | { kind: "blank" }
  | { kind: "invalid" }
  | {
      kind: "ok"
      /** The value to send: a magnitude (owed amount for a liability). */
      actualBalance: bigint
      /** The same value signed the way the ledger stores it. */
      signedActual: bigint
      /** signedActual − canonical balance; the unrecorded movement. */
      delta: bigint
    }

/**
 * Parse one row's raw "Actual now" text against its account. Uses the shared,
 * locale-agnostic `parseMoneyInput` (never hand-rolled — see PER-240 / the
 * holdings quantity lesson). Blank text is a skipped row, not an error.
 */
export function parsePitStopRow(
  raw: string,
  facts: PitStopRowFacts
): PitStopRowEntry {
  if (raw.trim() === "") return { kind: "blank" }
  const magnitude = parseMoneyInput(raw, facts.currency as CurrencyCode)
  if (magnitude === null) return { kind: "invalid" }
  // Mirrors the server (createValuationWithinTx): a negative value is only
  // legitimate for a carve-out ASSET account (a real overdraft).
  if (
    magnitude < 0n &&
    !allowsNegativeAssetBalance(facts.accountType as AccountType)
  ) {
    return { kind: "invalid" }
  }
  if (magnitude.toString().replace("-", "").length > 18) {
    return { kind: "invalid" }
  }
  const signedActual =
    magnitude < 0n
      ? magnitude
      : facts.accountClass === "LIABILITY"
        ? negateMoney(magnitude)
        : magnitude
  return {
    kind: "ok",
    actualBalance: magnitude,
    signedActual,
    delta: signedActual - BigInt(facts.balance),
  }
}

/**
 * How a balance is shown to the person: an asset shows its balance, a liability
 * (credit card) shows what is OWED — a positive number, like the card statement.
 */
export function displayBalance(accountClass: string, signed: bigint): bigint {
  return accountClass === "LIABILITY" ? -signed : signed
}

export interface PitStopBatchEntry {
  accountId: string
  actualBalance: string
}

export interface PitStopRowInput {
  accountId: string
  facts: PitStopRowFacts
  raw: string
}

export interface PitStopSubmission {
  entries: Array<PitStopBatchEntry>
  /** Rows the person filled in but that do not parse. Blocks submission. */
  invalidCount: number
}

/** Turn the screen's rows into the wire entries. Blank rows are skipped. */
export function buildPitStopSubmission(
  rows: ReadonlyArray<PitStopRowInput>
): PitStopSubmission {
  const entries: Array<PitStopBatchEntry> = []
  let invalidCount = 0
  for (const row of rows) {
    const parsed = parsePitStopRow(row.raw, row.facts)
    if (parsed.kind === "blank") continue
    if (parsed.kind === "invalid") {
      invalidCount += 1
      continue
    }
    entries.push({
      accountId: row.accountId,
      actualBalance: parsed.actualBalance.toString(),
    })
  }
  return { entries, invalidCount }
}

/** A stable, order-independent fingerprint of a submission's payload. */
export function pitStopPayloadFingerprint(
  entries: ReadonlyArray<PitStopBatchEntry>
): string {
  return [...entries]
    .sort((a, b) => (a.accountId < b.accountId ? -1 : 1))
    .map((entry) => `${entry.accountId}:${entry.actualBalance}`)
    .join("|")
}

// -----------------------------------------------------------------------------
// Who sees what
// -----------------------------------------------------------------------------

export type PitStopScope = "mine" | "everyone"

export interface PitStopOwnable {
  ownerPersonId: string | null
  jointOwnerPersonId: string | null
}

/**
 * The default view is the accounts owned by, or jointly owned with, the current
 * user's person. Returns the visible list plus `ownsNothing` — when the person
 * owns none (or the user has no person yet) the screen falls back to every
 * eligible account and nudges the user to set owners.
 */
export function selectPitStopAccounts<T extends PitStopOwnable>(
  accounts: ReadonlyArray<T>,
  currentPersonId: string | null,
  scope: PitStopScope
): { visible: Array<T>; ownsNothing: boolean } {
  const mine =
    currentPersonId === null
      ? []
      : accounts.filter(
          (account) =>
            account.ownerPersonId === currentPersonId ||
            account.jointOwnerPersonId === currentPersonId
        )
  const ownsNothing = mine.length === 0
  if (scope === "everyone" || ownsNothing) {
    return { visible: [...accounts], ownsNothing }
  }
  return { visible: mine, ownsNothing }
}

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * "Never checked" / "Checked today" / "Last checked 3 days ago" from the latest
 * ground-truth anchor date (YYYY-MM-DD, UTC calendar day). `today` is injected
 * so it stays pure.
 */
export function describeLastChecked(
  lastCheckedAt: string | null,
  today: Date
): string {
  if (lastCheckedAt === null) return "Never checked"
  const checked = Date.parse(`${lastCheckedAt}T00:00:00Z`)
  if (Number.isNaN(checked)) return "Never checked"
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  )
  const days = Math.max(0, Math.round((todayUtc - checked) / MS_PER_DAY))
  if (days === 0) return "Checked today"
  if (days === 1) return "Last checked yesterday"
  if (days < 60) return `Last checked ${days} days ago`
  const months = Math.round(days / 30)
  return `Last checked ${months} months ago`
}

export type UnrecordedDirection = "more" | "less" | "none"

/** Direction of a net unrecorded movement (in net-worth terms). */
export function unrecordedDirection(delta: bigint): UnrecordedDirection {
  if (delta > 0n) return "more"
  if (delta < 0n) return "less"
  return "none"
}
