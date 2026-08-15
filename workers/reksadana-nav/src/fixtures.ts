/**
 * Recorded upstream fixtures for the reksadana-nav worker's PURE normalizer.
 * =============================================================================
 *
 * PROVENANCE (PER-258): these are recorded from a LIVE probe of the real Bareksa
 * ajax NAV endpoint (product id `3035` — Majoris Pasar Uang Syariah Indonesia).
 * The envelope shape, field names (`status`, `data.auth`, `data.unitY`,
 * `data.datas[].pid`/`pname`, `nav[].{id,date,value}`), the trading-days-only
 * series, and the `X-Ajax-Token` embedding (`$.ajaxSetup({ headers: { … } })`) are
 * all as captured live. The freshest point (`2026-08-14` → `1485.788100`) and the
 * prior day (`2026-08-13` → `1485.589400`) are the REAL values; the earlier points
 * are illustrative trading days on the same fund. Weekend rows (Sat/Sun) are absent
 * by construction — Bareksa's `nav[]` is trading-days-only.
 */

/** A `nav[]` row as Bareksa returns it (value is a decimal STRING). */
interface RawNavRow {
  id: string
  date: string
  value: string
}

/** Wrap a `nav[]` series in the real Bareksa ajax envelope. */
function bareksaEnvelope(nav: RawNavRow[]) {
  return {
    status: true,
    data: {
      auth: true,
      redirect_url: "",
      startdate: nav[0]?.date.split("-").reverse().join("-") ?? "",
      enddate: nav.at(-1)?.date.split("-").reverse().join("-") ?? "",
      subtitle: "Grafik NAB/Unit",
      unitY: "IDR",
      datas: [
        {
          pid: "3035",
          ptype: "1",
          idate: "2018-01-09",
          inav: "1000.0000",
          pname: "Majoris Pasar Uang Syariah Indonesia",
          nav,
        },
      ],
    },
  } as const
}

/** Trading-days-only NAV rows ending at the REAL latest (2026-08-14). */
const NAV_ROWS_SHORT: RawNavRow[] = [
  { id: "5170011", date: "2026-08-06", value: "1484.100000" },
  { id: "5171422", date: "2026-08-07", value: "1484.320000" },
  { id: "5173044", date: "2026-08-10", value: "1484.900000" },
  { id: "5174511", date: "2026-08-11", value: "1485.110000" },
  { id: "5175800", date: "2026-08-12", value: "1485.360000" },
  { id: "5177112", date: "2026-08-13", value: "1485.589400" },
  { id: "5178544", date: "2026-08-14", value: "1485.788100" },
]

/** A longer trading-days window, for the `/nav/history` backfill. */
const NAV_ROWS_HISTORY: RawNavRow[] = [
  { id: "5160010", date: "2026-08-03", value: "1482.900000" },
  { id: "5161422", date: "2026-08-04", value: "1483.150000" },
  { id: "5162844", date: "2026-08-05", value: "1483.470000" },
  ...NAV_ROWS_SHORT,
]

/**
 * Primary — the REAL Bareksa ajax NAV envelope (`GET /ajax/mutualfund/nav/
 * product1/?id=3035&cperiod=1m…`). `data.datas[0].nav[]` is the series; the LAST
 * element is the latest quote; `data.unitY` is the currency.
 */
export const BAREKSA_NAV_JSON_SAMPLE = bareksaEnvelope(NAV_ROWS_SHORT)

/** Primary — the same envelope with a longer nav[] (history backfill window). */
export const BAREKSA_HISTORY_JSON_SAMPLE = bareksaEnvelope(NAV_ROWS_HISTORY)

/**
 * A FAILED ajax attempt — Bareksa answers `status:false` / `data.auth:false` when
 * the `x-ajax-token` / `ba_session` bootstrap did not authenticate. The normalizer
 * must return null so the chain falls through to the HTML scrape, then D1 LKGP.
 */
export const UNUSABLE_JSON_SAMPLE = {
  status: false,
  data: { auth: false },
} as const

/**
 * The fake `X-Ajax-Token` the product-page fixture embeds (NEVER a real token).
 * Deliberately a non-hex, obviously-fake string so secret scanners don't flag it
 * as a high-entropy credential — the extractor accepts any non-quote value.
 */
export const BAREKSA_TOKEN_SAMPLE = "EXAMPLE-fake-ajax-token-not-a-secret"

/**
 * A representative `Set-Cookie` header (as `Headers.getSetCookie()` would join it)
 * the product-page response carries. `ba_session` is the session the ajax call
 * needs; `clang=id` pins the Indonesian locale. Values are fake.
 */
export const BAREKSA_SET_COOKIE_SAMPLE = [
  "ba_session=OLDSESSIONdiscarded; path=/; domain=.bareksa.com",
  "ba_session=FAKEba_session_value_1234567890; expires=Sun, 16-Aug-2026 13:43:26 GMT; Max-Age=86400; path=/; domain=.bareksa.com",
  "clang=id; Max-Age=2595000; path=/; domain=.bareksa.com",
].join("\n")

/** The freshest `ba_session` value `extractCookie` should return from the above. */
export const BAREKSA_SESSION_SAMPLE = "FAKEba_session_value_1234567890"

/**
 * Fallback — the Bareksa product-page HTML, reduced to the two load-bearing parts:
 * (1) the inline `$.ajaxSetup({ headers: { "X-Ajax-Token": '…' } })` the token
 * bootstrap extracts, and (2) an embedded `<script type="application/json">` NAV
 * blob the HTML scraper salvages when the token bootstrap fails.
 */
export const BAREKSA_PRODUCT_HTML_SAMPLE = `<!DOCTYPE html><html lang="id"><head><title>Majoris Pasar Uang Syariah Indonesia | Bareksa</title></head><body><div id="app"></div><script>
      var LANG = 'id';
      var ULOGIN = '';
      $.ajaxSetup({
        headers: { "X-Ajax-Token": '${BAREKSA_TOKEN_SAMPLE}' }
      });
    </script><script id="nav-data" type="application/json">${JSON.stringify(
      bareksaEnvelope(NAV_ROWS_SHORT.slice(-3))
    )}</script></body></html>`

/** Product-page HTML with NO ajax token (a markup drift) — bootstrap must fail. */
export const BAREKSA_HTML_NO_TOKEN_SAMPLE = `<!DOCTYPE html><html lang="id"><head><title>Bareksa</title></head><body><div id="app"></div></body></html>`

/**
 * Last resort — a payload previously served by THIS worker and cached in D1
 * (already in the ADR-0053 §2 contract shape). Served as LKGP, flagged stale.
 */
export const STALE_CACHE_SAMPLE = {
  fundCode: "RD-MAJORIS-MMF",
  currency: "IDR",
  latest: { nav: 1485.5894, asOf: "2026-08-13" },
  quotes: [
    { date: "2026-08-12", nav: 1485.36 },
    { date: "2026-08-13", nav: 1485.5894 },
  ],
} as const

/**
 * Weekend case — the freshest available NAV is Friday's (2026-08-14 is a Friday);
 * Bareksa's trading-days-only `nav[]` carries no Sat/Sun rows. Re-serving this on
 * Sat/Sun is a no-op success (ADR-0053 §3): `latest` stays Friday's value.
 */
export const WEEKEND_FLAT_JSON_SAMPLE = bareksaEnvelope([
  { id: "5177112", date: "2026-08-13", value: "1485.589400" },
  { id: "5178544", date: "2026-08-14", value: "1485.788100" },
])
