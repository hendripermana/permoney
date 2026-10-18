import { PiggyBank, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { isCurrencyCode } from "@/lib/data/currencies"
import type { Insight, InsightMetric, InsightReport } from "@/lib/insights"
import { decodeMoney, formatMoney } from "@/lib/money"

// =============================================================================
// PER-227 — the one generic insight renderer (Design A surface).
//
// Pure presentation over the already-computed envelope: money is decoded from
// the wire string and formatted with the insight's own currency; every word
// (title / summary / detail / metric labels) comes from the derivation, so this
// component never needs to know which insight it is showing. A new derivation
// needs no renderer change. Renders NOTHING when the report has no insights — a
// permanent empty card a user scrolls past every day is worse than no card
// (same rule as the PER-226 attention strip).
// =============================================================================

/** The first money metric is the headline figure; counts are supporting copy. */
function headlineMetric(insight: Insight) {
  return insight.metrics.find((metric) => metric.currency !== undefined) ?? null
}

/** Labelled metrics AFTER the headline render as supporting lines ("Spent:
 * Rp …"). Unlabelled metrics stay wire-only (the partial badge reads
 * `fx_pending_count` itself), and the headline is never repeated by label. */
function supportingMetrics(
  insight: Insight,
  headline: InsightMetric | null
): InsightMetric[] {
  return insight.metrics.filter(
    (metric) => metric !== headline && metric.label !== undefined
  )
}

function formatWire(wire: string, currency: string): string {
  const money = decodeMoney(wire)
  if (!isCurrencyCode(currency)) return money.toString()
  return formatMoney(money, currency)
}

export function InsightCard({ report }: { report: InsightReport }) {
  if (report.insights.length === 0) return null

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {report.insights.map((insight) => (
        <InsightCardItem key={insight.id} insight={insight} />
      ))}
    </div>
  )
}

function InsightCardItem({ insight }: { insight: Insight }) {
  const headline = headlineMetric(insight)
  const supporting = supportingMetrics(insight, headline)

  return (
    <Card data-testid={`insight-${insight.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="size-5 text-emerald-500" aria-hidden />
          {insight.title}
        </CardTitle>
        <CardDescription>{insight.summary}</CardDescription>
        {insight.periodPartial || insight.fxPendingCount > 0 ? (
          <CardAction>
            <div className="flex flex-wrap justify-end gap-1">
              {insight.periodPartial ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="gap-1 text-amber-600 dark:text-amber-400"
                      data-testid={`insight-${insight.id}-period-partial`}
                    >
                      <TriangleAlert className="size-3" aria-hidden />
                      Partially recorded period
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="flex flex-col gap-1">
                      {insight.periodGaps.map((gap) => (
                        <span key={`${gap.accountId}:${gap.fromDate}`}>
                          {gap.accountName}:{" "}
                          {formatWire(gap.amount, gap.currency)} not recorded
                          between {gap.fromDate} and {gap.toDate}
                        </span>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {/* Keys off the COUNT, not `partial`: `partial` also means "the
                  month is still in progress" (slice #5), which has nothing to
                  do with exchange rates — the days-elapsed copy explains that
                  one on the card itself. */}
              {insight.fxPendingCount > 0 ? (
                <Badge
                  variant="outline"
                  className="gap-1 text-amber-600 dark:text-amber-400"
                >
                  <TriangleAlert className="size-3" aria-hidden />
                  {insight.fxPendingCount} pending exchange rate
                </Badge>
              ) : null}
            </div>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {headline ? (
          <span
            className="text-3xl font-semibold tabular-nums"
            data-testid={`insight-${insight.id}-value`}
          >
            {formatWire(headline.value, headline.currency ?? "")}
          </span>
        ) : null}
        {supporting.length > 0 ? (
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {supporting.map((metric) => (
              <span
                key={metric.key}
                data-testid={`insight-${insight.id}-metric-${metric.key}`}
              >
                {metric.label}:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {metric.currency
                    ? formatWire(metric.value, metric.currency)
                    : metric.value}
                </span>
              </span>
            ))}
          </span>
        ) : null}
        {insight.detail ? (
          <span className="text-sm text-muted-foreground">
            {insight.detail}
          </span>
        ) : null}
      </CardContent>
    </Card>
  )
}
