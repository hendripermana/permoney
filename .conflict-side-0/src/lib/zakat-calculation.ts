import { signedDeltaForAccount, type AnalyticsTxn } from "./account-analytics"
import { hijriAnniversary } from "./zakat-hijri"
import { computeZakatDue, type NisabBasis } from "./zakat-nisab"
import {
  attributeAmountToPayer,
  classifyZakatAccount,
  estimateNextLoanInstallment,
  isZakatUnattributed,
  type ZakatAccountRef,
  type ZakatPayerRef,
} from "./zakat-attribution"

// =============================================================================
// ADR-0056 — Zakat Maal calculator: Hawl reconstruction + per-payer result.
// =============================================================================
//
// SCOPE DECISION (flagged explicitly — the ADR does not rule on this): each
// call to `computeZakatForPayers` evaluates exactly ONE Hawl period — from
// `settings.hawlStartDate` to its ONE-Hijri-year anniversary — never a
// rolling multi-year obligation ledger ("have I already paid for year 1,
// year 2, ..."). This matches the feature's actual shape (a point-in-time
// calculator the user re-runs, not a payment-history tracker — Zakat
// disbursement itself is explicitly out of scope per the ADR) and is what
// every worked scenario and required test in the ADR/ticket describes. A
// household whose Hawl has been running for several years re-confirms/
// advances `hawlStartDate` themselves (or accepts the `hawlBrokenAt`
// suggestion) between calculations, exactly like the "a NEW Hawl beginning
// from that date is computed correctly on a subsequent call" test requires.
//
// MONEY PRECISION: this module deliberately does NOT reuse
// `buildBalanceSeries` (account-analytics.ts) for the historical
// reconstruction, even though ADR-0056 asks for "the SAME balance-
// reconstruction primitive". `buildBalanceSeries` intentionally converts
// every point to a display `number` (`toDisplayNumber`) for charting — fine
// for a chart axis, wrong for a religious wealth threshold and a real owed
// amount, which must stay exact bigint minor units end to end (CLAUDE.md
// money discipline). The actual per-transaction ledger math IS fully reused
// — `signedDeltaForAccount` (the exact same signed-delta function
// `buildBalanceSeries` itself folds over) — via the bigint-preserving
// `buildDailyMinorSeries` below, which mirrors `buildBalanceSeries`'s
// "back out the opening balance, walk forward" algorithm exactly, just
// without the final float conversion. This is a correctness IMPROVEMENT
// over reusing the display-oriented function verbatim, not a shortcut.
//
// NISAB PRICE: the nisab value is computed ONCE from the CURRENT metal price
// (`nisabValueMinor`, passed in) and applied uniformly across every
// reconstructed historical day. Permoney does not keep a historical daily
// gold/silver price series (only current + forward-collected quotes), and
// the ADR itself defines nisab_value from "current_market_price_per_gram"
// with no historical-price reconstruction mechanism described — so this is
// the literal, ADR-consistent reading, not an invented shortcut. Flagged
// here for visibility.
//
// LOAN DEDUCTION: the next-due installment estimate
// (`estimateNextLoanInstallment`) is inherently a forward-looking snapshot
// derived from the loan's FULL payment history as of "now" (there is no
// "what did the payment schedule look like as of a past day" primitive in
// this codebase, nor is one reconstructible the way a balance is). It is
// therefore applied as a CONSTANT amount across the whole reconstructed
// window rather than re-derived per historical day — BUT gated by the date
// the loan itself first existed (its own earliest transaction, i.e. its
// `liability_draw`). Found and fixed in review: applying the deduction
// unconditionally to every historical point — including dates before the
// loan was ever taken out — would fabricate a debt that did not exist yet,
// which could wrongly report a Hawl-breaking dip below nisab at a point
// where the payer's real wealth never actually fell (understating a real
// obligation is exactly the direction Zakat calculations must never err
// in). See `LoanDeduction`/`netWealthAt` below.
// =============================================================================

export type HaulRule = "jumhur_continuous" | "hanafi_start_end"

