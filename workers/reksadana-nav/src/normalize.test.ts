import { describe, expect, test } from "vite-plus/test"
import {
  BAREKSA_HISTORY_JSON_SAMPLE,
  BAREKSA_HTML_NO_TOKEN_SAMPLE,
  BAREKSA_NAV_JSON_SAMPLE,
  BAREKSA_PRODUCT_HTML_SAMPLE,
  BAREKSA_SESSION_SAMPLE,
  BAREKSA_SET_COOKIE_SAMPLE,
  BAREKSA_TOKEN_SAMPLE,
  STALE_CACHE_SAMPLE,
  UNUSABLE_JSON_SAMPLE,
  WEEKEND_FLAT_JSON_SAMPLE,
} from "./fixtures"
import {
  buildPayload,
  cleanSeries,
  extractAjaxToken,
  extractCookie,
  isWeekendDate,
  normalizeBareksaHtml,
  normalizeBareksaJson,
  normalizeDate,
  normalizeNav,
  normalizeStaleCache,
  resolveSeries,
  toBareksaDate,
  type ResolvedSeries,
  type SourceAttempt,
} from "./normalize"

// =============================================================================
// PER-258 / ADR-0053 — the reksadana-nav worker's PURE normalizer + token
// bootstrap parsers + fallback ordering + weekend rule, fixture-driven, NO live
// network. Reconciled to the REAL Bareksa ajax NAV envelope + the two-step
// `x-ajax-token` / `ba_session` product-page bootstrap.
// =============================================================================

describe("scalar normalizers", () => {
  test("normalizeDate accepts YYYY-MM-DD, ISO, and epochs", () => {
    expect(normalizeDate("2026-08-14")).toBe("2026-08-14")
    expect(normalizeDate("2026-08-14T09:30:00.000Z")).toBe("2026-08-14")
    expect(normalizeDate(Date.UTC(2026, 7, 11))).toBe("2026-08-11") // ms epoch
    expect(normalizeDate(Math.floor(Date.UTC(2026, 7, 11) / 1000))).toBe(
      "2026-08-11"
    ) // s epoch
    expect(normalizeDate("not-a-date")).toBeNull()
    expect(normalizeDate("")).toBeNull()
    expect(normalizeDate(null)).toBeNull()
  })

  test("normalizeNav accepts positive numbers/strings, rejects the rest", () => {
    expect(normalizeNav(1643.45)).toBe(1643.45)
    expect(normalizeNav("1485.788100")).toBe(1485.7881)
    expect(normalizeNav(0)).toBeNull()
    expect(normalizeNav(-1)).toBeNull()
    expect(normalizeNav("abc")).toBeNull()
    expect(normalizeNav(null)).toBeNull()
  })
})

describe("normalizeBareksaJson (REAL Bareksa ajax envelope)", () => {
  test("parses data.datas[0].nav[]; currency from unitY; latest = LAST point", () => {
    const series = normalizeBareksaJson(BAREKSA_NAV_JSON_SAMPLE)
    expect(series).not.toBeNull()
    expect(series?.currency).toBe("IDR")
    // The last element is the freshest quote (the real 2026-08-14 value).
    expect(series?.points.at(-1)).toEqual({
      date: "2026-08-14",
      nav: 1485.7881,
    })
    // Deduped + ascending, trading-days-only (no Sat/Sun 08-08/08-09).
    expect(series?.points.map((p) => p.date)).toEqual([
      "2026-08-06",
      "2026-08-07",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ])
  })

  test("history envelope: a longer nav[] window normalizes in full", () => {
    const series = normalizeBareksaJson(BAREKSA_HISTORY_JSON_SAMPLE)
    expect(series?.points).toHaveLength(10)
    expect(series?.points[0]).toEqual({ date: "2026-08-03", nav: 1482.9 })
    expect(series?.points.at(-1)).toEqual({
      date: "2026-08-14",
      nav: 1485.7881,
    })
  })

  test("status:false / data.auth:false is a FAILED attempt → null (chain falls through)", () => {
    expect(normalizeBareksaJson(UNUSABLE_JSON_SAMPLE)).toBeNull()
    expect(normalizeBareksaJson({ status: false })).toBeNull()
    expect(
      normalizeBareksaJson({ data: { auth: false, datas: [] } })
    ).toBeNull()
    expect(normalizeBareksaJson(null)).toBeNull()
    expect(normalizeBareksaJson("nope")).toBeNull()
  })

  test("deep search tolerates a nested/renamed container", () => {
    const drifted = {
      result: {
        payload: { series: [{ tanggal: "2026-08-14", nilai: 1485.7881 }] },
      },
    }
    const series = normalizeBareksaJson(drifted)
    expect(series?.points).toEqual([{ date: "2026-08-14", nav: 1485.7881 }])
  })
})

