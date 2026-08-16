/**
 * reksadana-nav — Cloudflare Worker entry (the thin IO SHELL).
 * =============================================================================
 *
 * ADR-0053. All the fragile logic (per-source normalization, the token-bootstrap
 * string parsing, fallback ordering, the weekend rule, the target contract) lives
 * in the PURE, CF-free `normalize.ts` — unit-tested with `vp test`. This file only
 * does what a shell must: parse the request, run the two-step Bareksa bootstrap
 * (product page → `ba_session` + `x-ajax-token` → ajax NAV), scrape the HTML as a
 * fallback, read/write the D1 stale cache, and serialize the ADR-0053 §2 payload.
 * It NEVER 500s on an upstream outage — it degrades to the stale cache, then to a
 * structured error.
 *
 * THE REAL BAREKSA UPSTREAM (verified by live probe — PER-258)
 * -----------------------------------------------------------
 *   1. GET https://www.bareksa.com/id/data/reksadana/<PID>/  (browser-like UA)
 *        → 302 to the canonical product page; response sets `Set-Cookie:
 *          ba_session=…` (+ `clang=id`), and the HTML embeds, inline,
 *          `$.ajaxSetup({ headers: { "X-Ajax-Token": '…' } })`.
 *   2. GET https://www.bareksa.com/ajax/mutualfund/nav/product1/?id=<PID>&cperiod=…
 *        with `x-ajax-token`, `x-requested-with: XMLHttpRequest`,
 *        `cookie: ba_session=…; clang=id`, and a product-page `referer`.
 *        → CLEAN JSON: `{ status, data: { unitY, datas:[{ nav:[{date,value}] }] } }`.
 *
 * The worker's `fund` query param IS the Bareksa numeric product id (`<PID>`);
 * Permoney sets a reksadana instrument's `symbol` to that pid.
 *
 * Routes:
 *   GET /nav?fund=<PID>                          → latest quote (+ short tail)
 *   GET /nav/history?fund=<PID>&from=YYYY-MM-DD   → dated series for a backfill
 *
 * Bindings (wrangler.jsonc):
 *   NAV_CACHE (D1)          — last-known-good payload per fund (LKGP).
 *   Vars/secrets (optional) — BAREKSA_PRODUCT_URL (a `{fund}` product-page
 *     template) + BAREKSA_AJAX_BASE (the ajax endpoint base). Defaults target the
 *     verified Bareksa endpoints.
 */

import {
  buildPayload,
  extractAjaxToken,
  extractCookie,
  normalizeBareksaHtml,
  normalizeBareksaJson,
  normalizeStaleCache,
  resolveSeries,
  type NavPayload,
  type NormalizedSeries,
  type SourceAttempt,
} from "./normalize"

export interface Env {
  /** D1 database holding the per-fund last-known-good payload (LKGP). */
  NAV_CACHE: D1Database
  /** Product-page URL template (`{fund}` = the Bareksa numeric pid). */
  BAREKSA_PRODUCT_URL?: string
  /** Ajax NAV endpoint base (query is built by the worker). */
  BAREKSA_AJAX_BASE?: string
}

const DEFAULT_PRODUCT_URL = "https://www.bareksa.com/id/data/reksadana/{fund}/"
const DEFAULT_AJAX_BASE =
  "https://www.bareksa.com/ajax/mutualfund/nav/product1/"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function fillTemplate(template: string, fund: string): string {
  return template.replaceAll("{fund}", encodeURIComponent(fund))
}

/** Join a response's Set-Cookie header(s) into one string `extractCookie` reads. */
function readSetCookie(response: Response): string | null {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === "function") {
    const all = headers.getSetCookie()
    if (all.length > 0) return all.join("\n")
  }
  return response.headers.get("set-cookie")
}

interface ProductPage {
  html: string | null
  cookie: string | null
  token: string | null
  error?: string
}

/**
 * Step 1 of the bootstrap: fetch the product page (following its 302) to obtain a
 * fresh `ba_session` cookie AND the `x-ajax-token` embedded in the HTML. The HTML
 * is also returned so the fallback scraper can reuse it without a second fetch.
 */
async function fetchProductPage(env: Env, fund: string): Promise<ProductPage> {
  const url = fillTemplate(env.BAREKSA_PRODUCT_URL ?? DEFAULT_PRODUCT_URL, fund)
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "id,en;q=0.9",
      },
      redirect: "follow",
    })
    const cookie = extractCookie(readSetCookie(res))
    const html = res.ok ? await res.text() : null
    return {
      html,
      cookie,
      token: extractAjaxToken(html),
      error: res.ok ? undefined : `product page HTTP ${res.status}`,
    }
  } catch (error) {
    return {
      html: null,
      cookie: null,
      token: null,
      error: error instanceof Error ? error.message : "product fetch failed",
    }
  }
}

/**
 * Build the ajax NAV URL for a mode (`1m` window for latest; `5y` for history).
 *
 * Use a `cperiod` PRESET with empty startdate/enddate — the exact shape the live
 * capture proved works. `buildPayload` filters history to `from` client-side, so
 * the upstream only needs to return enough trailing history; it does not need the
 * date range. (An earlier `cperiod=all` + startdate/enddate made Bareksa reject
 * the request, degrading `/nav/history` to the stale cache.)
 */
