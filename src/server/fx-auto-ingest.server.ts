/**
 * PER-234 — Market data Slice 2: FX auto-ingestion (the Frankfurter / ECB feed),
 * which retires hand-seeded `FxRateSnapshot` rows. SERVER-ONLY: imports Prisma,
 * so it carries the `.server.ts` hard fence (CLAUDE.md §6) and is side-effect
 * free at module scope.
 * =============================================================================
 *
 * WHY THIS MODULE EXISTS: every family's FX rates used to be typed in by hand
 * (`FxRateSnapshot` with `source: "manual"` / `"seed"`). This module makes them
 * flow from the ECB's daily reference rates through the SAME `MarketDataProvider`
 * seam gold and reksadana already use (ADR-0050 / ADR-0052 §5). The scheduler
 * (`runScheduledMarketDataRefresh`, `market-data.server.ts`) runs it in three
 * phases around ONE unchanged router ingest:
 *
 *   1. PRE  — `prepareFxAutoIngest`: walk every family (RLS-scoped, acting as
 *      one of its active members), collect the non-base currencies actually in
 *      use in its accounts / transactions / valuations plus the
 *      `FX_RATE_CURRENCIES` extras, map each to a (foreign -> family base)
 *      pair, and ENSURE a `frankfurter`-routed `MarketInstrument` per pair so
 *      the router prices exactly what is really needed. Unsupported currencies
 *      (XAU/BTC/…) are structured SKIPS, never fetches.
 *   2. MID  — the UNCHANGED `ingestAllInstrumentsOnce` router fetches and
 *      stages canonical `MarketQuote` rows. This module NEVER fetches.
 *   3. POST — `propagateFxRateSnapshotsForFamilies`: promote each family's
 *      latest provider quote into a dated, `source: "provider"`
 *      `FxRateSnapshot` through `upsertFxRateSnapshotForFamily`, so the
 *      ADR-0035 projection rebuild backfills transactions/valuations exactly
 *      like a manual entry would.
 *
 * HONESTY INVARIANTS (why this is written the way it is):
 *   - The effective date is the ECB payload's own publication `date`, never
 *     "today": a run before the ~14:15 UTC publication carries the previous
 *     business day's rate (ADR-0035's dated step function must not shift).
 *   - A family with NO usable rate for a currency keeps its FX-pending NULL
 *     projection. Missing rate -> no snapshot -> no projection; NEVER a
 *     wrong projection.
 *   - A rate a human typed by hand (`source: "manual"`) is never overwritten
 *     for the same date — the operator's correction outranks the feed.
 *   - Everything is idempotent by natural key: a same-day re-run writes no
 *     new quote, no new snapshot, and no new audit row.
 *
 * LEDGER ISOLATION: phase 1 reads tenant data (RLS-scoped) and phase 3 writes
 * `FxRateSnapshot` + rebuilt projections (RLS-scoped) — both through
 * `scopedTenantTransaction` with a real acting member, exactly like an
 * ordinary request. Nothing here ever touches `Account.balance`.
 */