export interface ZakatSettingsInput {
  nisabBasis: NisabBasis
  haulRule: HaulRule
  /** Must be non-null to compute — the server layer is responsible for
   * surfacing a distinct "set a Hawl start date first" state when it isn't
   * set yet (see `computeZakatFn` in src/server/zakat.ts). */
  hawlStartDate: Date
}

export interface ZakatCalculationAccount extends ZakatAccountRef {
  /** This account's own ledger (rows where it is either `accountId` or
   * `toAccountId`) — used for both historical reconstruction
   * (`signedDeltaForAccount`) and, for LOAN accounts, next-installment
   * cadence detection. */
  transactions: ReadonlyArray<AnalyticsTxn & { description?: string | null }>
}

export interface ZakatAssetBreakdownEntry {
  accountId: string
  accountName: string
  kind: "cash" | "receivable"
  attributedAmountMinor: bigint
}

export interface ZakatDebtBreakdownEntry {
  accountId: string
  accountName: string
  kind: "credit" | "loan"
  attributedAmountMinor: bigint
  /** Present for a LOAN whose cadence could not be determined (deducted as
   * 0 — see `estimateNextLoanInstallment`). */
  note?: string
}

export interface ZakatPayerResult {
  payer: ZakatPayerRef
  eligible: boolean
  hawlAnniversaryDate: Date
  snapshotNetWealthMinor: bigint
  nisabValueMinor: bigint
  nisabBasis: NisabBasis
  zakatOwedMinor: bigint
  /** The first date (within [hawlStartDate, hawlAnniversaryDate]) this
   * payer's net zakatable wealth dipped below nisab. Always `null` under
   * `hanafi_start_end` (dips are irrelevant to that rule by definition).
   * Under `jumhur_continuous`, a non-null value both explains an
   * `eligible: false` result AND is the suggested new `hawlStartDate` for a
   * subsequent calculation. */
  hawlBrokenAt: Date | null
  assetsIncluded: ZakatAssetBreakdownEntry[]
  debtDeducted: ZakatDebtBreakdownEntry[]
  /** In-scope account ids with NO `zakatPayerId` at all — excluded from
   * EVERY payer's total (never guessed). Always empty in single-payer mode
   * (ADR-0056's default-behavior rule: an untagged account implicitly
   * belongs 100% to the sole payer). Identical across every payer's result
   * for the same family (it's a family-level fact, repeated here so each
   * payer's result is self-contained). */
  unattributedAccountIds: string[]
}

export interface ComputeZakatParams {
  settings: ZakatSettingsInput
  /**
   * MUST be non-empty. The server synthesizes an implicit single "Saya"
   * payer when the family has never created a real `ZakatPayer` row
   * (ADR-0056: "a family with zero or one ZakatPayer row needs no tagging
   * at all"). Passing `payers.length <= 1` puts every account in
   * SINGLE-PAYER MODE (every in-scope account counts 100%, tags or not).
   */
  payers: ReadonlyArray<ZakatPayerRef>
  accounts: ReadonlyArray<ZakatCalculationAccount>
  /** `nisab_grams(nisabBasis) × current price/gram` — see
   * `computeNisabValue` in zakat-nisab.ts. Computed by the server layer
   * (needs the market-data price lookup, which is not a pure-lib concern). */
  nisabValueMinor: bigint
  now?: Date
}

// -----------------------------------------------------------------------------
// Bigint-preserving daily reconstruction (see file header for why this is a
// dedicated function rather than `buildBalanceSeries` reused verbatim).
// -----------------------------------------------------------------------------

interface MinorPoint {
  ms: number
  balance: bigint
}

function chronologicalByDate(
  a: Pick<AnalyticsTxn, "date">,
  b: Pick<AnalyticsTxn, "date">
): number {
  return new Date(a.date).getTime() - new Date(b.date).getTime()
}

/**
 * Reconstruct `accountId`'s balance after each of its own transactions,
 * chronologically, ending at `currentBalance` — the exact algorithm
 * `buildBalanceSeries` uses (back out the opening balance as `currentBalance
 * − Σdeltas`, walk forward), kept in bigint throughout. Reuses
 * `signedDeltaForAccount` — the real per-transaction ledger math — verbatim.
 */
