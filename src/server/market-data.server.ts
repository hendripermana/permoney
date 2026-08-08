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
  BSI_GOLD_SOURCE,
  BSI_GOLD_SYMBOL,
  normalizeObservations,
  parseLogamMuliaGoldResponse,
  type GoldPriceField,
  type MarketInstrumentIdentity,
  type MarketInstrumentKind,
  type MarketObservation,
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
  "marketInstrument" | "marketQuote" | "rawMarketDataFetch" | "$transaction"
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
// The ONLY code that knows the gold vendor exists. It fetches the worker's
// `GET {base}/api/prices/bankbsi` endpoint, stages the raw JSON verbatim, and
// hands the pure parser (`parseLogamMuliaGoldResponse`, @/lib/market-data) a
// single per-troy-ounce metal observation. Secrets/config (`LOGAM_MULIA_API_URL`)
// are read ONLY here, at CALL time (never module scope). Graceful degradation is
// total: a worker outage, a non-2xx status, non-JSON, `success:false`, or a
// malformed shape all return `status:"error"` with the raw payload captured —
// never a throw, never a bad quote (ADR-0050 §4).

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
  readonly name = BSI_GOLD_SOURCE
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly priceField: GoldPriceField | undefined
  private readonly now: () => Date

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

  private async fetchGold(): Promise<MarketFetchResult> {
    const url = `${this.baseUrl}/api/prices/bankbsi`

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
  db: MarketDataDb = prisma
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
