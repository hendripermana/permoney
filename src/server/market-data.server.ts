/**
 * Market data — provider interface, fixture adapter, and ingest pipeline
 * (ADR-0050 / PER-233). SERVER-ONLY: imports Prisma, so it carries the
 * `.server.ts` hard fence (CLAUDE.md §6) and is side-effect free at module
 * scope.
 * =============================================================================
 *
 * Responsibilities (the small public surface of a deep module):
 *   - `MarketDataProvider` — the ONLY seam a vendor lives behind. The normalizer
 *     and every consumer speak `MarketInstrument`/`MarketQuote`, never a vendor.
 *   - `MarketFixtureProvider` — a deterministic, no-network, no-secrets adapter
 *     that proves the pipeline end to end (real adapters are PER-234+).
 *   - `ingestMarketDataOnce` — one raw → staged → canonical cycle:
 *       1. call the provider (never letting it throw the pipeline dead),
 *       2. persist the raw payload to `RawMarketDataFetch` FIRST (provenance),
 *       3. on success, normalize + idempotently upsert canonical `MarketQuote`
 *          rows (UNIQUE (marketInstrumentId, asOf, source) → re-ingest is a
 *          no-op, never a duplicate),
 *       4. on provider failure, record the failure and write ZERO quotes —
 *          the last good quote is untouched (graceful degradation).
 *
 * LEDGER ISOLATION: this pipeline writes ONLY the three global market-data
 * tables. It never touches `Transaction`, an account `balance`, or a valuation
 * anchor (ADR-0050 §6). Wiring quotes → valuations/holdings is PER-238.
 *
 * AUDIT: the global tables carry no `familyId`, so the tenant-scoped `AuditLog`
 * does not apply. Provenance IS the audit trail here — every canonical quote is
 * dated, `source`-stamped, and linked (`rawFetchId`) to the exact raw fetch it
 * was normalized from.
 */

import type { Prisma, PrismaClient } from "@prisma/client"
import {
  BSI_GOLD_QUOTE_CURRENCY,
  BSI_GOLD_SYMBOL,
  isMarketInstrumentKind,
  normalizeObservations,
  parseLogamMuliaGoldResponse,
  resolveProviderId,
  type GoldPriceField,
  type MarketInstrumentIdentity,
  type MarketInstrumentKind,
  type MarketObservation,
  type ProviderId,
} from "@/lib/market-data"
import { prisma } from "./db.server"

// -----------------------------------------------------------------------------
// Provider interface (the vendor seam)
// -----------------------------------------------------------------------------

/** A request for one FX pair's rate. */
export interface FxPairRequest {
  baseCurrency: string
  quoteCurrency: string
}

/** A request for one spot-priced instrument (metal / security / crypto). */
export interface SpotRequest {
  kind: Exclude<MarketInstrumentKind, "fx">
  symbol: string
  quoteCurrency: string
  /** Securities only. */
  mic?: string
}

/** The general instrument request accepted by `fetchQuotes`. */
export type MarketInstrumentRequest =
  | ({ kind: "fx" } & FxPairRequest)
  | SpotRequest

/**
 * The outcome of a single provider call. `observations` is empty when `status`
 * is "error"; `rawPayload` is always captured for staging, success or failure.
 */
export interface MarketFetchResult {
  status: "ok" | "error"
  httpStatus?: number
  error?: string
  observations: MarketObservation[]
  rawPayload: unknown
}

/**
 * The provider-agnostic contract. Adapters are the only code that knows a vendor
 * exists; swapping vendors is one new implementation, zero consumer changes.
 * Real adapters read secrets ONLY inside their own `.server.ts` module.
 */
export interface MarketDataProvider {
  readonly name: string
  fetchFxRates(pairs: readonly FxPairRequest[]): Promise<MarketFetchResult>
  fetchSpot(requests: readonly SpotRequest[]): Promise<MarketFetchResult>
  fetchQuotes(
    instruments: readonly MarketInstrumentRequest[]
  ): Promise<MarketFetchResult>
}

// -----------------------------------------------------------------------------
// Fixture adapter — deterministic, no network, no secrets
// -----------------------------------------------------------------------------

/** A canned price the fixture returns for a requested instrument. */
export interface FixtureQuote {
  kind: MarketInstrumentKind
  symbol: string
  baseCurrency?: string
  quoteCurrency: string
  mic?: string
  priceDecimal: string
  providerRef?: string
}

