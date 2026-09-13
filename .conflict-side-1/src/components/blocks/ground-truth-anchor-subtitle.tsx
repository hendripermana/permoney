import { useQuery } from "@tanstack/react-query"
import { format } from "date-fns"
import { getLatestGroundTruthAnchorFn } from "@/server/valuations"
import { formatCurrency } from "@/lib/currency"

// PER-267 / ADR-0043's PER-264 amendment, "UI surface" section — "The account
// page's balance also gains a subtitle stating its `ground_truth` anchor's
// date and value, so the number is self-explanatory rather than opaque."
//
// Declarative fetch via `useQuery` (no useEffect — no-use-effect rule),
// mirroring `PendingBalanceCorrectionBanner`'s `enabled: cashLike` shape
// exactly: `getLatestGroundTruthAnchorFn` already returns null for a tracked
// (`balanceSource="valuation"`) account or one with no live anchor, so this
// renders nothing in either case.
export function GroundTruthAnchorSubtitle({
  accountId,
  currency,
  cashLike,
}: Readonly<{
  accountId: string
  currency: string
  cashLike: boolean
}>) {
  const { data: anchor } = useQuery({
    queryKey: ["latestGroundTruthAnchor", accountId],
    queryFn: () => getLatestGroundTruthAnchorFn({ data: { accountId } }),
    enabled: cashLike,
  })

  if (!anchor) return null

  const anchorDateLabel = format(
    new Date(`${anchor.valuationDate}T00:00:00`),
    "d MMM yyyy"
  )
  const anchorValueLabel = formatCurrency(BigInt(anchor.value), currency)
  const transactionLabel =
    anchor.transactionsAfter === 1
      ? "1 transaksi tercatat sesudahnya"
      : `${anchor.transactionsAfter} transaksi tercatat sesudahnya`

  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="ground-truth-anchor-subtitle"
    >
      Direkonsiliasi {anchorDateLabel} → {anchorValueLabel}, {transactionLabel}
    </p>
  )
}
