import { describe, expect, test } from "vite-plus/test"
import { FRANKFURTER_PROVIDER_ID, fxPairSymbol } from "@/lib/market-data"
import {
  FrankfurterFxProvider,
  isFrankfurterConfigured,
  planFxPairsForFamily,
  summarizeFxAutoIngest,
  type FxRefreshSummary,
} from "./fx-auto-ingest.server"
import { createDefaultProviderRegistry } from "./market-data.server"
import type { FetchLike } from "./market-data.server"

// =============================================================================
// PER-234 — unit tests for the Frankfurter (ECB) adapter + the PURE pair
// planning core. NO database, NO network: every fetch is an injected fixture
// returning a canned `Response`. (Discovery/propagation against real Postgres
// live in tests/integration/fx-auto-ingest.integration.ts.)
// =============================================================================

const BASE_URL = "https://frankfurter.test"

// The documented `GET /latest?from=USD&to=IDR,EUR` contract.
const USD_PAYLOAD = {
  amount: 1,
  base: "USD",
  date: "2026-10-09",
  rates: { IDR: 15_250.1234, EUR: 0.9123 },
}

function jsonFetch(payload: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = (url) => {
    urls.push(url)
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  }
  return { fetchImpl, urls }
}

function statusFetch(
  status: number,
  body = "boom"
): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = (url) => {
    urls.push(url)
    return Promise.resolve(new Response(body, { status }))
  }
  return { fetchImpl, urls }
}