export interface MarketFixtureOptions {
  /** Provider label (also used as the quote `source`). Defaults to "fixture". */
  name?: string
  /** Fixed observation time so re-runs are byte-identical. */
  asOf?: Date
  /** The canned prices, keyed by symbol lookup during a fetch. */
  quotes: readonly FixtureQuote[]
  /** When true, every fetch returns a graceful `status: "error"` result. */
  failWith?: string
}

/**
 * A deterministic in-memory provider. Given a fixed set of canned quotes it
 * echoes back exactly the requested instruments as observations at a fixed
 * `asOf`, so ingesting twice produces identical canonical rows. `failWith`
 * simulates a provider outage (for the keep-last-good test).
 */
export class MarketFixtureProvider implements MarketDataProvider {
  readonly name: string
  private readonly asOf: Date
  private readonly failWith: string | undefined
  private readonly bySymbol: Map<string, FixtureQuote>

  constructor(options: MarketFixtureOptions) {
    this.name = options.name ?? "fixture"
    this.asOf = options.asOf ?? new Date("2026-08-07T00:00:00.000Z")
    this.failWith = options.failWith
    this.bySymbol = new Map(
      options.quotes.map((quote) => [fixtureKey(quote), quote])
    )
  }

  private resolve(
    lookups: readonly { kind: MarketInstrumentKind; symbol: string }[]
  ): MarketFetchResult {
    if (this.failWith !== undefined) {
      return {
        status: "error",
        error: this.failWith,
        observations: [],
        rawPayload: { error: this.failWith },
      }
    }
    const observations: MarketObservation[] = []
    for (const lookup of lookups) {
      const quote = this.bySymbol.get(`${lookup.kind}:${lookup.symbol}`)
      if (!quote) continue
      observations.push({
        kind: quote.kind,
        symbol: quote.symbol,
        baseCurrency: quote.baseCurrency,
        quoteCurrency: quote.quoteCurrency,
        mic: quote.mic,
        asOf: this.asOf,
        priceDecimal: quote.priceDecimal,
        providerRef: quote.providerRef,
      })
    }
    return {
      status: "ok",
      httpStatus: 200,
      observations,
      rawPayload: { quotes: observations.map(serializeObservation) },
    }
  }

  fetchFxRates(pairs: readonly FxPairRequest[]): Promise<MarketFetchResult> {
    return Promise.resolve(
      this.resolve(
        pairs.map((pair) => ({
          kind: "fx" as const,
          symbol: `${pair.baseCurrency}/${pair.quoteCurrency}`,
        }))
      )
    )
  }

  fetchSpot(requests: readonly SpotRequest[]): Promise<MarketFetchResult> {
    return Promise.resolve(
      this.resolve(requests.map((r) => ({ kind: r.kind, symbol: r.symbol })))
    )
  }

  fetchQuotes(
    instruments: readonly MarketInstrumentRequest[]
  ): Promise<MarketFetchResult> {
    return Promise.resolve(
      this.resolve(
        instruments.map((instrument) => ({
          kind: instrument.kind,
          symbol:
            instrument.kind === "fx"
              ? `${instrument.baseCurrency}/${instrument.quoteCurrency}`
              : instrument.symbol,
        }))
      )
    )
  }
}

function fixtureKey(quote: FixtureQuote): string {
  return `${quote.kind}:${quote.symbol}`
}

function serializeObservation(
  observation: MarketObservation
): Record<string, unknown> {
  return {
    kind: observation.kind,
    symbol: observation.symbol,
    baseCurrency: observation.baseCurrency ?? null,
    quoteCurrency: observation.quoteCurrency,
    mic: observation.mic ?? null,
    asOf: observation.asOf.toISOString(),
    priceDecimal: observation.priceDecimal,
    providerRef: observation.providerRef ?? null,
  }
}

// -----------------------------------------------------------------------------
// Ingest pipeline
// -----------------------------------------------------------------------------

/** The Prisma surface the pipeline needs — a full client (has `$transaction`). */
export type MarketDataDb = Pick<
  PrismaClient,
  | "marketInstrument"
  | "marketQuote"
  | "rawMarketDataFetch"
  | "$transaction"
  | "$queryRaw"
>

export interface IngestSummary {
  rawFetchId: string
  status: "ok" | "error"
  /** Provider/error message when `status` is "error". */
  error?: string
  quotesUpserted: number
  instrumentsResolved: number
  rejected: number
}

export interface IngestOptions {
  provider: MarketDataProvider
  requests: readonly MarketInstrumentRequest[]
  db?: MarketDataDb
}