import type { PrismaClient } from "@prisma/client"
import { decodeRate } from "@/lib/fx"
import {
  FRANKFURTER_PROVIDER_ID,
  FX_PRICE_DECIMALS,
  fxPairSymbol,
  isFrankfurterSupportedCurrency,
  parseFrankfurterRatesResponse,
  parseFxExtraCurrencies,
} from "@/lib/market-data"
import { prisma } from "./db.server"
import { getFamilyBaseCurrency, upsertFxRateSnapshotForFamily } from "./fx"
import { listAllFamilies, resolveActingMember } from "./family-actors.server"
import {
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
// TYPE-ONLY, deliberately: these describe the `MarketDataProvider` seam owned by
// `market-data.server.ts`, which imports THIS module at runtime. `import type`
// is erased at compile time, so the runtime dependency stays one-directional
// (market-data.server -> fx-auto-ingest.server) and never forms a cycle.
import type {
  FetchLike,
  FxPairRequest,
  MarketDataProvider,
  MarketFetchResult,
  MarketInstrumentRequest,
  SpotRequest,
} from "./market-data.server"

/** The `FxRateSnapshot.source` a promoted provider quote is stamped with. */
export const FX_PROVIDER_SNAPSHOT_SOURCE = "provider"

// =============================================================================
// The Frankfurter (ECB reference rates) adapter — the ONLY code that knows the
// FX vendor exists (ADR-0050 §2). Keyless, public JSON; config
// (`FRANKFURTER_API_URL`) is read ONLY at call time (never module scope).
//
// ECBCONTRACT: `GET {base}/latest?from=USD&to=IDR,EUR` returns
// `{ amount, base, date, rates }` where `date` is the publication day and
// `rates` maps each requested quote currency to one unit of `base`. Rates are
// grouped ONE REQUEST PER BASE CURRENCY, so a single base failing (an unsupported
// symbol the whitelist let through, an upstream 4xx) degrades only that group —
// the other bases still ingest. Graceful degradation is total: an unreachable
// host, a non-2xx, a non-JSON body, or a structurally unusable payload becomes a
// staged `status: "error"` result (never a throw, never a bad quote — ADR-0050 §4).
// =============================================================================

/** Read the Frankfurter base URL at CALL time; a clear error if unset. */
function requireFrankfurterApiUrl(): string {
  const raw = process.env.FRANKFURTER_API_URL
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      "FRANKFURTER_API_URL is not set — configure the Frankfurter (ECB reference rates) base URL to auto-ingest FX rates (ADR-0050 / PER-234)."
    )
  }
  const url = raw.trim().replace(/\/+$/, "")
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(
      `FRANKFURTER_API_URL must be an http(s) base URL (got "${url}").`
    )
  }
  return url
}

/**
 * Whether FX auto-ingestion is ON for this install. It is opt-in: FX carries
 * real money semantics, so a deploy that has not pointed at a feed must
 * silently keep the rates it already has rather than degrade every tick.
 * An explicit `baseUrl` (tests) wins over the `FRANKFURTER_API_URL` env.
 */
export function isFrankfurterConfigured(baseUrl?: string): boolean {
  const raw = baseUrl ?? process.env.FRANKFURTER_API_URL
  return typeof raw === "string" && raw.trim().length > 0
}

export interface FrankfurterFxProviderOptions {
  /** Base URL; defaults to reading `FRANKFURTER_API_URL` at call time. */
  baseUrl?: string
  /** Injectable fetch (tests pass a fixture; prod uses the global `fetch`). */
  fetchImpl?: FetchLike
}

/** One base currency's requested quote currencies + the request outcome. */
interface FxBaseGroupResult {
  status: "ok" | "error"
  httpStatus?: number
  error?: string
  observations: MarketFetchResult["observations"]
  rawPayload: unknown
}

/**
 * The ECB reference-rate adapter. Serves fx pairs only; spot requests are a
 * no-op empty-ok result (a mixed ingest never errors on this provider), and
 * `fetchQuotes` defensively keeps only the fx branch of a mixed request.
 */
export class FrankfurterFxProvider implements MarketDataProvider {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  /** Provenance the ingest pipeline stamps on the raw fetch + canonical quote. */
  get name(): string {
    return FRANKFURTER_PROVIDER_ID
  }

