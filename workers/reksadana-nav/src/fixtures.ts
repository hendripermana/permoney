/**
 * Recorded upstream fixtures for the reksadana-nav worker's PURE normalizer.
 * =============================================================================
 *
 * PROVENANCE (read before trusting these): during the ADR-0053 build spike the
 * Bareksa clean-JSON host (`api.bareksa.com/v22/...`) was found to require an
 * access token, and the `www.bareksa.com` product/API paths serve the Next.js app
 * shell (HTML), not JSON, to an unauthenticated client. So these fixtures reflect
 * the DOCUMENTED Bareksa response shape (a `data.nav` latest + `data.nav_history`
 * series; the product page's embedded `__NEXT_DATA__` JSON), NOT a byte-for-byte
 * live capture. They MUST be re-recorded from a live/authenticated probe when the
 * worker is first deployed (see README). The normalizer is deliberately
 * shape-tolerant + falls back (HTML → D1 stale) precisely so a shape drift
 * degrades instead of crashing; these fixtures pin that behaviour.
 *
 * The values are illustrative (Sucorinvest Money Market Fund, IDR MMF NAVs).
 */

/** Primary — Bareksa/Pasardana clean JSON: a latest point + a short history. */
export const BAREKSA_NAV_JSON_SAMPLE = {
  status: "success",
  data: {
    id: 1742,
    code: "sucorinvest-money-market-fund",
    name: "Sucorinvest Money Market Fund",
    currency: "IDR",
    nav: { date: "2026-08-14", value: 1643.45 },
    nav_history: [
      { date: "2026-08-11", value: 1642.71 },
      { date: "2026-08-12", value: 1642.98 },
      { date: "2026-08-13", value: 1643.19 },
      { date: "2026-08-14", value: 1643.45 },
    ],
  },
} as const

/** Primary — the `/nav/history` clean-JSON form (a dated array under `data`). */
export const BAREKSA_HISTORY_JSON_SAMPLE = {
  status: "success",
  data: [
    { date: "2026-08-03", nav: 1641.02 },
    { date: "2026-08-04", nav: 1641.29 },
    { date: "2026-08-05", nav: 1641.55 },
    { date: "2026-08-06", nav: 1641.83 },
    { date: "2026-08-07", nav: 1642.1 },
    { date: "2026-08-10", nav: 1642.44 },
    { date: "2026-08-11", nav: 1642.71 },
    { date: "2026-08-12", nav: 1642.98 },
    { date: "2026-08-13", nav: 1643.19 },
    { date: "2026-08-14", nav: 1643.45 },
  ],
} as const

/**
 * Fallback — the Bareksa product page HTML, reduced to the load-bearing part: the
 * `__NEXT_DATA__` JSON blob the scraper extracts. A minimal but realistic Next.js
 * shell so the extractor + deep search are exercised against real structure.
 */
export const BAREKSA_PRODUCT_HTML_SAMPLE = `<!DOCTYPE html><html lang="id"><head><title>Sucorinvest Money Market Fund | Bareksa</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
  {
    props: {
      pageProps: {
        product: {
          code: "sucorinvest-money-market-fund",
          currency: "IDR",
          nav: { date: "2026-08-14", value: 1643.45 },
          navHistory: [
            { date: "2026-08-12", value: 1642.98 },
            { date: "2026-08-13", value: 1643.19 },
            { date: "2026-08-14", value: 1643.45 },
          ],
        },
      },
    },
    page: "/reksadana/[slug]",
  }
)}</script></body></html>`

/**
 * Last resort — a payload previously served by THIS worker and cached in D1
 * (already in the ADR-0053 §2 contract shape). Served as LKGP, flagged stale.
 */
export const STALE_CACHE_SAMPLE = {
  fundCode: "sucorinvest-money-market-fund",
  currency: "IDR",
  latest: { nav: 1643.19, asOf: "2026-08-13" },
  quotes: [
    { date: "2026-08-12", nav: 1642.98 },
    { date: "2026-08-13", nav: 1643.19 },
  ],
} as const

/**
 * Weekend case — the freshest available NAV is Friday's (2026-08-14 is a Friday);
 * no Sat/Sun rows exist. Re-serving this on Sat/Sun must be a no-op success, not a
 * failure (ADR-0053 §3): `latest` stays Friday's value.
 */
export const WEEKEND_FLAT_JSON_SAMPLE = {
  status: "success",
  data: {
    currency: "IDR",
    nav: { date: "2026-08-14", value: 1643.45 },
    nav_history: [
      { date: "2026-08-13", value: 1643.19 },
      { date: "2026-08-14", value: 1643.45 },
    ],
  },
} as const

/** A malformed payload (no NAV-shaped data) — the JSON normalizer returns null. */
export const UNUSABLE_JSON_SAMPLE = {
  status: "error",
  message: "product not found",
} as const
