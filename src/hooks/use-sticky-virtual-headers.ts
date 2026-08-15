import * as React from "react"
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual"

// ═══════════════════════════════════════════════════════════════
// PER-241 revision — sticky date-group headers for a virtualized list.
//
// A virtualized list positions every row `absolute`, so a plain
// `position: sticky` header never sticks (its absolute siblings don't share a
// flow). The canonical TanStack Virtual fix: force the *active* group header —
// the last header at or above the first visible row — to always be part of the
// rendered window (via a custom `rangeExtractor`), then render that one header
// as `position: sticky; top: 0` instead of `translateY(...)`. As the user
// scrolls into the next group, the active header swaps and the new one pins.
//
// This hook is the shared seam so BOTH the /transactions ledger and the
// per-account statement pin their day headers identically. `headerIndexes` must
// be ascending (see `headerRowIndexes` in `lib/transaction-list.ts`).
// ═══════════════════════════════════════════════════════════════

export interface StickyVirtualHeaders {
  /** Feed to `useVirtualizer({ rangeExtractor })`. */
  rangeExtractor: (range: Range) => number[]
  /** True for the header index currently pinned at the top of the viewport. */
  isActiveSticky: (index: number) => boolean
}

export function useStickyVirtualHeaders(
  headerIndexes: ReadonlyArray<number>
): StickyVirtualHeaders {
  // A ref (not state) so updating the active header inside `rangeExtractor`
  // never triggers a re-render loop — the virtualizer re-runs the extractor on
  // every scroll frame, and the render reads the ref to style the pinned row.
  const activeStickyIndexRef = React.useRef<number>(-1)

  const rangeExtractor = React.useCallback(
    (range: Range): number[] => {
      // Ascending headerIndexes → the active header is the last one whose index
      // is at or above the first visible row.
      let active = -1
      for (const headerIndex of headerIndexes) {
        if (headerIndex <= range.startIndex) active = headerIndex
        else break
      }
      activeStickyIndexRef.current = active

      const next = new Set(defaultRangeExtractor(range))
      if (active >= 0) next.add(active)
      return [...next].sort((a, b) => a - b)
    },
    [headerIndexes]
  )

  const isActiveSticky = React.useCallback(
    (index: number): boolean => activeStickyIndexRef.current === index,
    []
  )

  return { rangeExtractor, isActiveSticky }
}
