import { useQuery } from "@tanstack/react-query"
import { format } from "date-fns"
import { getAccountOpeningAsOfFn } from "@/server/valuations"
import { formatCurrency } from "@/lib/currency"

// PER-269 — Opening balance "as of" subtitle.
//
// Mirrors `GroundTruthAnchorSubtitle` (src/components/blocks/ground-truth-anchor-subtitle.tsx)
// in query pattern, placement, and styling: a declarative `useQuery` (no useEffect)
// that renders a muted `text-xs` line near the balance. While that component
// surfaces a `ground_truth` reconciliation anchor, this one surfaces the opening
// valuation's `valuationDate` when the account was created with a PAST as-of date
// — so the number is self-explanatory ("my balance on that day was X, before the
// transactions you see below it") rather than opaque. Provenance stays `derived`
// (ADR-0043 amendment), so no balance semantics change here — this is pure
// ergonomics.
//
// Renders nothing for:
//   - a tracked (`valuation`-sourced) account with no meaningful opening anchor;
//     the balance is latest-valuation-driven, not opening-driven (left enabled for
//     both sources so the signal is still there for INVESTMENT opening values, but
//     hidden when the anchor date is today — the common default).
//   - an opening dated today (the default case — identical to current behavior);
//     showing "as of today" adds no information.
//   - any fetch error or missing opening row.
export function OpeningAsOfSubtitle({
  accountId,
  currency,
}: Readonly<{
  accountId: string
  currency: string
}>) {
  const { data: opening } = useQuery({
    queryKey: ["accountOpeningAsOf", accountId],
    queryFn: () => getAccountOpeningAsOfFn({ data: { accountId } }),
  })

  if (!opening || !opening.valuationDate || !opening.value) return null

  const today = new Date().toISOString().slice(0, 10)
  // Only surface a PAST as-of date — today is the default that needs no callout.
  if (opening.valuationDate >= today) return null

  const anchorDateLabel = format(
    new Date(`${opening.valuationDate}T00:00:00`),
    "d MMM yyyy"
  )
  const anchorValueLabel = formatCurrency(BigInt(opening.value), currency)

  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="opening-as-of-subtitle"
    >
      Opening balance as of {anchorDateLabel} — {anchorValueLabel}
    </p>
  )
}
