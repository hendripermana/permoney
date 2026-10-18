import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Newspaper } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { InsightDigest } from "@/components/blocks/insight-digest"
import { LoadErrorCard } from "@/components/blocks/load-error-card"
import { SiteHeader } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  digestNavMonth,
  digestQueryKey,
  familyCurrentMonth,
  formatDigestMonthLabel,
  isNextMonthDisabled,
  parseDigestSearch,
  viewedMonthOf,
  type DigestSearch,
} from "@/lib/digest"
import type { InsightReport } from "@/lib/insights"
import { getInsightsFn } from "@/server/insights"

// =============================================================================
// PER-227 — the in-app insights digest (`/digest`). The monthly view of the
// household insights engine (ADR-0059), driven entirely by `?month=YYYY-MM`:
// the month lives in the URL (shareable, reload-stable), never in component
// state, so there is no state→URL sync and no `useEffect` in this slice.
//
// Server seam is UNTOUCHED: `getInsightsFn` already accepts the optional
// `month` (ADR-0059 §6, "for the digest"). An absent or invalid month is
// omitted from the call so the engine resolves "the family's current month"
// in the FAMILY timezone server-side (ADR-0037 / PER-263) — the client never
// computes it from the device clock. A hand-typed FUTURE `?month=` is honored
// as-is: no clamping, no redirect, no normalization — the engine renders its
// honest skip reasons ("the requested month has not started yet" among them)
// and the Next button (UI guidance only) is disabled at/after the family's
// current month.
//
// Cache coherency: the query key extends the resync hub's
// `["dashboard", "insights"]` prefix (src/lib/collections.ts), so every
// post-mutation `invalidateQueries` covers each month's digest entry by
// prefix matching — a digest can never show a pre-mutation ledger answer.
//
// `ssr: false` per house convention for insight surfaces (dashboard.tsx).
// There is deliberately NO loader: a loader exists on routes that read TanStack
// DB collections (transactions, dashboard's attention strip) because
// `useLiveQuery` must preload before render. This page reads one server fn
// through TanStack Query — `useQuery` handles loading/error declaratively, the
// same pattern pit-stop.tsx uses. Loading renders skeletons (never a previous
// month's figures under the new month's label — money must not flash stale);
// error renders the shared retry card.
// =============================================================================

export const Route = createFileRoute("/_protected/digest")({
  // Property order here is inference-sensitive (TanStack Router's
  // create-route-property-order rule): validateSearch before ssr before
  // loader — see transactions.tsx / dashboard.tsx for the same convention.
  // The validator is the pure, unit-tested `parseDigestSearch` (src/lib/
  // digest.test.ts): an invalid `?month=` degrades to the server-resolved
  // default month instead of throwing mid-navigation — the dashboard's
  // hand-rolled safeParse pattern, chosen over `zodValidator` (which `parse`s
  // and would throw on a hand-typed `?month=garbage`) because this page must
  // render that state HONESTLY, not error out of it.
  validateSearch: (search: Record<string, unknown>): DigestSearch =>
    parseDigestSearch(search),
  ssr: false,
  staticData: { title: "Digest" },
  component: DigestPage,
})

function DigestPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  // Key lives under the resync hub's prefix — see the header comment. The
  // month param reaches the server ONLY when the URL carried a valid one.
  const insights = useQuery({
    queryKey: digestQueryKey(search.month),
    queryFn: async () =>
      await getInsightsFn({
        data: search.month ? { month: search.month } : {},
      }),
  })

  const goToMonth = (month: string | undefined) => {
    void navigate({ search: { month } })
  }

  return (
    <TooltipProvider>
      <SidebarProvider className="[--sidebar-width:calc(var(--spacing)*72)]!">
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            {/* The page title ("Digest") is the SiteHeader's <h1>, fed by the
                route's staticData — the pit-stop.tsx convention. */}
            <div className="flex items-center gap-3">
              <Newspaper className="size-6 text-emerald-500" aria-hidden />
              <p className="text-sm text-muted-foreground">
                What Permoney knows about this month — savings, bills due, and
                how spending compares — computed from your ledger.
              </p>
            </div>

            {insights.isLoading ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-12 w-full rounded-2xl" />
                <Skeleton className="h-48 w-full rounded-2xl" />
              </div>
            ) : insights.isError || insights.data === undefined ? (
              <LoadErrorCard
                label="your digest"
                isRetrying={insights.isFetching}
                onRetry={insights.refetch}
              />
            ) : (
              <DigestLoaded report={insights.data} onNavigate={goToMonth} />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

/** Everything month-related derives from the REPORT the server returned —
 * never from `new Date()`'s zone: the viewed month is the one the server
 * actually folded (`report.window`), and the family's current month borrows
 * only the timezone from the report (see src/lib/digest.ts). */
function DigestLoaded({
  report,
  onNavigate,
}: {
  report: InsightReport
  onNavigate: (month: string | undefined) => void
}) {
  const viewedMonth = viewedMonthOf(report)
  const nextDisabled = isNextMonthDisabled(
    viewedMonth,
    familyCurrentMonth(report, new Date())
  )

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="digest-month">Month</Label>
          {/* Clearing the input returns to the server-resolved default month;
              the URL never carries an empty `month=`. */}
          <Input
            id="digest-month"
            type="month"
            value={viewedMonth}
            className="w-44"
            onChange={(event) => onNavigate(event.target.value || undefined)}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums">
            {formatDigestMonthLabel(viewedMonth)}
          </span>
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => onNavigate(digestNavMonth(viewedMonth, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          {/* Disabled at (or past) the family's current month: the engine
              refuses not-yet-started months with its own skip reason, so the
              button is honest UI guidance — never a data constraint, and never
              a substitute for clamping (there is none). */}
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            disabled={nextDisabled}
            onClick={() => onNavigate(digestNavMonth(viewedMonth, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <InsightDigest report={report} />
    </>
  )
}
