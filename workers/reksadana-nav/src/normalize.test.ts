import { describe, expect, test } from "vite-plus/test"
import {
  BAREKSA_HISTORY_JSON_SAMPLE,
  BAREKSA_NAV_JSON_SAMPLE,
  BAREKSA_PRODUCT_HTML_SAMPLE,
  STALE_CACHE_SAMPLE,
  UNUSABLE_JSON_SAMPLE,
  WEEKEND_FLAT_JSON_SAMPLE,
} from "./fixtures"
import {
  buildPayload,
  cleanSeries,
  isWeekendDate,
  normalizeBareksaHtml,
  normalizeBareksaJson,
  normalizeDate,
  normalizeNav,
  normalizeStaleCache,
  resolveSeries,
  type ResolvedSeries,
  type SourceAttempt,
} from "./normalize"

// =============================================================================
// PER-250 Slice B / ADR-0053 — the reksadana-nav worker's PURE normalizer +
// fallback ordering + weekend rule, fixture-driven, NO live network. This is the
// fragile part the ADR singles out for review; every source shape, the priority
// chain, and the weekend invariant are pinned here.
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
    expect(normalizeNav("1643.45")).toBe(1643.45)
    expect(normalizeNav(0)).toBeNull()
    expect(normalizeNav(-1)).toBeNull()
    expect(normalizeNav("abc")).toBeNull()
    expect(normalizeNav(null)).toBeNull()
  })
})

describe("normalizeBareksaJson (primary clean JSON)", () => {
  test("documented shape: data.nav latest + data.nav_history series", () => {
    const series = normalizeBareksaJson(BAREKSA_NAV_JSON_SAMPLE)
    expect(series).not.toBeNull()
    expect(series?.currency).toBe("IDR")
    // Deduped + ascending; the latest is Friday's value.
    expect(series?.points.at(-1)).toEqual({ date: "2026-08-14", nav: 1643.45 })
    expect(series?.points.map((p) => p.date)).toEqual([
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ])
  })

  test("history array shape (data: [{date, nav}])", () => {
    const series = normalizeBareksaJson(BAREKSA_HISTORY_JSON_SAMPLE)
    expect(series?.points).toHaveLength(10)
    expect(series?.points[0]).toEqual({ date: "2026-08-03", nav: 1641.02 })
  })

  test("a malformed payload with no NAV data returns null (→ next source)", () => {
    expect(normalizeBareksaJson(UNUSABLE_JSON_SAMPLE)).toBeNull()
    expect(normalizeBareksaJson(null)).toBeNull()
    expect(normalizeBareksaJson("nope")).toBeNull()
  })

  test("deep search tolerates a nested/renamed container", () => {
    const drifted = {
      result: {
        payload: { series: [{ tanggal: "2026-08-14", nilai: 1643.45 }] },
      },
    }
    const series = normalizeBareksaJson(drifted)
    expect(series?.points).toEqual([{ date: "2026-08-14", nav: 1643.45 }])
  })
})

describe("normalizeBareksaHtml (fallback __NEXT_DATA__ scraper)", () => {
  test("extracts + parses the embedded Next.js data blob", () => {
    const series = normalizeBareksaHtml(BAREKSA_PRODUCT_HTML_SAMPLE)
    expect(series?.currency).toBe("IDR")
    expect(series?.points.at(-1)).toEqual({ date: "2026-08-14", nav: 1643.45 })
  })

  test("HTML with no __NEXT_DATA__ / bad JSON returns null", () => {
    expect(normalizeBareksaHtml("<html><body>no data</body></html>")).toBeNull()
    expect(
      normalizeBareksaHtml(
        '<script id="__NEXT_DATA__" type="application/json">{bad</script>'
      )
    ).toBeNull()
    expect(normalizeBareksaHtml(null)).toBeNull()
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
      { source: "bareksa_json", series: null, error: "HTTP 403" },
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
      { source: "bareksa_html", series: null, error: "no __NEXT_DATA__" },
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
      "sucorinvest-money-market-fund",
      resolvedFrom(BAREKSA_HISTORY_JSON_SAMPLE, "bareksa_json"),
      { mode: "latest", tail: 3 }
    )
    expect(payload.currency).toBe("IDR")
    expect(payload.latest).toEqual({ nav: 1643.45, asOf: "2026-08-14" })
    expect(payload.quotes).toHaveLength(3)
    expect(payload.quotes.at(-1)?.date).toBe("2026-08-14")
    expect(payload.stale).toBeUndefined()
  })

  test("history mode: full series from `from` (inclusive)", () => {
    const payload = buildPayload(
      "sucorinvest-money-market-fund",
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
      "sucorinvest-money-market-fund",
      { status: "ok", source: "stale_cache", series, degradedFrom: [] },
      { mode: "latest" }
    )
    expect(payload.stale).toBe(true)
    expect(payload.latest).toEqual({ nav: 1643.19, asOf: "2026-08-13" })
  })
})

describe("weekend / market-holiday invariant (ADR-0053 §3)", () => {
  test("isWeekendDate flags Sat/Sun only", () => {
    expect(isWeekendDate("2026-08-14")).toBe(false) // Friday
    expect(isWeekendDate("2026-08-15")).toBe(true) // Saturday
    expect(isWeekendDate("2026-08-16")).toBe(true) // Sunday
    expect(isWeekendDate("2026-08-17")).toBe(false) // Monday
  })

  test("a weekend/flat payload is a NO-OP success: latest stays Friday's value", () => {
    // Serving the same Friday-terminating series on Sat & Sun yields an identical
    // `latest` both times — the store dedupes it; this is NOT an error.
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
    expect(saturday.latest).toEqual({ nav: 1643.45, asOf: "2026-08-14" })
    expect(sunday.latest).toEqual(saturday.latest)
  })

  test("cleanSeries dedupes a repeated as-of (flat carry) to one point", () => {
    const points = cleanSeries([
      { date: "2026-08-14", nav: 1643.45 },
      { date: "2026-08-14", nav: 1643.45 },
    ])
    expect(points).toHaveLength(1)
  })
})