/**
 * Run ONE market-data ingest cycle with the given provider. No scheduler — that
 * is PER-237. Safe to call repeatedly: the canonical write path is idempotent.
 */
export async function ingestMarketDataOnce(
  options: IngestOptions
): Promise<IngestSummary> {
  const db = options.db ?? prisma
  const result = await callProvider(options.provider, options.requests)

  return await db.$transaction(async (tx) => {
    // 1. Stage the raw payload FIRST — provenance regardless of outcome.
    const rawFetch = await tx.rawMarketDataFetch.create({
      data: {
        provider: options.provider.name,
        requestedInstruments: toJson(options.requests),
        payload: toJson(result.rawPayload),
        status: result.status,
        httpStatus: result.httpStatus ?? null,
        error: result.error ?? null,
      },
      select: { id: true },
    })

    // 2. Graceful degradation: a failed fetch writes ZERO canonical quotes and
    //    leaves the last good quote untouched.
    if (result.status !== "ok") {
      return {
        rawFetchId: rawFetch.id,
        status: "error",
        error: result.error,
        quotesUpserted: 0,
        instrumentsResolved: 0,
        rejected: 0,
      }
    }

    // 3. Normalize (validate + encode + dedup within the fetch), then resolve
    //    each identity to an instrument and idempotently upsert its quote.
    const normalized = normalizeObservations(result.observations)
    const resolvedInstruments = new Set<string>()
    let quotesUpserted = 0

    for (const quote of normalized.quotes) {
      const instrumentId = await resolveInstrumentId(tx, quote.identity)
      resolvedInstruments.add(instrumentId)

      await tx.marketQuote.upsert({
        where: {
          marketInstrumentId_asOf_source: {
            marketInstrumentId: instrumentId,
            asOf: quote.asOf,
            source: options.provider.name,
          },
        },
        // Re-ingest with a corrected value updates IN PLACE (idempotent),
        // never inserts a duplicate.
        update: {
          price: quote.price,
          priceScale: quote.priceScale,
          quoteCurrency: quote.quoteCurrency,
          providerRef: quote.providerRef,
          rawFetchId: rawFetch.id,
        },
        create: {
          marketInstrumentId: instrumentId,
          asOf: quote.asOf,
          price: quote.price,
          priceScale: quote.priceScale,
          quoteCurrency: quote.quoteCurrency,
          source: options.provider.name,
          providerRef: quote.providerRef,
          rawFetchId: rawFetch.id,
        },
      })
      quotesUpserted += 1
    }

    return {
      rawFetchId: rawFetch.id,
      status: "ok",
      quotesUpserted,
      instrumentsResolved: resolvedInstruments.size,
      rejected: normalized.rejected.length,
    }
  })
}