/** A fetch that routes per base currency (two groups with different fates). */
function routingFetch(handler: (url: string) => Response | Promise<Response>): {
  fetchImpl: FetchLike
  urls: string[]
} {
  const urls: string[] = []
  const fetchImpl: FetchLike = (url) => {
    urls.push(url)
    return Promise.resolve(handler(url))
  }
  return { fetchImpl, urls }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("FrankfurterFxProvider (PER-234 / ADR-0050 slice 2)", () => {
  test("batches every pair of ONE base currency into a single request", async () => {
    const { fetchImpl, urls } = jsonFetch(USD_PAYLOAD)
    const provider = new FrankfurterFxProvider({
      baseUrl: BASE_URL,
      fetchImpl,
    })

    const result = await provider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
      { baseCurrency: "USD", quoteCurrency: "EUR" },
    ])

    expect(provider.name).toBe(FRANKFURTER_PROVIDER_ID)
    expect(urls).toEqual([`${BASE_URL}/latest?from=USD&to=IDR,EUR`])
    expect(result.status).toBe("ok")
    expect(result.observations).toHaveLength(2)
    expect(result.observations[0]).toMatchObject({
      kind: "fx",
      symbol: "USD/IDR",
      baseCurrency: "USD",
      quoteCurrency: "IDR",
      priceDecimal: "15250.1234",
      providerRef: "frankfurter",
    })
    // The effective date is the payload's ECB publication date, never "today".
    expect(result.observations[0]?.asOf.toISOString()).toBe(
      "2026-10-09T00:00:00.000Z"
    )
    expect(result.rawPayload).toMatchObject({
      byBase: { USD: USD_PAYLOAD },
      failures: [],
    })
  })

  test("one request per base currency — bases never share a URL", async () => {
    const { fetchImpl, urls } = routingFetch((url) =>
      url.includes("from=EUR")
        ? jsonResponse({
            amount: 1,
            base: "EUR",
            date: "2026-10-09",
            rates: { IDR: 17_000 },
          })
        : jsonResponse(USD_PAYLOAD)
    )
    const provider = new FrankfurterFxProvider({ baseUrl: BASE_URL, fetchImpl })

    const result = await provider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
      { baseCurrency: "EUR", quoteCurrency: "IDR" },
    ])

    expect(urls).toEqual([
      `${BASE_URL}/latest?from=USD&to=IDR`,
      `${BASE_URL}/latest?from=EUR&to=IDR`,
    ])
    expect(result.observations.map((o) => o.symbol)).toEqual([
      "USD/IDR",
      "EUR/IDR",
    ])
  })

  test("a failing base group degrades ONLY its own quotes", async () => {
    const { fetchImpl } = routingFetch((url) =>
      url.includes("from=JPY")
        ? jsonResponse({ error: "not found" }, 404)
        : jsonResponse(USD_PAYLOAD)
    )
    const provider = new FrankfurterFxProvider({ baseUrl: BASE_URL, fetchImpl })

    const result = await provider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
      { baseCurrency: "JPY", quoteCurrency: "IDR" },
    ])

    expect(result.status).toBe("ok")
    expect(result.observations.map((o) => o.symbol)).toEqual(["USD/IDR"])
    // The failure is still recorded (provenance / diagnosis), not swallowed.
    expect(result.rawPayload).toMatchObject({
      failures: ["JPY: frankfurter HTTP 404"],
    })
  })

  test("when EVERY base group fails the result is a graceful error (zero quotes)", async () => {
    const { fetchImpl } = statusFetch(500)
    const provider = new FrankfurterFxProvider({ baseUrl: BASE_URL, fetchImpl })

    const result = await provider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
      { baseCurrency: "JPY", quoteCurrency: "IDR" },
    ])

    expect(result.status).toBe("error")
    expect(result.httpStatus).toBe(500)
    expect(result.observations).toEqual([])
    expect(result.error).toContain("all FX base groups failed")
    expect(result.error).toContain("USD: frankfurter HTTP 500")
  })

  test("network errors and non-JSON bodies never throw", async () => {
    const throwing: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"))
    const provider = new FrankfurterFxProvider({
      baseUrl: BASE_URL,
      fetchImpl: throwing,
    })
    const networkFailure = await provider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
    ])
    expect(networkFailure.status).toBe("error")
    expect(networkFailure.error).toContain("ECONNREFUSED")

    const html: FetchLike = () =>
      Promise.resolve(
        new Response("<html>nope</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      )
    const htmlProvider = new FrankfurterFxProvider({
      baseUrl: BASE_URL,
      fetchImpl: html,
    })
    const notJson = await htmlProvider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
    ])
    expect(notJson.status).toBe("error")
    expect(notJson.error).toContain("non-JSON")
  })

  test("a structurally unusable payload degrades without a quote", async () => {
    // Missing `date` — an ECB-dated feed that cannot name its date must not
    // be ingested (it would misdate ADR-0035's step function).
    const { fetchImpl } = jsonFetch({
      amount: 1,
      base: "USD",
      rates: { IDR: 1 },
    })
    const provider = new FrankfurterFxProvider({ baseUrl: BASE_URL, fetchImpl })
    const result = await provider.fetchFxRates([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
    ])
    expect(result.status).toBe("error")
    expect(result.error).toContain("date")
    expect(result.observations).toEqual([])
  })

  test("spot requests are a no-op empty-ok, and mixed requests keep only fx", async () => {
    const { fetchImpl, urls } = jsonFetch(USD_PAYLOAD)
    const provider = new FrankfurterFxProvider({ baseUrl: BASE_URL, fetchImpl })

    // A metal/security request is not this adapter's concern: no fetch, no error.
    const spot = await provider.fetchSpot([
      { kind: "metal", symbol: "XAU-BSI", quoteCurrency: "IDR" },
    ])
    expect(spot).toMatchObject({ status: "ok", observations: [] })
    expect(urls).toEqual([])

    // A mixed router batch only ever sends the fx branch to Frankfurter.
    const mixed = await provider.fetchQuotes([
      { kind: "metal", symbol: "XAU-BSI", quoteCurrency: "IDR" },
      { kind: "fx", baseCurrency: "USD", quoteCurrency: "IDR" },
    ])
    expect(urls).toEqual([`${BASE_URL}/latest?from=USD&to=IDR`])
    expect(mixed.observations).toHaveLength(1)
  })

  test("no valid pairs means no request at all (never an empty upstream call)", async () => {
    const { fetchImpl, urls } = jsonFetch(USD_PAYLOAD)
    const provider = new FrankfurterFxProvider({ baseUrl: BASE_URL, fetchImpl })
    const result = await provider.fetchFxRates([
      // base === quote is not a pair — discovery never plans one, and a
      // hand-written request must not turn into a bogus upstream call.
      { baseCurrency: "USD", quoteCurrency: "USD" },
      { baseCurrency: "", quoteCurrency: "IDR" },
    ])
    expect(urls).toEqual([])
    expect(result).toMatchObject({ status: "ok", observations: [] })
  })

  test("configuration is read at CALL time and fails closed", () => {
    const previous = process.env.FRANKFURTER_API_URL
    try {
      delete process.env.FRANKFURTER_API_URL
      expect(isFrankfurterConfigured()).toBe(false)
      // Constructing without an explicit base URL and without the env var
      // fails loudly — never silently against a guessed public host.
      expect(() => new FrankfurterFxProvider()).toThrow(/FRANKFURTER_API_URL/)

      process.env.FRANKFURTER_API_URL = "https://api.frankfurter.app/"
      expect(isFrankfurterConfigured()).toBe(true)
      expect(() => new FrankfurterFxProvider()).not.toThrow()
      // An explicit (test) base URL wins over the environment.
      expect(isFrankfurterConfigured(BASE_URL)).toBe(true)
      // A non-http(s) value is rejected rather than fetched blindly.
      process.env.FRANKFURTER_API_URL = "file:///etc/passwd"
      expect(isFrankfurterConfigured()).toBe(true)
      expect(() => new FrankfurterFxProvider()).toThrow(/http\(s\)/)
    } finally {
      if (previous === undefined) delete process.env.FRANKFURTER_API_URL
      else process.env.FRANKFURTER_API_URL = previous
    }
  })
})