describe("token bootstrap parsers (product-page → ajax)", () => {
  test("extractAjaxToken pulls the X-Ajax-Token out of the ajaxSetup script", () => {
    expect(extractAjaxToken(BAREKSA_PRODUCT_HTML_SAMPLE)).toBe(
      BAREKSA_TOKEN_SAMPLE
    )
  })

  test("extractAjaxToken returns null when no token is embedded", () => {
    expect(extractAjaxToken(BAREKSA_HTML_NO_TOKEN_SAMPLE)).toBeNull()
    expect(extractAjaxToken("")).toBeNull()
    expect(extractAjaxToken(null)).toBeNull()
  })

  test("extractCookie returns the freshest ba_session from Set-Cookie", () => {
    expect(extractCookie(BAREKSA_SET_COOKIE_SAMPLE)).toBe(
      BAREKSA_SESSION_SAMPLE
    )
    expect(extractCookie(BAREKSA_SET_COOKIE_SAMPLE, "clang")).toBe("id")
    expect(extractCookie("", "ba_session")).toBeNull()
    expect(extractCookie(null)).toBeNull()
    expect(extractCookie("other=1; path=/")).toBeNull()
  })

  test("toBareksaDate converts YYYY-MM-DD → DD-MM-YYYY", () => {
    expect(toBareksaDate("2026-08-14")).toBe("14-08-2026")
    expect(toBareksaDate("2026-08-14T09:30:00.000Z")).toBe("14-08-2026")
    expect(toBareksaDate("not-a-date")).toBeNull()
    expect(toBareksaDate(null)).toBeNull()
  })
})

describe("normalizeBareksaHtml (fallback scrape of embedded NAV JSON)", () => {
  test("salvages the embedded application/json NAV blob", () => {
    const series = normalizeBareksaHtml(BAREKSA_PRODUCT_HTML_SAMPLE)
    expect(series?.currency).toBe("IDR")
    expect(series?.points.at(-1)).toEqual({
      date: "2026-08-14",
      nav: 1485.7881,
    })
  })

  test("HTML with no embedded NAV / bad JSON returns null", () => {
    expect(normalizeBareksaHtml(BAREKSA_HTML_NO_TOKEN_SAMPLE)).toBeNull()
    expect(normalizeBareksaHtml("<html><body>no data</body></html>")).toBeNull()
    expect(
      normalizeBareksaHtml('<script type="application/json">{bad</script>')
    ).toBeNull()
    expect(normalizeBareksaHtml(null)).toBeNull()
  })
})

describe("normalizeStaleCache (the worker's OWN contract shape, from D1)", () => {
  test("reads { currency, quotes, latest } back into a series", () => {
    const series = normalizeStaleCache(STALE_CACHE_SAMPLE)
    expect(series?.currency).toBe("IDR")
    expect(series?.points.at(-1)).toEqual({
      date: "2026-08-13",
      nav: 1485.5894,
    })
    expect(series?.points.map((p) => p.date)).toEqual([
      "2026-08-12",
      "2026-08-13",
    ])
  })

  test("a non-object / empty cache returns null", () => {
    expect(normalizeStaleCache(null)).toBeNull()
    expect(normalizeStaleCache({ currency: "IDR" })).toBeNull()
  })
})

describe("resolveSeries (fallback ordering, ADR-0053 §1)", () => {
  const good = normalizeBareksaJson(BAREKSA_NAV_JSON_SAMPLE)
  const html = normalizeBareksaHtml(BAREKSA_PRODUCT_HTML_SAMPLE)
  const stale = normalizeStaleCache(STALE_CACHE_SAMPLE)

  test("primary wins when available (no degradation)", () => {
    const res = resolveSeries([
      { source: "bareksa_json", series: good },
      { source: "bareksa_html", series: html },
      { source: "stale_cache", series: stale },
    ])
    expect(res.status).toBe("ok")
    expect((res as ResolvedSeries).source).toBe("bareksa_json")
    expect((res as ResolvedSeries).degradedFrom).toEqual([])
  })

  test("primary fails → falls back to HTML scraper", () => {
    const res = resolveSeries([
      { source: "bareksa_json", series: null, error: "no ajax token" },
      { source: "bareksa_html", series: html },
      { source: "stale_cache", series: stale },
    ])
    expect((res as ResolvedSeries).source).toBe("bareksa_html")
    expect((res as ResolvedSeries).degradedFrom).toEqual(["bareksa_json"])
  })

  test("primary + fallback fail → serves stale D1 cache (LKGP)", () => {
    const res = resolveSeries([
      { source: "bareksa_json", series: null },
      { source: "bareksa_html", series: null },
      { source: "stale_cache", series: stale },
    ])
    expect((res as ResolvedSeries).source).toBe("stale_cache")
    expect((res as ResolvedSeries).degradedFrom).toEqual([
      "bareksa_json",
      "bareksa_html",
    ])
  })

  test("every source fails → structured error (no throw)", () => {
    const attempts: SourceAttempt[] = [
      { source: "bareksa_json", series: null, error: "HTTP 403" },
      { source: "bareksa_html", series: null, error: "no NAV in HTML" },
      { source: "stale_cache", series: null, error: "cache empty" },
    ]
    const res = resolveSeries(attempts)
    expect(res.status).toBe("error")
    if (res.status === "error") {
      expect(res.failures.map((f) => f.source)).toEqual([
        "bareksa_json",
        "bareksa_html",
        "stale_cache",
      ])
    }
  })

  test("an empty series is treated as a failure, not a win", () => {
    const res = resolveSeries([
      { source: "bareksa_json", series: { currency: "IDR", points: [] } },
      {
        source: "stale_cache",
        series: normalizeStaleCache(STALE_CACHE_SAMPLE),
      },
    ])
    expect((res as ResolvedSeries).source).toBe("stale_cache")
  })
})