/** Call the provider, converting a thrown vendor error into a staged failure. */
async function callProvider(
  provider: MarketDataProvider,
  requests: readonly MarketInstrumentRequest[]
): Promise<MarketFetchResult> {
  try {
    return await provider.fetchQuotes(requests)
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "provider threw",
      observations: [],
      rawPayload: {
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Resolve an instrument identity to its id, creating the `MarketInstrument`
 * on first sight. Identity is (kind, symbol, COALESCE(mic,''), quoteCurrency);
 * a concurrent create that loses the unique-index race is recovered by a
 * re-find, so the resolve is idempotent.
 */
async function resolveInstrumentId(
  tx: Pick<PrismaClient, "marketInstrument">,
  identity: MarketInstrumentIdentity
): Promise<string> {
  const existing = await findInstrument(tx, identity)
  if (existing) return existing.id

  try {
    const created = await tx.marketInstrument.create({
      data: {
        kind: identity.kind,
        symbol: identity.symbol,
        baseCurrency: identity.baseCurrency,
        quoteCurrency: identity.quoteCurrency,
        mic: identity.mic,
      },
      select: { id: true },
    })
    return created.id
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findInstrument(tx, identity)
      if (raced) return raced.id
    }
    throw error
  }
}

function findInstrument(
  tx: Pick<PrismaClient, "marketInstrument">,
  identity: MarketInstrumentIdentity
): Promise<{ id: string } | null> {
  return tx.marketInstrument.findFirst({
    where: {
      kind: identity.kind,
      symbol: identity.symbol,
      baseCurrency: identity.baseCurrency,
      quoteCurrency: identity.quoteCurrency,
      mic: identity.mic,
    },
    select: { id: true },
  })
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  )
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return (value ?? null) as Prisma.InputJsonValue
}

// -----------------------------------------------------------------------------
// Gold feed adapter — self-hosted logam-mulia-api (PER-235 / ADR-0050 slice 3)
// -----------------------------------------------------------------------------
//
// The ONLY code that knows the gold vendor exists. It tries the worker's gold
// endpoints in a priority FALLBACK CHAIN (PER-235c) — `GET {base}/api/prices/
// {source}` for each source in `GOLD_SOURCE_CHAIN` — and uses the FIRST that
// returns `success:true`, so gold ALWAYS gets a number as close to the user's BSI
// Gold as is currently available. It stages the winning source's JSON verbatim
// and hands the pure parser (`parseLogamMuliaGoldResponse`, @/lib/market-data) a
// single per-troy-ounce metal observation (all sources price the ONE `XAU-BSI`
// series). Secrets/config (`LOGAM_MULIA_API_URL`) are read ONLY here, at CALL
// time (never module scope). Graceful degradation is total: if EVERY source fails
// (worker outage, non-2xx such as the persistent BSI 429, non-JSON,
// `success:false`, or a malformed shape) the chain returns `status:"error"` with
// the aggregated reasons captured — never a throw, never a bad quote (ADR-0050 §4).

/**
 * The gold source fallback chain, in PRIORITY order — the FIRST source that
 * returns `success:true` wins (PER-235c). Each label is BOTH the worker endpoint
 * path segment (`/api/prices/{source}`) AND the quote `source`/provenance tag.
 *
 *   1. `bankbsi`    — the creator's exact BSI Gold price (when the source is up).
 *   2. `anekalogam` — Antam LM; BSI sells Antam gold, so this is the CLOSEST
 *                     reliable proxy (~1% below BSI's mark — flagged as a known
 *                     approximation on fallback).
 *   3. `pegadaian`  — the final reliable fallback.
 *
 * A small, readable constant so re-ordering the priority is a one-line change.
 */
export const GOLD_SOURCE_CHAIN = ["bankbsi", "anekalogam", "pegadaian"] as const

export type GoldSource = (typeof GOLD_SOURCE_CHAIN)[number]

/**
 * Minimal fetch surface the gold adapter needs (typed, no `any`). Tests inject a
 * fixture returning a canned `Response`; production uses the global `fetch`.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<Response>

/** The canonical BSI-gold instrument identity (metal, IDR, per-troy-ounce). */
export const GOLD_INSTRUMENT_IDENTITY: MarketInstrumentIdentity = {
  kind: "metal",
  symbol: BSI_GOLD_SYMBOL,
  baseCurrency: null,
  quoteCurrency: BSI_GOLD_QUOTE_CURRENCY,
  mic: null,
}

/** The request recorded on the raw fetch when ingesting BSI gold. */
export const GOLD_INSTRUMENT_REQUEST: MarketInstrumentRequest = {
  kind: "metal",
  symbol: BSI_GOLD_SYMBOL,
  quoteCurrency: BSI_GOLD_QUOTE_CURRENCY,
}

/** Read the worker base URL at CALL time; a clear error if unset (never module scope). */
function requireLogamMuliaApiUrl(): string {
  const raw = process.env.LOGAM_MULIA_API_URL
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      "LOGAM_MULIA_API_URL is not set — configure the self-hosted logam-mulia-api base URL to ingest gold prices (ADR-0050 / PER-235)."
    )
  }
  return raw.trim().replace(/\/+$/, "")
}

export interface LogamMuliaGoldProviderOptions {
  /** Base URL; defaults to reading `LOGAM_MULIA_API_URL` at call time. */
  baseUrl?: string
  /** Injectable fetch (tests pass a fixture; prod uses the global `fetch`). */
  fetchImpl?: FetchLike
  /** Which published price to quote (buyback default). */
  priceField?: GoldPriceField
  /** Clock for the as-of fallback (tests pin it). */
  now?: () => Date
}

/**
 * The self-hosted logam-mulia-api gold adapter. Serves gold spot only; FX/other
 * spot are different feeds (a no-op empty-ok result here, so a mixed ingest never
 * errors on this provider).
 */
export class LogamMuliaGoldProvider implements MarketDataProvider {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly priceField: GoldPriceField | undefined
  private readonly now: () => Date
  /**
   * The source that actually returned a usable quote this run (set during
   * `fetchGold`). The pipeline reads `provider.name` AFTER the fetch resolves to
   * stamp the quote `source`/provenance, so it reflects the WINNING source (or
   * the primary `bankbsi` when every source failed and no quote is written).
   */
  private succeededSource: GoldSource | undefined

