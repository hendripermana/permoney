/**
 * reksadana-nav — Cloudflare Worker entry (the thin IO SHELL).
 * =============================================================================
 *
 * ADR-0053. All the fragile logic (per-source normalization, fallback ordering,
 * the weekend rule, the target contract) lives in the PURE, CF-free `normalize.ts`
 * — unit-tested with `vp test`. This file only does what a shell must: parse the
 * request, fetch each upstream (browser-like headers), read/write the D1 stale
 * cache, and serialize the ADR-0053 §2 payload. It NEVER 500s on an upstream
 * outage — it degrades to the stale cache, then to a structured error.
 *
 * Routes:
 *   GET /nav?fund=<code>                         → latest quote (+ short tail)
 *   GET /nav/history?fund=<code>&from=YYYY-MM-DD  → dated series for a backfill
 *
 * Bindings (wrangler.jsonc):
 *   NAV_CACHE (D1)          — last-known-good payload per fund (LKGP).
 *   Vars/secrets (optional) — BAREKSA_JSON_URL, BAREKSA_HTML_URL templates with
 *     `{fund}` / `{from}` placeholders. Defaults target Bareksa; CONFIRM + adjust
 *     against the live upstream on first deploy (see README — the exact public
 *     JSON endpoint must be recorded during deploy; the primary may be token-gated,
 *     in which case the HTML fallback + LKGP carry the worker).
 */

import {
  buildPayload,
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
  /** Primary clean-JSON URL template (`{fund}`). */
  BAREKSA_JSON_URL?: string
  /** Fallback product-page URL template (`{fund}`). */
  BAREKSA_HTML_URL?: string
}

const DEFAULT_JSON_URL =
  "https://api.bareksa.com/v22/products/mutualfund/{fund}/nav"
const DEFAULT_HTML_URL = "https://www.bareksa.com/reksadana/{fund}"

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  referer: "https://www.bareksa.com/",
}

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

/** Fetch the primary clean-JSON source; null on any non-2xx / non-JSON / drift. */
async function fetchBareksaJson(
  env: Env,
  fund: string
): Promise<{ series: NormalizedSeries | null; error?: string }> {
  const url = fillTemplate(env.BAREKSA_JSON_URL ?? DEFAULT_JSON_URL, fund)
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS })
    if (!res.ok) return { series: null, error: `json HTTP ${res.status}` }
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("json")) {
      return { series: null, error: "json endpoint returned non-JSON" }
    }
    const body = await res.json()
    return { series: normalizeBareksaJson(body) }
  } catch (error) {
    return {
      series: null,
      error: error instanceof Error ? error.message : "fetch failed",
    }
  }
}

/** Fetch the product-page HTML and scrape its embedded __NEXT_DATA__. */
async function fetchBareksaHtml(
  env: Env,
  fund: string
): Promise<{ series: NormalizedSeries | null; error?: string }> {
  const url = fillTemplate(env.BAREKSA_HTML_URL ?? DEFAULT_HTML_URL, fund)
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS })
    if (!res.ok) return { series: null, error: `html HTTP ${res.status}` }
    const html = await res.text()
    return { series: normalizeBareksaHtml(html) }
  } catch (error) {
    return {
      series: null,
      error: error instanceof Error ? error.message : "fetch failed",
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
  const [json_, html, stale] = await Promise.all([
    fetchBareksaJson(env, fund),
    fetchBareksaHtml(env, fund),
    readStaleCache(env, fund),
  ])

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
    if (!fund) return json({ error: "missing ?fund=<code>" }, 400)

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
