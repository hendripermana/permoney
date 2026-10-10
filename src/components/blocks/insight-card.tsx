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
import { isCurrencyCode } from "@/lib/data/currencies"
import type { Insight, InsightReport } from "@/lib/insights"
import { decodeMoney, formatMoney } from "@/lib/money"

// =============================================================================
// PER-227 — the one generic insight renderer (Design A surface).
//
// Pure presentation over the already-computed envelope: money is decoded from
// the wire string and formatted with the insight's own currency; every word
// (title / summary / detail) comes from the derivation, so this component
// never needs to know which insight it is showing. A new derivation needs no
// renderer change. Renders NOTHING when the report has no insights — a
// permanent empty card a user scrolls past every day is worse than no card
// (same rule as the PER-226 attention strip).
// =============================================================================

/** The first money metric is the headline figure; counts are supporting copy. */
function headlineMetric(insight: Insight) {
  return insight.metrics.find((metric) => metric.currency !== undefined) ?? null
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
  const pendingCount = insight.metrics.find(
    (metric) => metric.key === "fx_pending_count"
  )?.value

  return (
    <Card data-testid={`insight-${insight.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="size-5 text-emerald-500" aria-hidden />
          {insight.title}
        </CardTitle>
        <CardDescription>{insight.summary}</CardDescription>
        {insight.partial ? (
          <CardAction>
            <Badge
              variant="outline"
              className="gap-1 text-amber-600 dark:text-amber-400"
            >
              <TriangleAlert className="size-3" aria-hidden />
              {pendingCount && pendingCount !== "0"
                ? `${pendingCount} pending exchange rate`
                : "Exchange rate pending"}
            </Badge>
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
        {insight.detail ? (
          <span className="text-sm text-muted-foreground">
            {insight.detail}
          </span>
        ) : null}
      </CardContent>
    </Card>
  )
}