  /** Provenance the ingest pipeline stamps on the raw fetch + canonical quote. */
  get name(): string {
    return this.succeededSource ?? GOLD_SOURCE_CHAIN[0]
  }

  constructor(options?: LogamMuliaGoldProviderOptions) {
    this.baseUrl = options?.baseUrl ?? requireLogamMuliaApiUrl()
    this.fetchImpl = options?.fetchImpl ?? ((url, init) => fetch(url, init))
    this.priceField = options?.priceField
    this.now = options?.now ?? (() => new Date())
  }

  fetchFxRates(): Promise<MarketFetchResult> {
    return Promise.resolve({
      status: "ok",
      httpStatus: 200,
      observations: [],
      rawPayload: null,
    })
  }

  fetchSpot(): Promise<MarketFetchResult> {
    return this.fetchGold()
  }

  fetchQuotes(): Promise<MarketFetchResult> {
    return this.fetchGold()
  }

  /**
   * Try each source in `GOLD_SOURCE_CHAIN` in priority order and return the FIRST
   * that yields a usable quote. `succeededSource` is set to the winner so the
   * pipeline stamps the correct provenance. If EVERY source fails, the aggregated
   * per-source reasons are returned as one graceful error (no throw, no quote).
   */
  private async fetchGold(): Promise<MarketFetchResult> {
    this.succeededSource = undefined
    const failures: string[] = []
    let lastHttpStatus: number | undefined

    for (const source of GOLD_SOURCE_CHAIN) {
      const outcome = await this.fetchOneSource(source)
      if (outcome.status === "ok") {
        this.succeededSource = source
        return outcome
      }
      failures.push(`${source}: ${outcome.error ?? "failed"}`)
      lastHttpStatus = outcome.httpStatus ?? lastHttpStatus
    }

    return {
      status: "error",
      httpStatus: lastHttpStatus,
      error: `all gold sources failed — ${failures.join("; ")}`,
      observations: [],
      rawPayload: { errors: failures },
    }
  }

  /** Fetch + parse ONE source endpoint. Never throws; returns a staged result. */
  private async fetchOneSource(source: GoldSource): Promise<MarketFetchResult> {
    const url = `${this.baseUrl}/api/prices/${source}`

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
      })
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : "gold fetch failed",
        observations: [],
        rawPayload: { error: String(error) },
      }
    }

    if (!response.ok) {
      const body = await safeReadText(response)
      return {
        status: "error",
        httpStatus: response.status,
        error: `gold feed HTTP ${response.status}`,
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
        error: "gold feed returned non-JSON",
        observations: [],
        rawPayload: { httpStatus: response.status, parseError: String(error) },
      }
    }

    const parsed = parseLogamMuliaGoldResponse(json, {
      priceField: this.priceField,
      fallbackAsOf: this.now(),
      sourceLabel: source,
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

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

/**
 * Idempotently ensure the canonical BSI-gold `MarketInstrument` exists so a
 * holding can be LINKED to it (PER-238) even before the first successful fetch.
 * Safe to call repeatedly; recovers from the unique-index race. Returns its id.
 */
export async function ensureBsiGoldInstrument(
  db: Pick<PrismaClient, "marketInstrument"> = prisma
): Promise<string> {
  const where = {
    kind: "metal",
    symbol: BSI_GOLD_SYMBOL,
    baseCurrency: null,
    quoteCurrency: BSI_GOLD_QUOTE_CURRENCY,
    mic: null,
  } as const

  const existing = await db.marketInstrument.findFirst({
    where,
    select: { id: true },
  })
  if (existing) return existing.id

  try {
    const created = await db.marketInstrument.create({
      data: {
        kind: "metal",
        symbol: BSI_GOLD_SYMBOL,
        name: "BSI Gold",
        quoteCurrency: BSI_GOLD_QUOTE_CURRENCY,
      },
      select: { id: true },
    })
    return created.id
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.marketInstrument.findFirst({
        where,
        select: { id: true },
      })
      if (raced) return raced.id
    }
    throw error
  }
}

export interface IngestGoldOptions {
  /** Base URL; defaults to reading `LOGAM_MULIA_API_URL` at call time. */
  baseUrl?: string
  /** Injectable fetch (tests pass a fixture; prod uses the global `fetch`). */
  fetchImpl?: FetchLike
  /** Which published price to quote (buyback default). */
  priceField?: GoldPriceField
  /** Clock for the as-of fallback (tests pin it). */
  now?: () => Date
  db?: MarketDataDb
}

/**
 * Run ONE BSI-gold ingest cycle. No scheduler — that is PER-237. First ENSURES
 * the canonical instrument exists (so it stays linkable even when the fetch then
 * fails), then runs the shared raw → staged → canonical pipeline. Safe to call
 * repeatedly: the canonical write path is idempotent.
 */
export async function ingestGoldPricesOnce(
  options?: IngestGoldOptions
): Promise<IngestSummary> {
  const db = options?.db ?? prisma
  await ensureBsiGoldInstrument(db)
  const provider = new LogamMuliaGoldProvider({
    baseUrl: options?.baseUrl,
    fetchImpl: options?.fetchImpl,
    priceField: options?.priceField,
    now: options?.now,
  })
  return await ingestMarketDataOnce({
    provider,
    requests: [GOLD_INSTRUMENT_REQUEST],
    db,
  })
}

// =============================================================================
// Financial Ingestion Service — provider registry + routing engine (PER-257 /
// ADR-0052)
// =============================================================================
//
// A modular ROUTER in front of the single `ingestMarketDataOnce` seam. Given a
// set of instruments of mixed kinds it selects the right adapter per instrument
// (pure `resolveProviderId`), batches per adapter, and ingests each batch through
// the unchanged raw -> staged -> canonical pipeline. Adding a vendor = one
// adapter + one registry entry, with zero consumer change.
//
// The routing DECISION is pure (`@/lib/market-data`); which adapters actually
// EXIST — and their secrets — live here, behind the `.server.ts` fence. Factories
// are LAZY so an adapter whose env/secret is unset only throws when its own group
// is invoked, and that throw degrades to a per-group error, never aborting the
// other groups.

/** A lazy adapter factory: constructing it may read env/secrets (call time). */
export type ProviderFactory = () => MarketDataProvider

/** The registry the router looks an adapter up in by its `ProviderId`. */
export type ProviderRegistry = Map<ProviderId, ProviderFactory>

/** Gold-adapter construction knobs (tests inject a fixture fetch / clock). */
export interface DefaultRegistryGoldOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
  priceField?: GoldPriceField
  now?: () => Date
}

