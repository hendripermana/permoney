/**
 * Reksadana NAV — PURE normalization + source-selection core (ADR-0053).
 * =============================================================================
 *
 * This module is the FRAGILE part the ADR singles out for review + unit tests,
 * and it is deliberately factored to contain ZERO Cloudflare-runtime dependencies
 * (no `fetch`, no D1, no `Request`/`Response`). The worker entry (`index.ts`) is a
 * thin shell that does the IO (the two-step Bareksa token bootstrap, the ajax NAV
 * fetch, read/write D1) and hands the raw bytes to the pure functions here;
 * `vp test` unit-tests this module directly against recorded fixtures with no live
 * network.
 *
 * THE REAL BAREKSA UPSTREAM (verified by live probe, ADR-0053 §Context/§1)
 * -----------------------------------------------------------------------
 * Bareksa's NAV lives behind an ajax endpoint gated by an anti-CSRF token +
 * session cookie that are BOOTSTRAPPED from the product page:
 *
 *   1. GET https://www.bareksa.com/id/data/reksadana/<PID>/  (browser-like)
 *        → 302 to the canonical product page; the response sets
 *          `Set-Cookie: ba_session=…` (+ `clang=id`) and the HTML embeds, in an
 *          inline `<script>`, `$.ajaxSetup({ headers: { "X-Ajax-Token": '…' } })`.
 *   2. GET https://www.bareksa.com/ajax/mutualfund/nav/product1/?id=<PID>&…
 *        with `x-ajax-token`, `x-requested-with: XMLHttpRequest`,
 *        `cookie: ba_session=…; clang=id`, and a `referer` of the product page.
 *        → CLEAN JSON (no AES), the `{ status, data: { unitY, datas:[{pid,pname,
 *          nav:[{date,value}] }] } }` envelope `normalizeBareksaJson` parses.
 *
 * Responsibilities:
 *   1. Per-source NORMALIZERS — turn each upstream's raw shape into the internal
 *      `NormalizedSeries` (`{ currency, points: [{date, nav}] }`):
 *        - `normalizeBareksaJson`  — the real Bareksa ajax NAV envelope (primary).
 *        - `normalizeBareksaHtml`  — a best-effort scrape of any NAV JSON embedded
 *          in the product-page HTML (fallback when the token bootstrap fails).
 *        - `normalizeStaleCache`   — a previously-served payload from D1 (LKGP);
 *          this is the worker's OWN `{ currency, quotes, latest }` contract shape.
 *      Each is SHAPE-TOLERANT (probes known keys, then a bounded deep search) so a
 *      minor upstream drift degrades to the next source rather than crashing.
 *   2. TOKEN BOOTSTRAP PARSERS — `extractAjaxToken` (pull the `X-Ajax-Token` out of
 *      the product-page HTML) and `extractCookie` (pull `ba_session` out of a
 *      `Set-Cookie` header). Pure string parsing, unit-tested against a fixture.
 *   3. FALLBACK ORDERING — `resolveSeries` tries attempts in priority order and
 *      returns the FIRST that yields a usable series, recording the degradation.
 *   4. The ADR-0053 §2 target CONTRACT — `buildPayload` emits
 *      `{ fundCode, currency, latest, quotes, stale }` for both `/nav` (latest)
 *      and `/nav/history` (backfill) modes.
 *
 * WEEKEND / MARKET-HOLIDAY INVARIANT (ADR-0053 §3): KSEI/IDX publish no new NAV on
 * Sat–Sun/holidays; Bareksa's `nav[]` is TRADING-DAYS-ONLY (weekend/holiday rows
 * are simply absent), so on a weekend the LAST element already carries Friday's
 * value — the invariant holds by construction, no flat-fill. Nothing here treats a
 * flat/repeated (or absent-today) NAV as an error — `latest` is always the freshest
 * AVAILABLE point.
 */

/** The upstream sources, in the ADR-0053 §1 priority order. */
export type SourceKind = "bareksa_json" | "bareksa_html" | "stale_cache"

/** One dated NAV point (`nav` per unit, in `currency`). */
export interface NavPoint {
  date: string
  nav: number
}

/** A source's raw shape reduced to the internal per-fund series. */
export interface NormalizedSeries {
  currency: string
  points: NavPoint[]
}

/** The ADR-0053 §2 worker payload — the ONE shape every route emits. */
export interface NavPayload {
  fundCode: string
  currency: string
  latest: { nav: number; asOf: string } | null
  quotes: NavPoint[]
  /** True when served from the D1 stale cache (LKGP) — informational. */
  stale?: boolean
}