function buildDailyMinorSeries(
  txns: ReadonlyArray<AnalyticsTxn>,
  currentBalance: bigint,
  accountId: string
): { opening: bigint; points: MinorPoint[] } {
  const sorted = [...txns].sort(chronologicalByDate)
  const total = sorted.reduce(
    (sum, t) => sum + signedDeltaForAccount(t, accountId),
    0n
  )
  const opening = currentBalance - total
  let running = opening
  const points: MinorPoint[] = []
  for (const t of sorted) {
    running += signedDeltaForAccount(t, accountId)
    points.push({ ms: new Date(t.date).getTime(), balance: running })
  }
  return { opening, points }
}

/** The account's reconstructed balance as of `at` (carry-forward: the most
 * recent point at-or-before `at`, or `opening` if none yet). */
function valueAsOf(
  series: { opening: bigint; points: MinorPoint[] },
  at: Date
): bigint {
  const ms = at.getTime()
  let result = series.opening
  for (const p of series.points) {
    if (p.ms <= ms) result = p.balance
    else break
  }
  return result
}

// -----------------------------------------------------------------------------
// Per-payer relevant-account resolution.
// -----------------------------------------------------------------------------

interface RelevantAccount {
  account: ZakatCalculationAccount
  kind: "cash_asset" | "receivable_asset" | "credit_debt" | "loan_debt"
  series: { opening: bigint; points: MinorPoint[] }
}

function isRelevantToPayer(
  account: ZakatCalculationAccount,
  payer: ZakatPayerRef,
  singlePayerMode: boolean
): boolean {
  if (singlePayerMode) return true
  return (
    account.zakatPayerId === payer.id || account.zakatJointPayerId === payer.id
  )
}

/** Magnitude to feed into `attributeAmountToPayer`/nisab comparisons for one
 * in-scope account kind: assets stay their own balance; a LIABILITY's
 * outstanding magnitude is `-balance` (balance is <= 0 for CREDIT/LOAN per
 * `docs/account-taxonomy.md`). */
function outstandingMagnitude(
  balance: bigint,
  kind: RelevantAccount["kind"]
): bigint {
  return kind === "credit_debt" ? -balance : balance
}

function resolveRelevantAccounts(
  accounts: ReadonlyArray<ZakatCalculationAccount>,
  payer: ZakatPayerRef,
  singlePayerMode: boolean
): RelevantAccount[] {
  const relevant: RelevantAccount[] = []
  for (const account of accounts) {
    const kind = classifyZakatAccount(account)
    if (kind === "out_of_scope" || kind === "loan_debt") continue
    if (!isRelevantToPayer(account, payer, singlePayerMode)) continue
    const series = buildDailyMinorSeries(
      account.transactions,
      account.balance,
      account.id
    )
    relevant.push({ account, kind, series })
  }
  return relevant
}

/**
 * One LOAN account's estimated next-due-installment deduction, attributed to
 * one payer, gated by the date the loan itself first existed (its own
 * earliest transaction — see `netWealthAt`'s doc comment for why this
 * matters: a flat constant deduction applied to every historical point,
 * including dates before the loan was ever taken out, would fabricate a debt
 * that did not exist yet and could wrongly report a Hawl-breaking dip below
 * nisab at a point where the payer's real wealth never actually fell).
 */
interface LoanDeduction {
  attributedAmountMinor: bigint
  /** The loan account's earliest transaction (its `liability_draw`, in
   * practice) — this deduction applies only to `at >= existsFromMs`. */
  existsFromMs: number
}

/** Net zakatable wealth attributed to `payer` as of `at`, across
 * `relevant` cash/receivable/credit accounts, minus every `loanDeductions`
 * entry that had already come into existence by `at` (see `LoanDeduction`'s
 * doc comment — a loan taken out AFTER `at` must never reduce wealth at a
 * point in time before it existed). */
