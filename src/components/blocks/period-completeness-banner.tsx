import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { formatCurrency } from "@/lib/currency"
import { decodeMoney } from "@/lib/money"
import { getPeriodCompletenessFn } from "@/server/valuations"

// =============================================================================
// PER-443 — "partially recorded period" notice for a report window.
//
// The net-worth / cash-flow numbers over a window that contains an
// anchor-chain hole are UNDERSTATED: activity happened (money moved between two
// balance assertions) but was never recorded. Instead of a silent smaller
// number, the dashboard says so: which account, which window, and how much.
//
// The honesty line matters: the BALANCE is still correct (it comes from the
// latest anchor) — only HISTORY is incomplete. The gap can only be closed by
// recording the missing activity; the account link is the entry point.
//
// `from`/`to` mirror the page's picker: both unset means the server resolves
// the family-tz default range, exactly like the other report queries.
// =============================================================================

export function PeriodCompletenessBanner({
  from,
  to,
}: Readonly<{ from?: string; to?: string }>) {
  const { data } = useQuery({
    queryKey: ["dashboard", "completeness", from ?? "default", to ?? "default"],
    queryFn: async () => await getPeriodCompletenessFn({ data: { from, to } }),
  })

  if (!data || data.gaps.length === 0) return null

  const shown = data.gaps.slice(0, 2)
  const rest = data.gaps.length - shown.length

  return (
    <Card
      className="border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20"
      data-testid="period-completeness-banner"
    >
      <CardContent className="flex items-start gap-3 py-4">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            Partially recorded period — figures for this window may be
            understated.
          </p>
          <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
            {shown.map((gap) => (
              <li key={`${gap.accountId}:${gap.fromDate}`}>
                <Link
                  to="/accounts/$accountId"
                  params={{ accountId: gap.accountId }}
                  className="font-medium underline underline-offset-2"
                >
                  {gap.accountName}
                </Link>
                {": "}
                {formatCurrency(decodeMoney(gap.amount), gap.currency)} of
                activity between {gap.fromDate} and {gap.toDate} was never
                recorded.
              </li>
            ))}
            {rest > 0 ? <li>and {rest} more account(s).</li> : null}
          </ul>
          <p className="text-xs text-muted-foreground">
            The balance is still correct — the ledger just never saw that
            period&apos;s activity.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