  constructor(options?: FrankfurterFxProviderOptions) {
    this.baseUrl = options?.baseUrl ?? requireFrankfurterApiUrl()
    this.fetchImpl = options?.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  fetchSpot(_requests: readonly SpotRequest[]): Promise<MarketFetchResult> {
    // Not this adapter's concern: a mixed router batch that reaches Frankfurter
    // with a metal/security branch gets an empty-ok for it, never an error.
    return Promise.resolve(emptyOk())
  }

  fetchQuotes(
    instruments: readonly MarketInstrumentRequest[]
  ): Promise<MarketFetchResult> {
    const pairs: FxPairRequest[] = []
    for (const instrument of instruments) {
      if (instrument.kind === "fx") {
        pairs.push({
          baseCurrency: instrument.baseCurrency,
          quoteCurrency: instrument.quoteCurrency,
        })
      }
    }
    return this.fetchFxRates(pairs)
  }

  /**
   * Fetch every requested pair, ONE HTTP REQUEST PER BASE CURRENCY
   * (`?from=USD&to=IDR,EUR`), and aggregate. A single failing base degrades
   * ONLY its own quotes; the result is `status: "error"` (zero quotes staged)
   * only when EVERY base group failed.
   */
  async fetchFxRates(
    pairs: readonly FxPairRequest[]
  ): Promise<MarketFetchResult> {
    const groups = groupPairsByBase(pairs)
    if (groups.size === 0) return emptyOk()

    const observations: MarketFetchResult["observations"] = []
    const failures: string[] = []
    const rawByBase: Record<string, unknown> = {}
    let anyOk = false
    let lastHttpStatus: number | undefined

    for (const [baseCurrency, quoteCurrencies] of groups) {
      const outcome = await this.fetchBaseGroup(baseCurrency, quoteCurrencies)
      lastHttpStatus = outcome.httpStatus ?? lastHttpStatus
      rawByBase[baseCurrency] = outcome.rawPayload
      if (outcome.status === "ok") {
        anyOk = true
        observations.push(...outcome.observations)
      } else {
        failures.push(`${baseCurrency}: ${outcome.error ?? "failed"}`)
      }
    }

    if (!anyOk) {
      return {
        status: "error",
        httpStatus: lastHttpStatus,
        error: `all FX base groups failed — ${failures.join("; ")}`,
        observations: [],
        rawPayload: { errors: failures, byBase: rawByBase },
      }
    }
    return {
      status: "ok",
      httpStatus: lastHttpStatus ?? 200,
      observations,
      rawPayload: { byBase: rawByBase, failures },
    }
  }

  /** Fetch + parse ONE base group. Never throws; returns a staged result. */
  private async fetchBaseGroup(
    baseCurrency: string,
    quoteCurrencies: Iterable<string>
  ): Promise<FxBaseGroupResult> {
    const quotes = [...quoteCurrencies]
    const to = quotes.map(encodeURIComponent).join(",")
    const url =
      `${this.baseUrl}/latest?from=${encodeURIComponent(baseCurrency)}` +
      `&to=${to}`

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
      })
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : "fx fetch failed",
        observations: [],
        rawPayload: { error: String(error) },
      }
    }

    if (!response.ok) {
      const body = await safeReadText(response)
      return {
        status: "error",
        httpStatus: response.status,
        error: `frankfurter HTTP ${response.status}`,
        observations: [],
        rawPayload: { httpStatus: response.status, body },
      }
    }

    let json: unknown
    try {
      json = await response.json()
    } catch (error) {
      return {
        status: "error",
        httpStatus: response.status,
        error: "frankfurter returned non-JSON",
        observations: [],
        rawPayload: { httpStatus: response.status, parseError: String(error) },
      }
    }

    const parsed = parseFrankfurterRatesResponse(json, {
      baseCurrency,
      quoteCurrencies: quotes,
    })
    if (parsed.status !== "ok") {
      return {
        status: "error",
        httpStatus: response.status,
        error: parsed.error,
        observations: [],
        rawPayload: json,
      }
    }
    return {
      status: "ok",
      httpStatus: response.status,
      observations: parsed.observations,
      rawPayload: json,
    }
  }
}

// =============================================================================
// Instrument ensure — the routing prerequisite (ADR-0052 §2)
// =============================================================================

/**
 * Idempotently ensure the `frankfurter`-routed `MarketInstrument` for one
 * (foreign -> base) pair exists, so the router sends it to the ECB adapter.
 *
 * WHY AN EXPLICIT `provider` IS REQUIRED: an `fx` row with `provider = NULL`
 * derives to `yahoo` (ADR-0052 §2) — an adapter that is not registered — so the
 * pair would sit in `skipped` forever and no rate would ever arrive. Rows are
 * therefore created WITH `provider = "frankfurter"`, and an existing
 * NULL-provider row (only reachable for a pre-PER-234 row) is claimed for
 * `frankfurter`. An explicitly declared provider is NEVER overwritten: explicit
 * wins, always. Safe to call repeatedly; recovers from the unique-index race.
 */
