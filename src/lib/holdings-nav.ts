/**
 * Holdings NAV prefill — pure descriptors for the Buy/Sell and Switch dialogs
 * (issue #460 / ADR-0053 amendment).
 * =============================================================================
 *
 * A trade is priced by the NAV of the SELECTED TRADE DATE, not by whatever
 * `Holding.lastPriceMinor` happened to be refreshed to yesterday. This module is
 * the pure, DB-free half of that contract: it parses the dialog's local calendar
 * day, formats the resolved quote date for display, and derives the price field's
 * default plus the explanatory/restore labels.
 *
 * The server half (`getNavForDateForFamily` in `src/server/holdings.ts`) applies
 * the cutoff (`MarketQuote.asOf <= UTC midnight of the selected day`) and NEVER
 * returns a future quote; this module never re-derives money — it only decides
 * what the dialog should show, from the server's answer.
 *
 * Display rules (locked, ADR-0053 amendment):
 *   * resolved quote          → `NAV 14 Aug 2026 (from market data)`
 *   * no quote on/before day  → `Last known price (newest quote 20 Aug 2026) —
 *                               no NAV on or before 15 Aug 2026` (the
 *                               parenthetical appears only when a LATER quote
 *                               exists — the diagnostic is never used as a
 *                               price — AND the fallback basis is the LAST
 *                               KNOWN PRICE; when the basis is the AVERAGE
 *                               UNIT COST the parenthetical is SUPPRESSED,
 *                               because naming a market quote next to a
 *                               cost-basis number would mislead)
 *   * unlinked holding        → the legacy
 *     `Last known price — edit if this trade used a different one.`
 *   * query in flight         → `Resolving NAV for 15 Aug 2026…`
 *   * query failed            → `Last known price — couldn't load NAV for
 *     15 Aug 2026.` (`Average unit cost — …` for an unpriced holding)
 *
 * The field is ALWAYS editable and the query NEVER blocks submit: the default
 * is a starting point, not a lock.
 */

import { formatCurrency } from "./currency"
import type { CurrencyCode } from "./data/currencies"

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const NAV_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
})

/** The long-standing copy for a holding with NO market series behind it. */
export const UNLINKED_HOLDING_LABEL =
  "Last known price — edit if this trade used a different one."

/**
 * Parse a strict `YYYY-MM-DD` calendar day into the instant of UTC midnight for
 * that day — the exclusive cutoff boundary the server compares quotes against.
 *
 * Strict on purpose: `2026-02-31` must NOT silently become 2026-03-03 (the
 * Date constructor's overflow behavior), because that would silently shift the
 * trade's NAV to a different trading day. Returns null for any malformed or
 * impossible date.
 */