function netWealthAt(
  relevant: ReadonlyArray<RelevantAccount>,
  payer: ZakatPayerRef,
  singlePayerMode: boolean,
  at: Date,
  loanDeductions: ReadonlyArray<LoanDeduction>
): bigint {
  let total = 0n
  for (const r of relevant) {
    const magnitude = outstandingMagnitude(valueAsOf(r.series, at), r.kind)
    const attributed = attributeAmountToPayer(
      r.account,
      payer,
      magnitude,
      singlePayerMode
    )
    total += r.kind === "credit_debt" ? -attributed : attributed
  }
  const atMs = at.getTime()
  for (const loan of loanDeductions) {
    if (loan.existsFromMs <= atMs) total -= loan.attributedAmountMinor
  }
  return total
}

/** Every distinct transaction date (across `relevant`) strictly within
 * `(from, to]`, plus `from` and `to` themselves — the only moments the
 * merged net-wealth series can change value (it is flat in between). */
function collectCandidateDates(
  relevant: ReadonlyArray<RelevantAccount>,
  from: Date,
  to: Date
): Date[] {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  const set = new Set<number>([fromMs, toMs])
  for (const r of relevant) {
    for (const p of r.series.points) {
      if (p.ms > fromMs && p.ms <= toMs) set.add(p.ms)
    }
  }
  return [...set].sort((a, b) => a - b).map((ms) => new Date(ms))
}

/** The earliest transaction date on this account (its `liability_draw`, in
 * practice — the moment the debt itself came into existence), or `null` for
 * an account with no history at all (nothing to deduct at any date). */
function earliestTransactionMs(
  txns: ReadonlyArray<Pick<AnalyticsTxn, "date">>
): number | null {
  if (txns.length === 0) return null
  return Math.min(...txns.map((t) => new Date(t.date).getTime()))
}

function computeLoanDeductionForPayer(
  accounts: ReadonlyArray<ZakatCalculationAccount>,
  payer: ZakatPayerRef,
  singlePayerMode: boolean,
  now: Date
): {
  deductions: LoanDeduction[]
  entries: ZakatDebtBreakdownEntry[]
} {
  const deductions: LoanDeduction[] = []
  const entries: ZakatDebtBreakdownEntry[] = []
  for (const account of accounts) {
    if (classifyZakatAccount(account) !== "loan_debt") continue
    if (!isRelevantToPayer(account, payer, singlePayerMode)) continue
    const estimate = estimateNextLoanInstallment(
      account.transactions,
      account.id,
      now
    )
    const attributed = attributeAmountToPayer(
      account,
      payer,
      estimate.amountMinor,
      singlePayerMode
    )
    const existsFromMs = earliestTransactionMs(account.transactions)
    // No history at all: nothing to deduct at any point in time (there is
    // no evidence the debt existed yet), matching the same "never guess"
    // discipline as an undetermined cadence.
    if (existsFromMs !== null && attributed !== 0n) {
      deductions.push({ attributedAmountMinor: attributed, existsFromMs })
    }
    entries.push({
      accountId: account.id,
      accountName: account.name,
      kind: "loan",
      attributedAmountMinor: attributed,
      note: estimate.determined
        ? undefined
        : "Next installment could not be determined from payment history — deducted as 0 (conservative: never over-deducts the full remaining principal, never guesses).",
    })
  }
  return { deductions, entries }
}

function buildBreakdown(
  relevant: ReadonlyArray<RelevantAccount>,
  payer: ZakatPayerRef,
  singlePayerMode: boolean,
  at: Date
): {
  assetsIncluded: ZakatAssetBreakdownEntry[]
  debtDeducted: ZakatDebtBreakdownEntry[]
} {
  const assetsIncluded: ZakatAssetBreakdownEntry[] = []
  const debtDeducted: ZakatDebtBreakdownEntry[] = []
  for (const r of relevant) {
    const magnitude = outstandingMagnitude(valueAsOf(r.series, at), r.kind)
    const attributed = attributeAmountToPayer(
      r.account,
      payer,
      magnitude,
      singlePayerMode
    )
    if (attributed === 0n) continue
    if (r.kind === "cash_asset" || r.kind === "receivable_asset") {
      assetsIncluded.push({
        accountId: r.account.id,
        accountName: r.account.name,
        kind: r.kind === "cash_asset" ? "cash" : "receivable",
        attributedAmountMinor: attributed,
      })
    } else {
      debtDeducted.push({
        accountId: r.account.id,
        accountName: r.account.name,
        kind: "credit",
        attributedAmountMinor: attributed,
      })
    }
  }
  return { assetsIncluded, debtDeducted }
}