export async function ensureFxInstrument(
  pair: FxPairRequest,
  db: Pick<PrismaClient, "marketInstrument"> = prisma
): Promise<string> {
  const baseCurrency = pair.baseCurrency.trim().toUpperCase()
  const quoteCurrency = pair.quoteCurrency.trim().toUpperCase()
  if (baseCurrency.length === 0 || quoteCurrency.length === 0) {
    throw new Error(
      "ensureFxInstrument: baseCurrency and quoteCurrency are required"
    )
  }
  if (baseCurrency === quoteCurrency) {
    throw new Error(
      `ensureFxInstrument: "${baseCurrency}/${quoteCurrency}" is not a currency pair`
    )
  }

  const where = {
    kind: "fx",
    symbol: fxPairSymbol(baseCurrency, quoteCurrency),
    baseCurrency,
    quoteCurrency,
    mic: null,
  } as const

  const existing = await db.marketInstrument.findFirst({
    where,
    select: { id: true, provider: true },
  })
  if (existing) return claimFrankfurterRoute(existing, db)

  try {
    const created = await db.marketInstrument.create({
      data: {
        kind: "fx",
        symbol: fxPairSymbol(baseCurrency, quoteCurrency),
        baseCurrency,
        quoteCurrency,
        provider: FRANKFURTER_PROVIDER_ID,
      },
      select: { id: true },
    })
    return created.id
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.marketInstrument.findFirst({
        where,
        select: { id: true, provider: true },
      })
      if (raced) return claimFrankfurterRoute(raced, db)
    }
    throw error
  }
}

async function claimFrankfurterRoute(
  row: { id: string; provider: string | null },
  db: Pick<PrismaClient, "marketInstrument">
): Promise<string> {
  if (row.provider === null) {
    await db.marketInstrument.update({
      where: { id: row.id },
      data: { provider: FRANKFURTER_PROVIDER_ID },
    })
  }
  return row.id
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  )
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function emptyOk(): MarketFetchResult {
  return { status: "ok", httpStatus: 200, observations: [], rawPayload: null }
}

/** Deduped (base -> quotes) request groups; malformed pairs are dropped. */
function groupPairsByBase(
  pairs: readonly FxPairRequest[]
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>()
  for (const pair of pairs) {
    const baseCurrency = pair.baseCurrency.trim().toUpperCase()
    const quoteCurrency = pair.quoteCurrency.trim().toUpperCase()
    // Unreachable through discovery (it never plans base === quote), but a
    // hand-written request must not turn into a bogus upstream call.
    if (baseCurrency.length === 0 || baseCurrency === quoteCurrency) continue
    if (quoteCurrency.length === 0) continue
    const bucket = groups.get(baseCurrency)
    if (bucket) bucket.add(quoteCurrency)
    else groups.set(baseCurrency, new Set([quoteCurrency]))
  }
  return groups
}

// =============================================================================
// Discovery — which pairs does each family actually need? (pure core + RLS walk)
// =============================================================================

/** A currency a family (or the config) needs that the ECB feed cannot price. */
export interface FxDiscoverySkip {
  /** Absent when the skip is not attributable to one family (config / instrument). */
  familyId?: string
  familyName?: string
  currency?: string
  reason: string
}

/** One family's plan: who to act as, and which (foreign -> base) pairs it needs. */
export interface FxFamilyFxPlan {
  familyId: string
  familyName: string
  /** The active member every tenant-scoped read/write for this family runs as. */
  actorUserId: string
  baseCurrency: string
  pairs: FxPairRequest[]
}

export interface FxDiscoveryResult {
  /** Union of every family's pairs — the set the router must price. */
  pairs: FxPairRequest[]
  families: FxFamilyFxPlan[]
  skipped: FxDiscoverySkip[]
}

/**
 * PURE planning core (no DB, no env): map one family's used + configured
 * currencies to ECB-priceable (foreign -> base) pairs.
 *
 * The ECB whitelist is an HONESTY filter, not an optimization: an unknown
 * `to`/`from` symbol makes the whole Frankfurter request 4xx, so letting a
 * metal/crypto pseudo-currency (XAU, BTC) or a non-ECB ISO code through would
 * poison every pair of that base group. Those become structured skips.
 */
export function planFxPairsForFamily(params: {
  baseCurrency: string
  usedCurrencies: Iterable<string>
  extraCurrencies?: Iterable<string>
}): { pairs: FxPairRequest[]; skipped: FxDiscoverySkip[] } {
  const baseCurrency = params.baseCurrency.trim().toUpperCase()
  const pairs: FxPairRequest[] = []
  const skipped: FxDiscoverySkip[] = []
  const seen = new Set<string>()

  const consider = (raw: string): void => {
    const currency = raw.trim().toUpperCase()
    if (currency.length === 0 || currency === baseCurrency) return
    if (seen.has(currency)) return
    seen.add(currency)
    if (!isFrankfurterSupportedCurrency(currency)) {
      skipped.push({
        currency,
        reason:
          "not published by the ECB/Frankfurter reference-rate universe — no fetch attempted (would 4xx the whole base group)",
      })
      return
    }
    pairs.push({ baseCurrency: currency, quoteCurrency: baseCurrency })
  }

  for (const currency of params.usedCurrencies) consider(currency)
  for (const currency of params.extraCurrencies ?? []) consider(currency)
  return { pairs, skipped }
}

