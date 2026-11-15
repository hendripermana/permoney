import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Client } from "pg"

// Issue #460 e2e support — a SYNTHETIC market series (a `MarketInstrument` plus
// its canonical `MarketQuote` observations) seeded straight into the e2e
// database.
//
// The market tables are GLOBAL reference data (no RLS, no tenant rows), so a
// spec can own them without touching any family's ledger. The rows are exactly
// what the ingest pipeline writes (ADR-0050 §1): a canonical spot-scaled price
// at a UTC-midnight `asOf`, in the series' quote currency.
//
// Nothing here is real market data — the symbol is unique per run and the
// prices are made up.

interface E2eState {
  databaseUrl: string
}

function readE2eDatabaseUrl(): string {
  const statePath = resolve(
    process.cwd(),
    ".playwright/permoney-e2e-state.json"
  )
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as E2eState
    return state.databaseUrl
  } catch (cause) {
    throw new Error(
      `Cannot seed a market series: the e2e server state file is missing at ${statePath}. ` +
        `Seeding needs the locally started e2e server (not PERMONEY_E2E_BASE_URL).`,
      { cause }
    )
  }
}

/** The canonical spot price scale for non-fx quotes (ADR-0050). */
const SPOT_PRICE_SCALE = 8

/**
 * Encode a MAJOR-unit decimal ("1200", "76359035.544") into the canonical
 * spot-scaled integer (price = value × 10^8). Exact bigint math — a float
 * would silently mis-price a quote.
 */
export function encodeSpotPrice(decimal: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim())
  if (match === null) {
    throw new Error(`Cannot encode the spot price "${decimal}"`)
  }
  const fraction = match[2] ?? ""
  if (fraction.length > SPOT_PRICE_SCALE) {
    throw new Error(
      `The spot price "${decimal}" has more than ${SPOT_PRICE_SCALE} decimals`
    )
  }
  const padded = fraction.padEnd(SPOT_PRICE_SCALE, "0")
  return (
    BigInt(match[1]) * 10n ** BigInt(SPOT_PRICE_SCALE) +
    BigInt(padded === "" ? "0" : padded)
  )
}

/**
 * Render an ISO instant as the UTC-naive timestamp Postgres stores.
 *
 * `MarketQuote.asOf` is `TIMESTAMP(3)` WITHOUT a time zone, and Prisma always
 * writes UTC. A JS `Date` handed to `pg` is serialized in the PROCESS's local
 * zone (Asia/Jakarta locally) — which would shift every seeded quote by that
 * offset and silently move a "UTC midnight" quote off its trading day. The
 * timestamp is therefore formatted in UTC here, exactly like Prisma writes it.
 */
function toUtcTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot seed a quote at "${iso}"`)
  }
  return date.toISOString().replace("T", " ").replace("Z", "")
}

export interface SeededMarketSeries {
  /** The global `MarketInstrument.id` the holding links to. */
  marketInstrumentId: string
  symbol: string
}

/**
 * Seed one synthetic market series and its quotes.
 *
 * `quotes[].priceMajor` is a MAJOR-unit decimal in `quoteCurrency` (e.g.
 * "1200" = Rp 1,200.00 per unit); `quotes[].asOf` is an ISO instant — the
 * lookup cuts off at UTC midnight, so seed UTC midnights.
 */
export async function seedMarketSeries({
  symbol,
  name,
  quoteCurrency = "IDR",
  kind = "security",
  quotes,
}: {
  symbol: string
  name?: string
  quoteCurrency?: string
  kind?: "security" | "metal" | "crypto"
  quotes: { asOf: string; priceMajor: string }[]
}): Promise<SeededMarketSeries> {
  const client = new Client({ connectionString: readE2eDatabaseUrl() })
  await client.connect()
  try {
    const marketInstrumentId = `e2e_mkt_${randomUUID()}`
    await client.query(
      `INSERT INTO "MarketInstrument"
         ("id", "kind", "symbol", "name", "baseCurrency", "quoteCurrency", "mic", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NULL, $5, NULL, now(), now())`,
      [marketInstrumentId, kind, symbol, name ?? symbol, quoteCurrency]
    )

    for (const quote of quotes) {
      await client.query(
        `INSERT INTO "MarketQuote"
           ("id", "marketInstrumentId", "asOf", "price", "priceScale", "quoteCurrency", "source", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          `e2e_quote_${randomUUID()}`,
          marketInstrumentId,
          toUtcTimestamp(quote.asOf),
          encodeSpotPrice(quote.priceMajor).toString(),
          SPOT_PRICE_SCALE,
          quoteCurrency,
          "e2e-fixture",
        ]
      )
    }

    return { marketInstrumentId, symbol }
  } finally {
    await client.end()
  }
}