describe("planFxPairsForFamily — pure discovery planning (PER-234)", () => {
  test("maps real usage to (foreign -> base) pairs, excluding the base itself", () => {
    const plan = planFxPairsForFamily({
      baseCurrency: "IDR",
      usedCurrencies: ["IDR", "USD", "SGD"],
    })
    expect(plan.pairs).toEqual([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
      { baseCurrency: "SGD", quoteCurrency: "IDR" },
    ])
    expect(plan.skipped).toEqual([])
  })

  test("an unsupported currency is a structured skip, never a fetch", () => {
    const plan = planFxPairsForFamily({
      baseCurrency: "IDR",
      usedCurrencies: ["USD", "XAU", "BTC"],
    })
    expect(plan.pairs).toEqual([{ baseCurrency: "USD", quoteCurrency: "IDR" }])
    expect(plan.skipped.map((s) => s.currency)).toEqual(["XAU", "BTC"])
    // The reason names WHY — an operator reading the summary understands that
    // the ECB simply does not publish this pair.
    expect(plan.skipped[0]?.reason).toContain("ECB/Frankfurter")
  })

  test("FX_RATE_CURRENCIES extras are merged, de-duplicated, and validated", () => {
    const plan = planFxPairsForFamily({
      baseCurrency: "IDR",
      usedCurrencies: ["USD", "JPY"],
      extraCurrencies: ["USD", "MYR", "XAU", "", "idr"],
    })
    expect(plan.pairs).toEqual([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
      { baseCurrency: "JPY", quoteCurrency: "IDR" },
      { baseCurrency: "MYR", quoteCurrency: "IDR" },
    ])
    expect(plan.skipped.map((s) => s.currency)).toEqual(["XAU"])
  })

  test("a base currency that is itself foreign still plans its cross rates", () => {
    // Two families with different bases both need their own direction.
    const idrFamily = planFxPairsForFamily({
      baseCurrency: "IDR",
      usedCurrencies: ["USD"],
    })
    const usdFamily = planFxPairsForFamily({
      baseCurrency: "USD",
      usedCurrencies: ["IDR"],
    })
    expect(idrFamily.pairs).toEqual([
      { baseCurrency: "USD", quoteCurrency: "IDR" },
    ])
    expect(usdFamily.pairs).toEqual([
      { baseCurrency: "IDR", quoteCurrency: "USD" },
    ])
    expect(fxPairSymbol("IDR", "USD")).toBe("IDR/USD")
  })
})