/** Default quote currency for Indonesian reksadana. */
export const DEFAULT_CURRENCY = "IDR"

/** How many trailing points `/nav` includes alongside `latest` for context. */
export const LATEST_TAIL = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** A `YYYY-MM-DD` normalization of a date-ish value, or null. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch — accept ms (13-digit) and s (10-digit).
    const ms = value > 1e11 ? value : value * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** A positive finite NAV number from a number-or-numeric-string, or null. */
export function normalizeNav(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

const DATE_KEYS = [
  "date",
  "navDate",
  "nav_date",
  "recordedDate",
  "asOf",
  "as_of",
  "tanggal",
  "x",
] as const
const NAV_KEYS = [
  "value",
  "nav",
  "navPerUnit",
  "nav_per_unit",
  "price",
  "nilai",
  "y",
] as const

/** Extract a `{date, nav}` from a row-like object, probing known keys. */
function pointFromRow(row: Record<string, unknown>): NavPoint | null {
  let date: string | null = null
  for (const key of DATE_KEYS) {
    if (key in row) {
      date = normalizeDate(row[key])
      if (date !== null) break
    }
  }
  let nav: number | null = null
  for (const key of NAV_KEYS) {
    if (key in row) {
      nav = normalizeNav(row[key])
      if (nav !== null) break
    }
  }
  if (date === null || nav === null) return null
  return { date, nav }
}

/** An array is a NAV series when a majority of its rows parse to a NavPoint. */
function arrayToPoints(value: unknown): NavPoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const points: NavPoint[] = []
  for (const row of value) {
    if (!isRecord(row)) continue
    const point = pointFromRow(row)
    if (point) points.push(point)
  }
  if (points.length === 0) return null
  // Guard against false positives: require most rows to have been NAV-shaped.
  if (points.length * 2 < value.length) return null
  return points
}

/**
 * Bounded recursive search for the LONGEST NAV-point array anywhere in the object
 * graph. The last-resort tolerance so a nested/renamed container still normalizes;
 * `depth` caps the walk so a pathological payload can never spin.
 */
function deepFindLongestSeries(node: unknown, depth = 0): NavPoint[] | null {
  if (depth > 8 || node === null || typeof node !== "object") return null
  const direct = arrayToPoints(node)
  if (direct) return direct
  let best: NavPoint[] | null = null
  const children = Array.isArray(node) ? node : Object.values(node)
  for (const child of children) {
    const found = deepFindLongestSeries(child, depth + 1)
    if (found && (!best || found.length > best.length)) best = found
  }
  return best
}

/** Find a currency string anywhere shallow in the object, else the default. */
function findCurrency(node: unknown, depth = 0): string {
  if (depth > 4 || !isRecord(node)) return DEFAULT_CURRENCY
  for (const key of ["unitY", "currency", "ccy", "curr"]) {
    const value = node[key]
    if (typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim())) {
      return value.trim().toUpperCase()
    }
  }
  for (const child of Object.values(node)) {
    if (isRecord(child)) {
      const found = findCurrency(child, depth + 1)
      if (found !== DEFAULT_CURRENCY) return found
    }
  }
  return DEFAULT_CURRENCY
}