export interface DefaultRegistryOptions {
  /** Passthrough for the `logam_mulia` gold adapter (see LogamMuliaGoldProvider). */
  gold?: DefaultRegistryGoldOptions
}

/**
 * The production registry. Slice A registers ONLY `logam_mulia` (gold now flows
 * THROUGH the router, proving the mechanism before fragile sources plug in).
 * `reksadana_id` (PER-257 Slice B) and `yahoo` / `alpaca` / `twelvedata`
 * (later slices) drop in here with no consumer change. The factory is lazy: the
 * gold provider reads `LOGAM_MULIA_API_URL` only when actually constructed.
 */
export function createDefaultProviderRegistry(
  options?: DefaultRegistryOptions
): ProviderRegistry {
  const registry: ProviderRegistry = new Map()
  registry.set(
    "logam_mulia",
    () =>
      new LogamMuliaGoldProvider({
        baseUrl: options?.gold?.baseUrl,
        fetchImpl: options?.gold?.fetchImpl,
        priceField: options?.gold?.priceField,
        now: options?.gold?.now,
      })
  )
  return registry
}

/** The routing-relevant columns the router loads for each instrument. */
type RoutableInstrument = {
  id: string
  kind: string
  symbol: string
  mic: string | null
  quoteCurrency: string
  baseCurrency: string | null
  provider: string | null
}

const ROUTABLE_SELECT = {
  id: true,
  kind: true,
  symbol: true,
  mic: true,
  quoteCurrency: true,
  baseCurrency: true,
  provider: true,
} as const

/** One adapter group's outcome in the aggregate summary. */
export interface ProviderIngestSummary {
  providerId: ProviderId
  /** Instruments routed to this adapter this run. */
  instrumentCount: number
  /** Canonical quotes written for this group (0 on this group's failure). */
  ingested: number
  /** Present only when THIS group degraded (its adapter failed / is misconfigured). */
  error?: string
}

/** An instrument the router could not send anywhere (no adapter routed/registered). */
export interface SkippedInstrument {
  marketInstrumentId: string
  symbol: string
  reason: string
}

export interface IngestAllSummary {
  perProvider: ProviderIngestSummary[]
  totalIngested: number
  skipped: SkippedInstrument[]
}

