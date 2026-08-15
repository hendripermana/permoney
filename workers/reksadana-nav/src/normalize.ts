/**
 * Reksadana NAV — PURE normalization + source-selection core (ADR-0053).
 * =============================================================================
 *
 * This module is the FRAGILE part the ADR singles out for review + unit tests,
 * and it is deliberately factored to contain ZERO Cloudflare-runtime dependencies
 * (no `fetch`, no D1, no `Request`/`Response`). The worker entry (`index.ts`) is a
 * thin shell that does the IO (fetch each upstream, read/write D1) and hands the
 * raw bytes to the pure functions here; `vp test` unit-tests this module directly
 * against recorded fixtures with no live network.
 *
 * Responsibilities:
 *   1. Per-source NORMALIZERS — turn each upstream's raw shape into the internal
 *      `NormalizedSeries` (`{ currency, points: [{date, nav}] }`):
 *        - `normalizeBareksaJson`  — Bareksa/Pasardana clean JSON (primary).
 *        - `normalizeBareksaHtml`  — the product page's embedded `__NEXT_DATA__`
 *          JSON (fallback scraper; Bareksa is a Next.js app).
 *        - `normalizeStaleCache`   — a previously-served payload from D1 (LKGP).
 *      Each is SHAPE-TOLERANT (probes known keys, then a bounded deep search) so a
 *      minor upstream drift degrades to the next source rather than crashing.
 *   2. FALLBACK ORDERING — `resolveSeries` tries attempts in priority order and
 *      returns the FIRST that yields a usable series, recording the degradation.
 *   3. The ADR-0053 §2 target CONTRACT — `buildPayload` emits
 *      `{ fundCode, currency, latest, quotes, stale }` for both `/nav` (latest)
 *      and `/nav/history` (backfill) modes.
 *
 * WEEKEND / MARKET-HOLIDAY INVARIANT (ADR-0053 §3): KSEI/IDX publish no new NAV on
 * Sat–Sun/holidays; the freshest quote simply carries Friday's value. Nothing here
 * treats a flat/repeated (or absent-today) NAV as an error — `latest` is always
 * the freshest AVAILABLE point, and a weekend backfill simply lacks Sat/Sun rows.
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
  "nav",
  "value",
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
  if (depth > 6 || node === null || typeof node !== "object") return null
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
  for (const key of ["currency", "ccy", "curr"]) {
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
 * Normalize a Bareksa/Pasardana clean-JSON payload into a series. Handles the
 * documented shapes (a `data.nav` latest + `data.nav_history` array; a top-level
 * or `data` array of rows; a single `nav` object) and falls back to a bounded
 * deep search. Returns null when nothing NAV-shaped is found (→ try next source).
 */
export function normalizeBareksaJson(raw: unknown): NormalizedSeries | null {
  if (!isRecord(raw) && !Array.isArray(raw)) return null

  const collected: NavPoint[] = []

  // Known array containers first (cheap, precise).
  const containers: unknown[] = []
  if (isRecord(raw)) {
    containers.push(
      raw.nav_history,
      raw.navHistory,
      raw.history,
      raw.quotes,
      raw.data,
      isRecord(raw.data) ? raw.data.nav_history : undefined,
      isRecord(raw.data) ? raw.data.navHistory : undefined,
      isRecord(raw.data) ? raw.data.history : undefined,
      isRecord(raw.data) ? raw.data.data : undefined
    )
  } else {
    containers.push(raw)
  }
  for (const container of containers) {
    const points = arrayToPoints(container)
    if (points) collected.push(...points)
  }

  // A single "latest" nav object (`{nav|data.nav: {date,value}}`).
  if (isRecord(raw)) {
    for (const candidate of [
      raw.nav,
      raw.latest,
      isRecord(raw.data) ? raw.data.nav : undefined,
      isRecord(raw.data) ? raw.data.latest : undefined,
    ]) {
      if (isRecord(candidate)) {
        const point = pointFromRow(candidate)
        if (point) collected.push(point)
      }
    }
  }

  // Last-resort deep search when the known keys found nothing.
  if (collected.length === 0) {
    const deep = deepFindLongestSeries(raw)
    if (deep) collected.push(...deep)
  }

  if (collected.length === 0) return null
  return { currency: findCurrency(raw), points: cleanSeries(collected) }
}

/**
 * Fallback scraper: Bareksa's product page is a Next.js app that embeds its server
 * props (including NAV) in a `<script id="__NEXT_DATA__" type="application/json">`
 * blob. Extract + JSON.parse it, then reuse the JSON normalizer's deep search.
 * Returns null when no parseable NAV data is present.
 */
export function normalizeBareksaHtml(html: unknown): NormalizedSeries | null {
  if (typeof html !== "string" || html.length === 0) return null
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  )
  if (!match || match[1] === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  return normalizeBareksaJson(parsed)
}

/**
 * Normalize a payload previously served by THIS worker and cached in D1 (LKGP).
 * It is already in (or close to) the ADR-0053 §2 contract, so this accepts the
 * `{ currency, quotes|latest }` shape as well as the generic normalizer's shapes.
 */
export function normalizeStaleCache(raw: unknown): NormalizedSeries | null {
  return normalizeBareksaJson(raw)
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