/** Dedupe by date (last wins) and sort ascending — the canonical series order. */
export function cleanSeries(points: readonly NavPoint[]): NavPoint[] {
  const byDate = new Map<string, NavPoint>()
  for (const point of points) byDate.set(point.date, point)
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/**
 * Normalize the REAL Bareksa ajax NAV envelope into a series (ADR-0053 §1). The
 * verified shape is:
 *
 *   { status: true,
 *     data: { auth: true, unitY: "IDR",
 *             datas: [ { pid: "3035", pname: "…",
 *                        nav: [ { id, date: "YYYY-MM-DD", value: "1485.7881" } ] } ] } }
 *
 * `status: false` (or `data.auth: false`) is a FAILED attempt (unauthenticated /
 * token rejected) → returns null so the chain falls through to the HTML scrape,
 * then D1 LKGP. When the strict `data.datas[0].nav` path is absent (a minor
 * upstream drift) a bounded deep search still salvages the longest NAV array.
 * Returns null when nothing NAV-shaped is found.
 */
export function normalizeBareksaJson(raw: unknown): NormalizedSeries | null {
  if (!isRecord(raw)) return null

  // A failed ajax attempt must fall through, never be deep-searched for a hit.
  if (raw.status === false) return null
  const data = isRecord(raw.data) ? raw.data : null
  if (data && data.auth === false) return null

  let currency = DEFAULT_CURRENCY
  let points: NavPoint[] | null = null

  if (data) {
    if (
      typeof data.unitY === "string" &&
      /^[A-Za-z]{3}$/.test(data.unitY.trim())
    ) {
      currency = data.unitY.trim().toUpperCase()
    }
    const datas = data.datas
    if (Array.isArray(datas) && datas.length > 0 && isRecord(datas[0])) {
      points = arrayToPoints(datas[0].nav)
    }
  }

  // Tolerance: a nested / renamed container still normalizes via deep search.
  if (!points) {
    points = deepFindLongestSeries(raw)
    if (points && currency === DEFAULT_CURRENCY) currency = findCurrency(raw)
  }

  if (!points || points.length === 0) return null
  return { currency, points: cleanSeries(points) }
}

/**
 * Fallback scraper: when the token bootstrap fails, salvage any NAV JSON embedded
 * in the product-page HTML. Bareksa loads its chart via ajax, so this is a
 * best-effort net (it returns null on a page with no inline series) — the real
 * safety after it is the D1 LKGP. Scans embedded JSON blobs (a `<script
 * type="application/json">` payload or a legacy `__NEXT_DATA__` blob) and reuses
 * the JSON normalizer's deep search. Returns null when no parseable NAV is found.
 */
export function normalizeBareksaHtml(html: unknown): NormalizedSeries | null {
  if (typeof html !== "string" || html.length === 0) return null
  for (const blob of embeddedJsonBlobs(html)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(blob)
    } catch {
      continue
    }
    const series = normalizeBareksaJson(parsed)
    if (series) return series
    // The blob may not be the ajax envelope (no `datas`); deep-search it directly.
    const points = deepFindLongestSeries(parsed)
    if (points && points.length > 0) {
      return { currency: findCurrency(parsed), points: cleanSeries(points) }
    }
  }
  return null
}

/** All `<script>`-embedded JSON blobs worth probing for NAV data. */
function embeddedJsonBlobs(html: string): string[] {
  const blobs: string[] = []
  const scriptRe =
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = scriptRe.exec(html)) !== null) {
    if (match[1]) blobs.push(match[1].trim())
  }
  const nextData = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  )
  if (nextData?.[1]) blobs.push(nextData[1].trim())
  return blobs
}

/**
 * Normalize a payload previously served by THIS worker and cached in D1 (LKGP).
 * The cached value is the worker's OWN ADR-0053 §2 contract (`{ currency,
 * quotes:[{date,nav}], latest:{nav,asOf} }`), NOT a raw Bareksa envelope — so this
 * reads that shape directly (with a bounded deep-search tolerance). Returns null
 * when no usable point survives.
 */
export function normalizeStaleCache(raw: unknown): NormalizedSeries | null {
  if (!isRecord(raw)) return null

  let currency = DEFAULT_CURRENCY
  if (
    typeof raw.currency === "string" &&
    /^[A-Za-z]{3}$/.test(raw.currency.trim())
  ) {
    currency = raw.currency.trim().toUpperCase()
  }

  const collected: NavPoint[] = []
  const quotes = arrayToPoints(raw.quotes)
  if (quotes) collected.push(...quotes)
  if (isRecord(raw.latest)) {
    const latest = pointFromRow(raw.latest)
    if (latest) collected.push(latest)
  }

  // Tolerance: a differently-shaped cached blob still salvages via deep search.
  if (collected.length === 0) {
    const deep = deepFindLongestSeries(raw)
    if (deep) collected.push(...deep)
  }

  if (collected.length === 0) return null
  if (currency === DEFAULT_CURRENCY) currency = findCurrency(raw)
  return { currency, points: cleanSeries(collected) }
}

// =============================================================================
// Token bootstrap parsers (pure) — the fragile string extraction the shell needs
// =============================================================================

/**
 * Extract the anti-CSRF `X-Ajax-Token` from the Bareksa product-page HTML. The
 * verified embedding is an inline script:
 *
 *   $.ajaxSetup({ headers: { "X-Ajax-Token": '<token>' } });
 *
 * We probe that exact shape first, then a couple of tolerant fallbacks (a bare
 * `x-ajax-token` / `ajaxToken` assignment, a `<meta>` tag) so a minor markup drift
 * still bootstraps. Returns null when no token is present (→ the shell falls
 * through to the HTML scrape, then D1 LKGP).
 */