/**
 * Read one family's currency universe inside its own RLS scope. Every source
 * that can carry a foreign amount is included — accounts, transactions
 * (including a transfer's `destinationCurrency`), and valuations — because a
 * historical row in that currency still needs a rate to project correctly.
 * Soft-deleted rows are deliberately NOT filtered out: they keep their
 * history (ADR-0008), and that history may still be rebuilt.
 *
 * Reads are SEQUENTIAL on purpose: a Prisma transaction client is one pg
 * connection and pg rejects overlapping queries on it (see with-family.ts), so
 * `Promise.all` here would be a bug.
 */
async function collectFamilyCurrencies(
  tx: TenantTransactionClient,
  familyId: string
): Promise<{ baseCurrency: string; currencies: Set<string> }> {
  const baseCurrency = await getFamilyBaseCurrency(tx, familyId)

  const accounts = await tx.account.findMany({
    where: { familyId },
    distinct: ["currency"],
    select: { currency: true },
  })
  const transactions = await tx.transaction.findMany({
    where: { familyId },
    distinct: ["currency"],
    select: { currency: true },
  })
  const destinations = await tx.transaction.findMany({
    where: { familyId, destinationCurrency: { not: null } },
    distinct: ["destinationCurrency"],
    select: { destinationCurrency: true },
  })
  const valuations = await tx.valuation.findMany({
    where: { familyId },
    distinct: ["currency"],
    select: { currency: true },
  })

  const currencies = new Set<string>()
  for (const row of accounts) currencies.add(row.currency)
  for (const row of transactions) currencies.add(row.currency)
  for (const row of valuations) currencies.add(row.currency)
  for (const row of destinations) {
    if (row.destinationCurrency !== null)
      currencies.add(row.destinationCurrency)
  }
  return { baseCurrency, currencies }
}

export interface DiscoverFxOptions {
  /** Overrides the `FX_RATE_CURRENCIES` env list (tests pass explicit values). */
  extraCurrencies?: readonly string[]
}

/**
 * Walk every family (RLS-scoped, acting as one of its active members) and
 * plan the FX pairs to price. Pure reads — writes happen later, in
 * `prepareFxAutoIngest` (instruments) and the propagation pass (snapshots).
 *
 * A family with no active member cannot be read at all (RLS needs a member to
 * scope as) — that is a STRUCTURED SKIP, reported, never a silent pass.
 */
export async function discoverFxPairsForFamilies(
  options?: DiscoverFxOptions
): Promise<FxDiscoveryResult> {
  const configuredExtras =
    options?.extraCurrencies ??
    parseFxExtraCurrencies(process.env.FX_RATE_CURRENCIES)
  const families = await listAllFamilies()
  const result: FxDiscoveryResult = { pairs: [], families: [], skipped: [] }

  // Config-scope validation happens ONCE — a typo in FX_RATE_CURRENCIES is one
  // skip, not one per family. (Per-family extras are also re-validated by
  // `planFxPairsForFamily`, which is what keeps an unsupported currency out of
  // the fetch set.)
  const extras: string[] = []
  for (const code of configuredExtras) {
    if (isFrankfurterSupportedCurrency(code)) {
      extras.push(code)
    } else {
      result.skipped.push({
        currency: code,
        reason: `FX_RATE_CURRENCIES entry "${code}" is not published by the ECB/Frankfurter reference-rate universe`,
      })
    }
  }

  const pairsByKey = new Map<string, FxPairRequest>()
  for (const family of families) {
    const actor = await resolveActingMember(family.id)
    if (!actor) {
      result.skipped.push({
        familyId: family.id,
        familyName: family.name,
        reason:
          "no active member — nothing to scope the RLS-scoped FX discovery as",
      })
      continue
    }

    const used = await scopedTenantTransaction(family.id, actor.userId, (tx) =>
      collectFamilyCurrencies(tx, family.id)
    )
    const plan = planFxPairsForFamily({
      baseCurrency: used.baseCurrency,
      usedCurrencies: used.currencies,
      extraCurrencies: extras,
    })
    for (const skip of plan.skipped) {
      result.skipped.push({
        familyId: family.id,
        familyName: family.name,
        ...skip,
      })
    }

    result.families.push({
      familyId: family.id,
      familyName: family.name,
      actorUserId: actor.userId,
      baseCurrency: used.baseCurrency,
      pairs: plan.pairs,
    })
    for (const pair of plan.pairs) {
      pairsByKey.set(fxPairSymbol(pair.baseCurrency, pair.quoteCurrency), pair)
    }
  }

  result.pairs = [...pairsByKey.values()]
  return result
}

