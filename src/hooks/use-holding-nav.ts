import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import type { CurrencyCode } from "@/lib/data/currencies"
import {
  describeHoldingNav,
  type HoldingNavDescriptor,
} from "@/lib/holdings-nav"
import { toDecimalString } from "@/lib/money"
import { getNavForDateFn } from "@/server/holdings"

// Issue #460 / ADR-0053 amendment — the NAV lookup for the trade's SELECTED
// calendar day, plus the sticky typed-override state the Buy/Sell and Switch
// dialogs share.
//
// Declarative `useQuery` (no useEffect): the dialogs derive their unit-price
// default from `data` during render, and a pending/erroring query NEVER blocks
// submit — the field keeps its last-known/average-cost default.
//
// The key carries the family-owned `Instrument.id` (not the global
// `MarketInstrument.id`): the server resolves the market link inside the
// caller's tenant scope, so an unknown/foreign instrument is rejected before
// any global row is read.
export function useHoldingNav({
  instrumentId,
  asOfDate,
  enabled,
}: {
  instrumentId: string | null
  /** The dialog's LOCAL calendar day (`YYYY-MM-DD`), not an instant. */
  asOfDate: string
  /** False for manual-priced holdings / "new instrument" — no request at all. */
  enabled: boolean
}) {
  return useQuery({
    queryKey: ["holding-nav", instrumentId, asOfDate] as const,
    queryFn: async () => {
      if (instrumentId === null) {
        throw new Error("useHoldingNav: instrumentId is required")
      }
      return await getNavForDateFn({ data: { instrumentId, asOfDate } })
    },
    enabled: enabled && instrumentId !== null,
    // A failed NAV lookup is a display fallback, not a transient session
    // problem: retrying would only delay the "using last known price" state and
    // spam the server while the user keeps typing.
    retry: false,
    // While the NEXT day's NAV is on its way, keep showing the PREVIOUS day's
    // answer instead of dropping the field back to the stale last-known price.
    // The placeholder is inherited ONLY for the SAME instrument: a different
    // instrument must never show another instrument's price.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === instrumentId ? previous : undefined,
  })
}

export interface HoldingNavField {
  /** What the controlled money input renders: typed draft, else the default. */
  value: string
  /** The user's typed override for the CURRENT selection, or null. */
  draft: string | null
  /** True when a typed draft differs from the default → show restore, not label. */
  isModified: boolean
  /** Null only when no position/instrument is selected (e.g. "New instrument"). */
  descriptor: HoldingNavDescriptor | null
  onChange: (raw: string) => void
  restore: () => void
}

/**
 * One deep module for the whole "price this trade at the trade-day NAV" field:
 * query, sticky per-selection override, default derivation, and label/restore
 * state. Both dialogs call this, so their behavior cannot drift apart.
 *
 * The typed override is PER SELECTION: the draft stores the id it belongs to
 * (`selectionKey`), so switching the source selection drops it (the new
 * selection shows ITS default) while changing the DATE keeps it (the user's
 * typed price is still the price they traded at). Pure derivation — no effect.
 *
 * `selectionKey` is ALWAYS a string — it identifies WHAT is selected (an
 * instrument id, the "new instrument" sentinel, a source holding id), not
 * whether a NAV source exists. A selection without a NAV source (an instrument
 * the family does not hold yet) has an EMPTY, freely typeable price field; only
 * the NAV lookup and the hint are absent.
 */
export function useHoldingNavField({
  selectionKey,
  instrumentId,
  marketInstrumentId,
  lastPriceMinor,
  avgUnitCostMinor,
  currency,
  asOfDate,
}: {
  /** The selection the draft belongs to (always a string). */
  selectionKey: string
  /** The NAV source — null when the selection has no market series behind it. */
  instrumentId: string | null
  marketInstrumentId: string | null
  lastPriceMinor: string | null
  avgUnitCostMinor: string | null
  currency: CurrencyCode
  asOfDate: string
}): HoldingNavField {
  const [draft, setDraft] = React.useState<{
    id: string
    value: string
  } | null>(null)
  const linked = instrumentId !== null && marketInstrumentId !== null

  const query = useHoldingNav({ instrumentId, asOfDate, enabled: linked })

  const descriptor = React.useMemo<HoldingNavDescriptor | null>(() => {
    if (instrumentId === null || avgUnitCostMinor === null) {
      return null
    }
    const result = query.data
    // Resolving = the request is on its way AND there is no FRESH answer yet.
    //
    // Two cases:
    //   * a fetch is in flight with no data of its own (first load, or a new
    //     day whose answer has not landed) — the previous day's NAV may still
    //     be there as PLACEHOLDER data;
    //   * the fetch is PAUSED (offline): the placeholder applies but
    //     `isFetching` is false, so the label must still say we are resolving.
    //
    // While resolving, `result` may be the PLACEHOLDER (the previous day's NAV
    // for this same instrument): it stays in the field, and only the label
    // moves on to the new day.
    const isResolving =
      query.isPlaceholderData || (query.isFetching && query.data === undefined)
    return describeHoldingNav({
      currency,
      status: result?.status ?? "none",
      priceMinor:
        result?.status === "nav" && result.priceMinor !== null
          ? BigInt(result.priceMinor)
          : null,
      asOf: result?.asOf ?? null,
      newestQuoteAsOf: result?.newestQuoteAsOf ?? null,
      requestedDate: asOfDate,
      fallbackPriceMinor:
        lastPriceMinor !== null
          ? BigInt(lastPriceMinor)
          : BigInt(avgUnitCostMinor),
      fallbackSource: lastPriceMinor !== null ? "last_price" : "avg_cost",
      linked,
      isLoading: isResolving,
      // A FAILED BACKGROUND REFETCH keeps the previous data in v5 (the query
      // goes to `error` WITH its data). Reporting that as "no NAV" would
      // silently reprice the trade the user is about to record — the cached
      // NAV stays on screen. A real error with NO data at all still gets the
      // honest "couldn't load NAV" label + the fallback.
      isError: linked && query.isError && query.data === undefined,
    })
  }, [
    instrumentId,
    avgUnitCostMinor,
    lastPriceMinor,
    linked,
    asOfDate,
    currency,
    query.isError,
    query.isFetching,
    query.isPlaceholderData,
    query.data,
  ])

  const defaultInput =
    descriptor === null
      ? ""
      : toDecimalString(descriptor.defaultPriceMinor, currency)

  // The draft only counts while it belongs to the CURRENT selection.
  const currentDraft =
    draft !== null && draft.id === selectionKey ? draft.value : null
  const value = currentDraft ?? defaultInput

  const onChange = React.useCallback(
    (raw: string) => {
      setDraft({ id: selectionKey, value: raw })
    },
    [selectionKey]
  )

  // Clearing the draft hands the field back to the CURRENT default — so a NAV
  // that arrives later still wins after a restore.
  const restore = React.useCallback(() => {
    setDraft(null)
  }, [])

  return {
    value,
    draft: currentDraft,
    isModified: currentDraft !== null && currentDraft !== defaultInput,
    descriptor,
    onChange,
    restore,
  }
}