export function parseCalendarDateUtcMidnight(value: string): Date | null {
  const match = CALENDAR_DATE_PATTERN.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

/** Render a UTC date as the dialog's `14 Aug 2026` label. */
export function formatNavAsOf(date: Date): string {
  return NAV_DATE_FORMATTER.format(date)
}

/**
 * Format a `YYYY-MM-DD` calendar day for labels. A day the strict parser
 * rejects is passed through verbatim (it can only come from a bug, and hiding
 * it would be worse than showing it).
 */
export function formatNavCalendarDay(day: string): string {
  const parsed = parseCalendarDateUtcMidnight(day)
  return parsed === null ? day : formatNavAsOf(parsed)
}

/** Format a server ISO timestamp for labels; unparseable values pass through. */
function formatNavInstant(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : formatNavAsOf(date)
}

/** The server's answer shape, mirrored here so the dialogs never re-derive it. */
export type HoldingNavStatus = "nav" | "none" | "unlinked"

/** Which figure the price field falls back to when there is no NAV. */
export type HoldingNavFallbackSource = "last_price" | "avg_cost" | null

export interface HoldingNavFacts {
  /** The holding's currency — the unit of every price in this descriptor. */
  currency: CurrencyCode
  /** The server's verdict for the requested day. */
  status: HoldingNavStatus
  /**
   * The NAV, in MINOR units of the holding's currency (null if none).
   *
   * While RESOLVING, this may carry the PREVIOUS day's NAV (the query's
   * placeholder data): the field keeps showing the NAV it already had instead
   * of dropping back to the stale last-known price.
   */
  priceMinor: bigint | null
  /**
   * The RESOLVED quote's as-of instant (ISO string) — never the request day.
   * While resolving, this is the PREVIOUS quote's as-of.
   */
  asOf: string | null
  /**
   * As-of of the NEWEST quote at all (ISO string), or null when the series has
   * no quotes. A DIAGNOSTIC ONLY: a later day's quote must never price an
   * earlier trade.
   */
  newestQuoteAsOf: string | null
  /** The dialog's LOCAL calendar day (`YYYY-MM-DD`) that was asked for. */
  requestedDate: string
  /** The fallback price (last known price, else average unit cost). */
  fallbackPriceMinor: bigint | null
  /** Which fallback the price field starts from. */
  fallbackSource: HoldingNavFallbackSource
  /**
   * Whether the selected holding's Instrument is linked to a MarketInstrument.
   * An unlinked holding can never resolve a NAV, so no query is made for it.
   */
  linked: boolean
  /** The NAV lookup is in flight. */
  isLoading: boolean
  /** The NAV lookup failed. */
  isError: boolean
}

export interface HoldingNavDescriptor {
  /**
   * The default unit price to show while the user has not typed one. Minor
   * units of the holding's currency; never null — the fallback chain ends at
   * average cost.
   */
  defaultPriceMinor: bigint
  /** Explanatory line under the price field (or the legacy unlinked line). */
  label: string
  /**
   * Click-to-restore wording shown INSTEAD of the label once the user's typed
   * draft differs from the default. Always present (every holding has a
   * restorable default).
   */
  restoreLabel: string
}

/** `Last known price` vs `Average unit cost` — which figure the field starts at. */
function fallbackBasisLabel(fallbackSource: HoldingNavFallbackSource): string {
  return fallbackSource === "avg_cost"
    ? "Average unit cost"
    : "Last known price"
}

function restoreLabelFor(
  basis: "nav" | "last_known" | "average_cost",
  priceMinor: bigint,
  currency: CurrencyCode,
  navAsOfLabel: string | null
): string {
  const money = formatCurrency(priceMinor, currency)
  if (basis === "nav" && navAsOfLabel !== null) {
    return `Use NAV ${navAsOfLabel}: ${money}`
  }
  if (basis === "last_known") return `Use last known: ${money}`
  return `Use average cost: ${money}`
}

/**
 * Derive the unit-price default and the label/restore copy for the selected
 * holding. Pure: the same facts always produce the same descriptor, which is why
 * the dialogs can recompute it during render instead of syncing state in an
 * effect.
 */
export function describeHoldingNav(
  facts: HoldingNavFacts
): HoldingNavDescriptor {
  const fallbackPriceMinor = facts.fallbackPriceMinor ?? 0n
  const requestedDayLabel = formatNavCalendarDay(facts.requestedDate)
  const basisLabel = fallbackBasisLabel(facts.fallbackSource)
  const fallbackRestore = restoreLabelFor(
    facts.fallbackSource === "avg_cost" ? "average_cost" : "last_known",
    fallbackPriceMinor,
    facts.currency,
    null
  )

  // Unlinked: there is no market series to ask. Keep the long-standing legacy
  // copy so a manual-priced holding's dialog does not change at all.
  if (!facts.linked || facts.status === "unlinked") {
    return {
      defaultPriceMinor: fallbackPriceMinor,
      label: UNLINKED_HOLDING_LABEL,
      restoreLabel: fallbackRestore,
    }
  }

  if (facts.isError) {
    return {
      defaultPriceMinor: fallbackPriceMinor,
      label: `${basisLabel} — couldn't load NAV for ${requestedDayLabel}.`,
      restoreLabel: fallbackRestore,
    }
  }

  if (facts.isLoading) {
    // Resolving a NEW day. The previous day's NAV (the query's placeholder)
    // stays in the field — the price must never flash back to the stale
    // last-known price while the new NAV is on its way.
    const previousNavMinor = facts.priceMinor
    return {
      defaultPriceMinor: previousNavMinor ?? fallbackPriceMinor,
      label: `Resolving NAV for ${requestedDayLabel}…`,
      restoreLabel:
        previousNavMinor !== null && facts.asOf !== null
          ? restoreLabelFor(
              "nav",
              previousNavMinor,
              facts.currency,
              formatNavInstant(facts.asOf)
            )
          : fallbackRestore,
    }
  }

  if (facts.status === "nav" && facts.priceMinor !== null && facts.asOf) {
    const navAsOfLabel = formatNavInstant(facts.asOf)
    return {
      defaultPriceMinor: facts.priceMinor,
      label: `NAV ${navAsOfLabel} (from market data)`,
      restoreLabel: restoreLabelFor(
        "nav",
        facts.priceMinor,
        facts.currency,
        navAsOfLabel
      ),
    }
  }

  // No NAV on/before the requested day. A LATER quote is surfaced as a
  // diagnostic only — it must never price this trade.
  //
  // The parenthetical names a MARKET quote, so it is only honest next to a
  // market-derived fallback: when the field starts at the AVERAGE UNIT COST
  // (a cost-basis number, not market data) it is dropped.
  const newestSuffix =
    facts.fallbackSource === "avg_cost" || facts.newestQuoteAsOf === null
      ? ""
      : ` (newest quote ${formatNavInstant(facts.newestQuoteAsOf)})`
  return {
    defaultPriceMinor: fallbackPriceMinor,
    label: `${basisLabel}${newestSuffix} — no NAV on or before ${requestedDayLabel}`,
    restoreLabel: fallbackRestore,
  }
}