describe("summarizeFxAutoIngest — the scheduler-facing summary (PER-234)", () => {
  const emptyPropagation = {
    snapshotsUpserted: 0,
    snapshotsUnchanged: 0,
    snapshotsPreservedManual: 0,
    pairsWithoutRate: 0,
    familiesProcessed: 0,
    familiesFailed: 0,
    errors: [],
  }

  test("an unconfigured feed is disabled — informative, never degraded", () => {
    const summary = summarizeFxAutoIngest({
      status: "disabled",
      reason: "FRANKFURTER_API_URL is not set",
    })
    expect(summary.enabled).toBe(false)
    expect(summary.disabledReason).toContain("FRANKFURTER_API_URL")
    // `error` is what flips the refresh's `degraded` flag: a deliberately
    // unconfigured FX feed must not alarm on every tick.
    expect(summary.error).toBeUndefined()
    expect(summary.pairsDiscovered).toBe(0)
  })

  test("a ready plan folds discovery + propagation counts together", () => {
    const summary = summarizeFxAutoIngest(
      {
        status: "ready",
        discovery: {
          pairs: [{ baseCurrency: "USD", quoteCurrency: "IDR" }],
          families: [
            {
              familyId: "f1",
              familyName: "Family",
              actorUserId: "u1",
              baseCurrency: "IDR",
              pairs: [{ baseCurrency: "USD", quoteCurrency: "IDR" }],
            },
          ],
          skipped: [{ currency: "XAU", reason: "not published" }],
        },
        instrumentsEnsured: 1,
      },
      { ...emptyPropagation, snapshotsUpserted: 1 }
    )
    expect(summary.enabled).toBe(true)
    expect(summary.error).toBeUndefined()
    expect(summary).toMatchObject({
      pairsDiscovered: 1,
      instrumentsEnsured: 1,
      familiesDiscovered: 1,
      snapshotsUpserted: 1,
      pairsWithoutRate: 0,
      familiesFailed: 0,
    })
    expect(summary.skipped).toHaveLength(1)
  })

  test("a failed discovery or a failed family surfaces as `error` (degraded)", () => {
    const failedPrepare = summarizeFxAutoIngest({
      status: "failed",
      error: 'relation "Family" does not exist',
    })
    expect(failedPrepare.enabled).toBe(true)
    expect(failedPrepare.error).toContain('relation "Family"')

    const failedFamily = summarizeFxAutoIngest(
      {
        status: "ready",
        discovery: { pairs: [], families: [], skipped: [] },
        instrumentsEnsured: 0,
      },
      { ...emptyPropagation, familiesFailed: 1, errors: ["Family: boom"] }
    )
    expect(failedFamily.error).toBe("Family: boom")
    expect(failedFamily.familiesFailed).toBe(1)
  })

  test("a propagation result of all-unchanged counts as success, not an error", () => {
    const summary: FxRefreshSummary = summarizeFxAutoIngest(
      {
        status: "ready",
        discovery: { pairs: [], families: [], skipped: [] },
        instrumentsEnsured: 0,
      },
      { ...emptyPropagation, snapshotsUnchanged: 3 }
    )
    expect(summary.error).toBeUndefined()
    expect(summary.snapshotsUnchanged).toBe(3)
  })
})

describe("createDefaultProviderRegistry — the FX adapter is opt-in (PER-234)", () => {
  test("frankfurter joins the router only when a feed is configured", () => {
    const previous = process.env.FRANKFURTER_API_URL
    try {
      delete process.env.FRANKFURTER_API_URL
      // Unconfigured: fx instruments route to an UNREGISTERED id, which the
      // router turns into a quiet structured skip — not a degraded group on
      // every tick of an install that never opted in.
      expect(createDefaultProviderRegistry().has(FRANKFURTER_PROVIDER_ID)).toBe(
        false
      )
      expect(
        createDefaultProviderRegistry({
          fx: { baseUrl: BASE_URL },
        }).has(FRANKFURTER_PROVIDER_ID)
      ).toBe(true)

      process.env.FRANKFURTER_API_URL = "https://api.frankfurter.app"
      expect(createDefaultProviderRegistry().has(FRANKFURTER_PROVIDER_ID)).toBe(
        true
      )

      // The existing feeds are unaffected — always registered, still lazy.
      const registry = createDefaultProviderRegistry()
      expect(registry.has("logam_mulia")).toBe(true)
      expect(registry.has("reksadana_id")).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.FRANKFURTER_API_URL
      else process.env.FRANKFURTER_API_URL = previous
    }
  })
})