export interface IngestAllOptions {
  db?: MarketDataDb
  /** Adapter registry; defaults to the production registry (gold only, Slice A). */
  registry?: ProviderRegistry
  /** Gold passthrough used only when building the DEFAULT registry. */
  gold?: DefaultRegistryGoldOptions
  /**
   * Instrument ids to price REGARDLESS of holding links (the on-demand baseline).
   * `syncMarketPricesOnce` passes the ensured BSI-gold id so gold still refreshes
   * on an install that has not linked a gold holding yet (unchanged behaviour).
   */
  baselineInstrumentIds?: readonly string[]
}

/**
 * Ingest EVERY instrument this install can price, routed per adapter (ADR-0052
 * §3). Bounded work: only instruments LINKED to at least one holding (plus any
 * explicit `baselineInstrumentIds`) — never the whole catalog.
 *
 * Per-adapter FAILURE ISOLATION: each group runs in its own try/catch. An adapter
 * that is unreachable / misconfigured / throws on construction degrades to
 * `{ ingested: 0, error }` for ITS instruments only; other groups still refresh,
 * the last-good `MarketQuote` is retained, and the failed `RawMarketDataFetch` is
 * staged by `ingestMarketDataOnce`. An instrument that routes nowhere (unroutable
 * kind, or a routed id with no registered adapter) lands in `skipped`.
 *
 * GLOBAL ingest ONLY — writes exclusively the three global market tables, NEVER
 * the ledger, so it runs OUTSIDE any family RLS transaction (ADR-0050 §6).
 */
export async function ingestAllLinkedInstrumentsOnce(
  options?: IngestAllOptions
): Promise<IngestAllSummary> {
  const db = options?.db ?? prisma
  const registry =
    options?.registry ?? createDefaultProviderRegistry({ gold: options?.gold })

  const instruments = await loadRoutableInstruments(
    db,
    options?.baselineInstrumentIds ?? []
  )

  // 1. Group by routed adapter; collect structured skips as we go.
  const groups = new Map<ProviderId, RoutableInstrument[]>()
  const skipped: SkippedInstrument[] = []
  for (const instrument of instruments) {
    const route = resolveProviderId({
      kind: instrument.kind as MarketInstrumentKind,
      symbol: instrument.symbol,
      mic: instrument.mic,
      provider: instrument.provider,
    })
    if (route.status === "skipped") {
      skipped.push({
        marketInstrumentId: instrument.id,
        symbol: instrument.symbol,
        reason: route.reason,
      })
      continue
    }
    if (!registry.has(route.providerId)) {
      // Routed, but no adapter is registered for it yet (e.g. `yahoo` in Slice A).
      skipped.push({
        marketInstrumentId: instrument.id,
        symbol: instrument.symbol,
        reason: `no adapter registered for "${route.providerId}"`,
      })
      continue
    }
    const bucket = groups.get(route.providerId)
    if (bucket) bucket.push(instrument)
    else groups.set(route.providerId, [instrument])
  }

  // 2. Ingest each group in isolation — one flaky source can never break another.
  const perProvider: ProviderIngestSummary[] = []
  let totalIngested = 0
  for (const [providerId, groupInstruments] of groups) {
    const factory = registry.get(providerId)
    if (!factory) continue // unreachable (has() guarded above) — defensive.
    try {
      const provider = factory()
      const summary = await ingestMarketDataOnce({
        provider,
        requests: groupInstruments.map(toInstrumentRequest),
        db,
      })
      const ingested = summary.status === "ok" ? summary.quotesUpserted : 0
      totalIngested += ingested
      perProvider.push({
        providerId,
        instrumentCount: groupInstruments.length,
        ingested,
        error: summary.status === "ok" ? undefined : summary.error,
      })
    } catch (error) {
      // A misconfigured/throwing adapter (e.g. unset secret) degrades to a
      // per-group error; the other groups above/below still run.
      perProvider.push({
        providerId,
        instrumentCount: groupInstruments.length,
        ingested: 0,
        error: error instanceof Error ? error.message : "provider failed",
      })
    }
  }

  return { perProvider, totalIngested, skipped }
}

/**
 * Load the instruments the router should price: those LINKED to at least one
 * holding (discovered cross-tenant via the `SECURITY DEFINER`
 * `market_instrument_ids_linked_to_holdings()` — see the migration; the global
 * ingest has no family scope, so it cannot read the RLS-forced holdings
 * `Instrument` table directly), plus any explicit baseline ids, de-duplicated.
 */