function buildAjaxUrl(
  base: string,
  fund: string,
  mode: "latest" | "history"
): string {
  const params = new URLSearchParams()
  params.set("id", fund)
  params.set("requested_page", "profile.graph")
  // `1y` is the exact window the live capture proved works for an anonymous
  // session; longer windows (`5y`/`all`) appear gated behind a Bareksa login and
  // fail for the anonymous bootstrap, degrading history to the stale cache. One
  // year is ample for a holding's NAV-value backfill (cost basis is user-entered).
  params.set("cperiod", mode === "history" ? "1y" : "1m")
  return `${base}?${params.toString()}`
}

/**
 * Step 2 of the bootstrap: call the ajax NAV endpoint with the bootstrapped token
 * + cookie + referer. Returns null (never throws) when the token/cookie is absent,
 * the request is non-2xx / non-JSON, or the envelope reports a failed attempt — so
 * the chain falls through to the HTML scrape, then D1 LKGP.
 */
async function fetchBareksaJson(
  env: Env,
  fund: string,
  page: ProductPage,
  mode: "latest" | "history"
): Promise<{ series: NormalizedSeries | null; error?: string }> {
  if (!page.token || !page.cookie) {
    return { series: null, error: page.error ?? "ajax token bootstrap failed" }
  }
  const base = env.BAREKSA_AJAX_BASE ?? DEFAULT_AJAX_BASE
  const url = buildAjaxUrl(base, fund, mode)
  const referer = fillTemplate(
    env.BAREKSA_PRODUCT_URL ?? DEFAULT_PRODUCT_URL,
    fund
  )
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-ajax-token": page.token,
        "x-requested-with": "XMLHttpRequest",
        cookie: `ba_session=${page.cookie}; clang=id`,
        referer,
      },
    })
    if (!res.ok) return { series: null, error: `ajax HTTP ${res.status}` }
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("json") && !contentType.includes("javascript")) {
      const body = await res.json().catch(() => null)
      return { series: normalizeBareksaJson(body) }
    }
    const body = await res.json()
    return { series: normalizeBareksaJson(body) }
  } catch (error) {
    return {
      series: null,
      error: error instanceof Error ? error.message : "ajax fetch failed",
    }
  }
}

/** Read the last-known-good payload for a fund from D1 (LKGP). */
async function readStaleCache(
  env: Env,
  fund: string
): Promise<{ series: NormalizedSeries | null; error?: string }> {
  try {
    const row = await env.NAV_CACHE.prepare(
      "SELECT payload FROM nav_cache WHERE fund = ?"
    )
      .bind(fund)
      .first<{ payload: string }>()
    if (!row?.payload) return { series: null, error: "cache empty" }
    return { series: normalizeStaleCache(JSON.parse(row.payload)) }
  } catch (error) {
    return {
      series: null,
      error: error instanceof Error ? error.message : "cache read failed",
    }
  }
}

/** Persist the freshest successful payload as the new LKGP (best-effort). */
async function writeStaleCache(
  env: Env,
  fund: string,
  payload: NavPayload
): Promise<void> {
  try {
    await env.NAV_CACHE.prepare(
      `INSERT INTO nav_cache (fund, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(fund) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    )
      .bind(fund, JSON.stringify(payload), new Date().toISOString())
      .run()
  } catch {
    // Cache write failures never affect the response — LKGP is best-effort.
  }
}

async function handleNav(
  env: Env,
  fund: string,
  mode: "latest" | "history",
  from: string | undefined
): Promise<Response> {
  // One product-page fetch powers BOTH the token-gated ajax primary and the HTML
  // scrape fallback (no double fetch).
  const page = await fetchProductPage(env, fund)
  const [json_, stale] = await Promise.all([
    fetchBareksaJson(env, fund, page, mode),
    readStaleCache(env, fund),
  ])
  const html: { series: NormalizedSeries | null; error?: string } = {
    series: normalizeBareksaHtml(page.html),
    error: page.html ? "no NAV in product HTML" : page.error,
  }

  const attempts: SourceAttempt[] = [
    { source: "bareksa_json", series: json_.series, error: json_.error },
    { source: "bareksa_html", series: html.series, error: html.error },
    { source: "stale_cache", series: stale.series, error: stale.error },
  ]

  const resolution = resolveSeries(attempts)
  if (resolution.status === "error") {
    return json(
      {
        error: "all reksadana sources failed",
        fund,
        failures: resolution.failures,
      },
      502
    )
  }

  const payload = buildPayload(fund, resolution, { mode, from })

  // Refresh the LKGP only from a LIVE source (never re-persist stale over itself).
  if (resolution.source !== "stale_cache") {
    await writeStaleCache(env, fund, payload)
  }

  return json(payload)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405)
    }
    const fund = url.searchParams.get("fund")?.trim()
    if (!fund) return json({ error: "missing ?fund=<pid>" }, 400)

    if (url.pathname === "/nav") {
      return handleNav(env, fund, "latest", undefined)
    }
    if (url.pathname === "/nav/history") {
      const from = url.searchParams.get("from")?.trim() || undefined
      return handleNav(env, fund, "history", from)
    }
    return json({ error: "not found" }, 404)
  },
} satisfies ExportedHandler<Env>