// =============================================================================
// Phase 1 — prepare (discover + ensure instruments), phase 3 — propagate
// =============================================================================

export interface FxAutoIngestOptions {
  /** Adapter base URL; defaults to reading `FRANKFURTER_API_URL` at call time. */
  baseUrl?: string
  /** Injectable fetch (tests pass a fixture; prod uses the global `fetch`). */
  fetchImpl?: FetchLike
  /** Overrides the `FX_RATE_CURRENCIES` env list (tests pass explicit values). */
  extraCurrencies?: readonly string[]
}

export type PreparedFxAutoIngest =
  /** FX is opt-in: with no feed configured, keep existing rates, degrade nothing. */
  | { status: "disabled"; reason: string }
  | {
      status: "ready"
      discovery: FxDiscoveryResult
      instrumentsEnsured: number
    }
  /** Discovery/ensure itself blew up (a DB error) — the tick must flag it. */
  | { status: "failed"; error: string }

/**
 * Phase 1: discover the pairs the system really needs and ensure a routed
 * instrument for each, so the router (phase 2) prices exactly those. NEVER
 * throws: every failure degrades to a `failed` summary the scheduler turns
 * into `degraded`, so a broken FX pass can never take the gold/reksadana
 * refresh down with it.
 */
export async function prepareFxAutoIngest(options?: {
  db?: Pick<PrismaClient, "marketInstrument">
  fx?: FxAutoIngestOptions
}): Promise<PreparedFxAutoIngest> {
  if (!isFrankfurterConfigured(options?.fx?.baseUrl)) {
    return {
      status: "disabled",
      reason:
        "FRANKFURTER_API_URL is not set — FX auto-ingestion is off; existing rates are kept and nothing degrades",
    }
  }

  try {
    const discovery = await discoverFxPairsForFamilies({
      extraCurrencies: options?.fx?.extraCurrencies,
    })
    const db = options?.db ?? prisma
    let instrumentsEnsured = 0
    for (const pair of discovery.pairs) {
      try {
        await ensureFxInstrument(pair, db)
        instrumentsEnsured += 1
      } catch (error) {
        // One pair failing (e.g. a currency absent from the ISO registry) must
        // not cost the other pairs their rate.
        discovery.skipped.push({
          currency: pair.baseCurrency,
          reason: `could not ensure the ${fxPairSymbol(pair.baseCurrency, pair.quoteCurrency)} instrument: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      }
    }
    return { status: "ready", discovery, instrumentsEnsured }
  } catch (error) {
    return {
      status: "failed",
      error:
        error instanceof Error
          ? error.message
          : "FX discovery failed unexpectedly",
    }
  }
}

/** What one propagation pass did, for the scheduler's structured summary. */
export interface FxPropagationResult {
  /** Snapshots written: a new date, a changed rate, or a claimed provenance. */
  snapshotsUpserted: number
  /** Already `provider`-sourced with the identical rate — nothing written. */
  snapshotsUnchanged: number
  /** Hand-entered rates deliberately left untouched (operator outranks feed). */
  snapshotsPreservedManual: number
  /** Pairs with no provider quote at all — the family stays FX-pending. */
  pairsWithoutRate: number
  familiesProcessed: number
  familiesFailed: number
  errors: string[]
}

/**
 * Phase 3: promote the latest provider quote for every planned pair into a
 * dated, `source: "provider"` `FxRateSnapshot` for the family that needs it.
 *
 * Runs INSIDE one `scopedTenantTransaction` per family (acting as a real
 * active member) and reuses `upsertFxRateSnapshotForFamily`, so a promoted
 * rate gets the SAME audit rows, the SAME natural-key idempotency, and the
 * SAME scoped projection rebuild as a hand-entered one (ADR-0035 §4/§7). The
 * nested call runs on the ALREADY-OPEN transaction via the
 * `runInTenantTransaction` seam — a nested `prisma.$transaction` would throw.
 *
 * The quote read is GLOBAL (`MarketInstrument` / `MarketQuote` carry no RLS),
 * so it is loaded ONCE before the per-family loop rather than per family.
 */
export async function propagateFxRateSnapshotsForFamilies(
  discovery: FxDiscoveryResult,
  db: Pick<PrismaClient, "marketInstrument" | "marketQuote"> = prisma
): Promise<FxPropagationResult> {
  const result: FxPropagationResult = {
    snapshotsUpserted: 0,
    snapshotsUnchanged: 0,
    snapshotsPreservedManual: 0,
    pairsWithoutRate: 0,
    familiesProcessed: 0,
    familiesFailed: 0,
    errors: [],
  }

  const { instrumentIds, latestQuotes } = await loadLatestProviderFxQuotes(db)

  for (const family of discovery.families) {
    if (family.pairs.length === 0) continue
    try {
      const counts = await scopedTenantTransaction(
        family.familyId,
        family.actorUserId,
        async (tx) => {
          const baseCurrency = await getFamilyBaseCurrency(tx, family.familyId)
          const local = {
            upserted: 0,
            unchanged: 0,
            preservedManual: 0,
            withoutRate: 0,
          }

          for (const pair of family.pairs) {
            // The family changed its base currency between discovery and this
            // pass — the plan is stale, so re-plan next tick instead of
            // writing a snapshot for a base nobody reports in.
            if (pair.quoteCurrency !== baseCurrency) continue

            const key = fxPairSymbol(pair.baseCurrency, pair.quoteCurrency)
            const instrumentId = instrumentIds.get(key)
            const quote = instrumentId
              ? latestQuotes.get(instrumentId)
              : undefined
            if (!quote) {
              // No usable provider quote (the fetch failed, or the pair was
              // not returned): stay FX-pending. NEVER invent a rate.
              local.withoutRate += 1
              continue
            }
            if (quote.priceScale !== FX_PRICE_DECIMALS) {
              // Defensive: fx quotes are always 1e12. A foreign scale means a
              // corrupt row — skip it rather than mis-scale money.
              result.errors.push(
                `${family.familyName} ${key}: unexpected quote priceScale ${quote.priceScale}`
              )
              continue
            }

            const existing = await tx.fxRateSnapshot.findUnique({
              where: {
                fx_rate_snapshot_unique: {
                  familyId: family.familyId,
                  fromCurrency: pair.baseCurrency,
                  toCurrency: pair.quoteCurrency,
                  asOfDate: quote.asOf,
                },
              },
              select: { rateScaled: true, source: true },
            })
            if (existing) {
              if (existing.source === "manual") {
                local.preservedManual += 1
                continue
              }
              if (
                existing.source === FX_PROVIDER_SNAPSHOT_SOURCE &&
                existing.rateScaled === quote.price
              ) {
                // Same-day re-run: the exact row already exists — write
                // nothing (no UPDATE, no audit row).
                local.unchanged += 1
                continue
              }
            }

            await upsertFxRateSnapshotForFamily({
              data: {
                fromCurrency: pair.baseCurrency,
                toCurrency: pair.quoteCurrency,
                rate: decodeRate(quote.price),
                asOfDate: quote.asOf,
                source: FX_PROVIDER_SNAPSHOT_SOURCE,
              },
              familyId: family.familyId,
              user: { id: family.actorUserId },
              // Reuse the transaction this pass already opened — nesting a
              // second interactive transaction is not allowed.
              runInTenantTransaction: (_familyId, _userId, fn) => fn(tx),
            })
            local.upserted += 1
          }
          return local
        }
      )
      result.familiesProcessed += 1
      result.snapshotsUpserted += counts.upserted
      result.snapshotsUnchanged += counts.unchanged
      result.snapshotsPreservedManual += counts.preservedManual
      result.pairsWithoutRate += counts.withoutRate
    } catch (error) {
      result.familiesFailed += 1
      result.errors.push(
        `${family.familyName}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return result
}

/**
 * Load, ONCE and outside any family scope, the latest `frankfurter`-sourced
 * quote per fx instrument. `MarketInstrument` / `MarketQuote` are global
 * (non-RLS) tables, so this read needs no family context and no BYPASSRLS.
 */
async function loadLatestProviderFxQuotes(
  db: Pick<PrismaClient, "marketInstrument" | "marketQuote">
): Promise<{
  instrumentIds: Map<string, string>
  latestQuotes: Map<string, { asOf: Date; price: bigint; priceScale: number }>
}> {
  const instruments = await db.marketInstrument.findMany({
    where: { kind: "fx" },
    select: { id: true, symbol: true, baseCurrency: true, quoteCurrency: true },
  })
  const instrumentIds = new Map<string, string>()
  for (const instrument of instruments) {
    if (instrument.baseCurrency === null) continue
    instrumentIds.set(
      fxPairSymbol(instrument.baseCurrency, instrument.quoteCurrency),
      instrument.id
    )
  }

  // DESC by asOf, first row per instrument wins = the latest provider quote.
  const quotes = await db.marketQuote.findMany({
    where: {
      marketInstrumentId: { in: [...instrumentIds.values()] },
      source: FRANKFURTER_PROVIDER_ID,
    },
    orderBy: { asOf: "desc" },
    select: {
      marketInstrumentId: true,
      asOf: true,
      price: true,
      priceScale: true,
    },
  })
  const latestQuotes = new Map<
    string,
    { asOf: Date; price: bigint; priceScale: number }
  >()
  for (const quote of quotes) {
    if (latestQuotes.has(quote.marketInstrumentId)) continue
    latestQuotes.set(quote.marketInstrumentId, {
      asOf: quote.asOf,
      price: quote.price,
      priceScale: quote.priceScale,
    })
  }
  return { instrumentIds, latestQuotes }
}

// =============================================================================
// The scheduler-facing summary
// =============================================================================

/** One scheduled refresh's FX outcome — logged and returned over HTTP. */
export interface FxRefreshSummary {
  /** False when no feed is configured (`FRANKFURTER_API_URL` unset). */
  enabled: boolean
  /** Present only when FX degraded — drives the refresh's `degraded` flag. */
  error?: string
  /** Why FX is off when it simply is not configured (NOT a degradation). */
  disabledReason?: string
  pairsDiscovered: number
  instrumentsEnsured: number
  familiesDiscovered: number
  snapshotsUpserted: number
  snapshotsUnchanged: number
  snapshotsPreservedManual: number
  pairsWithoutRate: number
  familiesFailed: number
  /** Structured skips (unsupported currencies, unscoped families, …). */
  skipped: FxDiscoverySkip[]
}

/**
 * Fold the two FX phases into the one summary the scheduler logs/returns.
 * `error` is set for a failed discovery or a family that could not be
 * propagated — both are abnormal and must surface as `degraded`.
 */
export function summarizeFxAutoIngest(
  prepared: PreparedFxAutoIngest,
  propagation?: FxPropagationResult
): FxRefreshSummary {
  if (prepared.status === "disabled") {
    return {
      enabled: false,
      disabledReason: prepared.reason,
      pairsDiscovered: 0,
      instrumentsEnsured: 0,
      familiesDiscovered: 0,
      snapshotsUpserted: 0,
      snapshotsUnchanged: 0,
      snapshotsPreservedManual: 0,
      pairsWithoutRate: 0,
      familiesFailed: 0,
      skipped: [],
    }
  }

  const discovery = prepared.status === "ready" ? prepared.discovery : undefined
  const errors = propagation?.errors ?? []
  const error =
    prepared.status === "failed"
      ? prepared.error
      : errors.length > 0
        ? errors.join("; ")
        : undefined

  const summary: FxRefreshSummary = {
    enabled: true,
    pairsDiscovered: discovery?.pairs.length ?? 0,
    instrumentsEnsured:
      prepared.status === "ready" ? prepared.instrumentsEnsured : 0,
    familiesDiscovered: discovery?.families.length ?? 0,
    snapshotsUpserted: propagation?.snapshotsUpserted ?? 0,
    snapshotsUnchanged: propagation?.snapshotsUnchanged ?? 0,
    snapshotsPreservedManual: propagation?.snapshotsPreservedManual ?? 0,
    pairsWithoutRate: propagation?.pairsWithoutRate ?? 0,
    familiesFailed: propagation?.familiesFailed ?? 0,
    skipped: discovery?.skipped ?? [],
  }
  if (error !== undefined) summary.error = error
  return summary
}