async function loadRoutableInstruments(
  db: MarketDataDb,
  baselineInstrumentIds: readonly string[]
): Promise<RoutableInstrument[]> {
  const linkedIdRows = await db.$queryRaw<{ id: string }[]>`
    SELECT ids::text AS id
    FROM market_instrument_ids_linked_to_holdings() AS ids
  `

  const ids = new Set<string>()
  for (const row of linkedIdRows) ids.add(row.id)
  for (const id of baselineInstrumentIds) ids.add(id)
  if (ids.size === 0) return []

  // MarketInstrument is a global, family-neutral table (no RLS), so this read is
  // safe outside any family scope.
  return await db.marketInstrument.findMany({
    where: { id: { in: [...ids] } },
    select: ROUTABLE_SELECT,
  })
}

/** Build the pipeline request for one instrument (fx pair vs spot instrument). */
function toInstrumentRequest(
  instrument: RoutableInstrument
): MarketInstrumentRequest {
  if (instrument.kind === "fx") {
    return {
      kind: "fx",
      baseCurrency: instrument.baseCurrency ?? "",
      quoteCurrency: instrument.quoteCurrency,
    }
  }
  // metal / security / crypto (validated: the caller only reaches here for a
  // routed, non-fx instrument; a bad kind would have been skipped by the router).
  const spotKind: Exclude<MarketInstrumentKind, "fx"> =
    isMarketInstrumentKind(instrument.kind) && instrument.kind !== "fx"
      ? instrument.kind
      : "security"
  return {
    kind: spotKind,
    symbol: instrument.symbol,
    quoteCurrency: instrument.quoteCurrency,
    mic: instrument.mic ?? undefined,
  }
}

// -----------------------------------------------------------------------------
// On-demand price sync trigger — the graceful boundary the UI/serverFn call
// (PER-235b), now backed by the router (PER-257). It ENSURES the BSI-gold
// instrument (so gold stays linkable + refreshes even before any holding links
// it — unchanged behaviour), then runs the Financial Ingestion Service over
// every linked instrument PLUS the gold baseline. Gold now flows THROUGH the
// registry instead of a hardcoded call. NEVER throws: a MISSING config
// (`LOGAM_MULIA_API_URL` unset → the gold factory throws inside its group), an
// unreachable worker, or a non-2xx / `success:false` payload all degrade to
// `{ ingested: 0, error }`, and the last-good quote is always kept. This performs
// a GLOBAL ingest only — the three global market tables, NEVER the ledger — so it
// runs OUTSIDE any family RLS transaction (the caller keeps the family-scoped
// holdings refresh separate).
// -----------------------------------------------------------------------------

export interface SyncMarketPricesResult {
  /** Canonical quotes written this run (0 on any failure). */
  ingested: number
  /** Present only when the sync degraded (unreachable / non-2xx / config unset). */
  error?: string
}

/**
 * Run one on-demand market-price sync through the ingestion router. NEVER throws:
 * an unreachable worker, a non-2xx / `success:false` payload, or an unset
 * `LOGAM_MULIA_API_URL` all resolve to `{ ingested: 0, error }`. The canonical
 * BSI-gold instrument is still ensured on every attempt (linkable before any
 * fetch succeeds), and the last good quote is left intact on failure.
 */
export async function syncMarketPricesOnce(
  options?: IngestGoldOptions
): Promise<SyncMarketPricesResult> {
  const db = options?.db ?? prisma
  try {
    // Keep gold linkable + baseline-priced even with zero linked holdings.
    const goldInstrumentId = await ensureBsiGoldInstrument(db)

    const summary = await ingestAllLinkedInstrumentsOnce({
      db,
      gold: {
        baseUrl: options?.baseUrl,
        fetchImpl: options?.fetchImpl,
        priceField: options?.priceField,
        now: options?.now,
      },
      baselineInstrumentIds: [goldInstrumentId],
    })

    if (summary.totalIngested > 0) {
      return { ingested: summary.totalIngested }
    }

    // Nothing ingested — surface the first degraded group's reason (if any) so
    // the caller/UI can explain the failure, mirroring the old contract.
    const failed = summary.perProvider.find((group) => group.error)
    if (failed?.error) return { ingested: 0, error: failed.error }
    return { ingested: 0 }
  } catch (error) {
    // Defense-in-depth: any unexpected throw degrades rather than 500-ing.
    return {
      ingested: 0,
      error: error instanceof Error ? error.message : "market sync failed",
    }
  }
}