describe("buildPayload (ADR-0053 §2 contract)", () => {
  function resolvedFrom(sample: unknown, source: ResolvedSeries["source"]) {
    const series = normalizeBareksaJson(sample)
    if (!series) throw new Error("fixture did not normalize")
    return { status: "ok", source, series, degradedFrom: [] } as ResolvedSeries
  }

  test("latest mode: latest = freshest point + a short tail", () => {
    const payload = buildPayload(
      "RD-MAJORIS-MMF",
      resolvedFrom(BAREKSA_HISTORY_JSON_SAMPLE, "bareksa_json"),
      { mode: "latest", tail: 3 }
    )
    expect(payload.currency).toBe("IDR")
    expect(payload.latest).toEqual({ nav: 1485.7881, asOf: "2026-08-14" })
    expect(payload.quotes).toHaveLength(3)
    expect(payload.quotes.at(-1)?.date).toBe("2026-08-14")
    expect(payload.stale).toBeUndefined()
  })

  test("history mode: full series from `from` (inclusive)", () => {
    const payload = buildPayload(
      "RD-MAJORIS-MMF",
      resolvedFrom(BAREKSA_HISTORY_JSON_SAMPLE, "bareksa_json"),
      { mode: "history", from: "2026-08-11" }
    )
    expect(payload.quotes.map((q) => q.date)).toEqual([
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ])
  })

  test("stale source sets the stale flag", () => {
    const series = normalizeStaleCache(STALE_CACHE_SAMPLE)
    if (!series) throw new Error("stale fixture did not normalize")
    const payload = buildPayload(
      "RD-MAJORIS-MMF",
      { status: "ok", source: "stale_cache", series, degradedFrom: [] },
      { mode: "latest" }
    )
    expect(payload.stale).toBe(true)
    expect(payload.latest).toEqual({ nav: 1485.5894, asOf: "2026-08-13" })
  })
})

describe("weekend / market-holiday invariant (ADR-0053 §3)", () => {
  test("isWeekendDate flags Sat/Sun only", () => {
    expect(isWeekendDate("2026-08-14")).toBe(false) // Friday
    expect(isWeekendDate("2026-08-15")).toBe(true) // Saturday
    expect(isWeekendDate("2026-08-16")).toBe(true) // Sunday
    expect(isWeekendDate("2026-08-17")).toBe(false) // Monday
  })

  test("a weekend payload is a NO-OP success: latest stays Friday's value", () => {
    // Bareksa's nav[] is trading-days-only; re-serving the same Friday-terminating
    // series on Sat & Sun yields an identical `latest` both times (NOT an error).
    const series = normalizeBareksaJson(WEEKEND_FLAT_JSON_SAMPLE)
    if (!series) throw new Error("weekend fixture did not normalize")
    const resolved: ResolvedSeries = {
      status: "ok",
      source: "bareksa_json",
      series,
      degradedFrom: [],
    }
    const saturday = buildPayload("fund", resolved, { mode: "latest" })
    const sunday = buildPayload("fund", resolved, { mode: "latest" })
    expect(saturday.latest).toEqual({ nav: 1485.7881, asOf: "2026-08-14" })
    expect(sunday.latest).toEqual(saturday.latest)
  })

  test("cleanSeries dedupes a repeated as-of (flat carry) to one point", () => {
    const points = cleanSeries([
      { date: "2026-08-14", nav: 1485.7881 },
      { date: "2026-08-14", nav: 1485.7881 },
    ])
    expect(points).toHaveLength(1)
  })
})