export function extractAjaxToken(html: unknown): string | null {
  if (typeof html !== "string" || html.length === 0) return null
  const patterns: RegExp[] = [
    /["']X-Ajax-Token["']\s*:\s*["']([^"']+)["']/i,
    /["']?x[-_]ajax[-_]token["']?\s*[:=]\s*["']([^"']+)["']/i,
    /ajaxToken\s*[:=]\s*["']([^"']+)["']/i,
    /<meta[^>]+name=["']x?[-_]?ajax[-_]token["'][^>]+content=["']([^"']+)["']/i,
  ]
  for (const re of patterns) {
    const match = html.match(re)
    if (match?.[1] && match[1].trim().length > 0) return match[1].trim()
  }
  return null
}

/**
 * Extract a named cookie value (default `ba_session`) from a `Set-Cookie` header
 * string. Cloudflare's `Headers.getSetCookie()` yields multiple values; join them
 * with newlines (or commas) before calling this. Returns the LAST occurrence (the
 * freshest issued value) or null.
 */
export function extractCookie(
  setCookie: string | null | undefined,
  name = "ba_session"
): string | null {
  if (typeof setCookie !== "string" || setCookie.length === 0) return null
  const re = new RegExp(`(?:^|[,;\\n]\\s*)${name}=([^;,\\s]+)`, "gi")
  let value: string | null = null
  let match: RegExpExecArray | null
  while ((match = re.exec(setCookie)) !== null) {
    if (match[1] && match[1].length > 0) value = match[1]
  }
  return value
}

/**
 * Convert a `YYYY-MM-DD` (or ISO) date into the `DD-MM-YYYY` form Bareksa's ajax
 * `startdate`/`enddate` params expect. Returns null on an unparseable input.
 */
export function toBareksaDate(value: unknown): string | null {
  const iso = normalizeDate(value)
  if (iso === null) return null
  const [year, month, day] = iso.split("-")
  return `${day}-${month}-${year}`
}

/** One source attempt handed to `resolveSeries`, in priority order. */
export interface SourceAttempt {
  source: SourceKind
  series: NormalizedSeries | null
  /** Optional reason the attempt yielded no series (recorded for observability). */
  error?: string
}

export interface ResolvedSeries {
  status: "ok"
  source: SourceKind
  series: NormalizedSeries
  /** Sources tried before the winner (each failed). */
  degradedFrom: SourceKind[]
}

export interface UnresolvedSeries {
  status: "error"
  /** Per-source failure reasons, in priority order. */
  failures: { source: SourceKind; error: string }[]
}

export type SeriesResolution = ResolvedSeries | UnresolvedSeries

/**
 * Try the attempts in priority order; the FIRST with a non-empty series wins
 * (ADR-0053 §1). A failing source is recorded, never fatal. Pure — the shell does
 * the IO and passes already-normalized results here.
 */
export function resolveSeries(
  attempts: readonly SourceAttempt[]
): SeriesResolution {
  const degradedFrom: SourceKind[] = []
  const failures: { source: SourceKind; error: string }[] = []
  for (const attempt of attempts) {
    if (attempt.series && attempt.series.points.length > 0) {
      return {
        status: "ok",
        source: attempt.source,
        series: attempt.series,
        degradedFrom,
      }
    }
    degradedFrom.push(attempt.source)
    failures.push({
      source: attempt.source,
      error: attempt.error ?? "no usable NAV data",
    })
  }
  return { status: "error", failures }
}

export interface BuildPayloadOptions {
  mode: "latest" | "history"
  /** History mode: inclusive lower bound (`YYYY-MM-DD`). */
  from?: string
  /** `/nav` tail length (defaults to `LATEST_TAIL`). */
  tail?: number
}

/**
 * Build the ADR-0053 §2 payload from a resolved series. `latest` is the freshest
 * point (Friday's value on a weekend — the correct, expected state). `/nav`
 * returns a short trailing window; `/nav/history` returns the full series from
 * `from`. `stale` is set when the winning source was the D1 cache.
 */
export function buildPayload(
  fundCode: string,
  resolution: ResolvedSeries,
  options: BuildPayloadOptions
): NavPayload {
  const currency = resolution.series.currency
  const sorted = cleanSeries(resolution.series.points)

  let quotes: NavPoint[]
  if (options.mode === "history") {
    quotes = options.from
      ? sorted.filter((point) => point.date >= options.from!)
      : sorted
  } else {
    const tail = options.tail ?? LATEST_TAIL
    quotes = sorted.slice(-tail)
  }

  const freshest = sorted.at(-1) ?? null
  const stale = resolution.source === "stale_cache"

  return {
    fundCode,
    currency,
    latest: freshest ? { nav: freshest.nav, asOf: freshest.date } : null,
    quotes,
    ...(stale ? { stale: true } : {}),
  }
}

/** Is a `YYYY-MM-DD` date a Saturday/Sunday (UTC)? Documents the weekend rule. */
export function isWeekendDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  return day === 0 || day === 6
}