function computeForOnePayer(
  payer: ZakatPayerRef,
  accounts: ReadonlyArray<ZakatCalculationAccount>,
  settings: ZakatSettingsInput,
  nisabValueMinor: bigint,
  singlePayerMode: boolean,
  now: Date,
  unattributedAccountIds: string[]
): ZakatPayerResult {
  const relevant = resolveRelevantAccounts(accounts, payer, singlePayerMode)
  const loan = computeLoanDeductionForPayer(
    accounts,
    payer,
    singlePayerMode,
    now
  )

  const hawlAnniversaryDate = hijriAnniversary(settings.hawlStartDate, 1)
  const windowEnd =
    now.getTime() < hawlAnniversaryDate.getTime() ? now : hawlAnniversaryDate
  const hawlComplete = now.getTime() >= hawlAnniversaryDate.getTime()

  const netAt = (at: Date) =>
    netWealthAt(relevant, payer, singlePayerMode, at, loan.deductions)

  let hawlBrokenAt: Date | null = null
  if (settings.haulRule === "jumhur_continuous") {
    // Check every day the wealth could have changed within
    // [hawlStartDate, windowEnd] — the first one below nisab breaks it.
    for (const day of collectCandidateDates(
      relevant,
      settings.hawlStartDate,
      windowEnd
    )) {
      if (netAt(day) < nisabValueMinor) {
        hawlBrokenAt = day
        break
      }
    }
  }

  const snapshotAt = hawlComplete ? hawlAnniversaryDate : now
  const snapshotNetWealthMinor = netAt(snapshotAt)

  let eligible: boolean
  if (!hawlComplete) {
    eligible = false
  } else if (settings.haulRule === "hanafi_start_end") {
    eligible =
      netAt(settings.hawlStartDate) >= nisabValueMinor &&
      netAt(hawlAnniversaryDate) >= nisabValueMinor
  } else {
    eligible =
      hawlBrokenAt === null && snapshotNetWealthMinor >= nisabValueMinor
  }

  const zakatOwedMinor = eligible ? computeZakatDue(snapshotNetWealthMinor) : 0n

  const { assetsIncluded, debtDeducted } = buildBreakdown(
    relevant,
    payer,
    singlePayerMode,
    snapshotAt
  )

  return {
    payer,
    eligible,
    hawlAnniversaryDate,
    snapshotNetWealthMinor,
    nisabValueMinor,
    nisabBasis: settings.nisabBasis,
    zakatOwedMinor,
    hawlBrokenAt,
    assetsIncluded,
    debtDeducted: [...debtDeducted, ...loan.entries],
    unattributedAccountIds,
  }
}

/**
 * Compute EACH payer's fully independent Zakat result — the feature's core
 * entry point. Never pools wealth across payers (ADR-0056's central
 * correction). See the file header for the documented scope/precision
 * decisions this makes.
 */
export function computeZakatForPayers(
  params: ComputeZakatParams
): ZakatPayerResult[] {
  const {
    settings,
    payers,
    accounts,
    nisabValueMinor,
    now = new Date(),
  } = params
  if (payers.length === 0) {
    throw new Error(
      "computeZakatForPayers: at least one payer is required — the server " +
        "synthesizes an implicit 'Saya' payer when the family has never " +
        "created a real ZakatPayer row (ADR-0056 default-behavior rule)."
    )
  }
  const singlePayerMode = payers.length <= 1

  const unattributedAccountIds = singlePayerMode
    ? []
    : accounts
        .filter((a) => classifyZakatAccount(a) !== "out_of_scope")
        .filter(isZakatUnattributed)
        .map((a) => a.id)

  return payers.map((payer) =>
    computeForOnePayer(
      payer,
      accounts,
      settings,
      nisabValueMinor,
      singlePayerMode,
      now,
      unattributedAccountIds
    )
  )
}
