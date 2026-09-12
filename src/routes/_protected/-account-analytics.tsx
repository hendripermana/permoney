import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import {
  Activity,
  Check,
  PiggyBank,
  Repeat,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Button } from "@/components/ui/button"
import {
  ACCOUNT_RANGES,
  type AccountRange,
  type BalancePoint,
  type CategorySlice,
} from "@/lib/account-analytics"
import {
  availableAfterReserve,
  reserveHealth,
  reserveLockedFraction,
} from "@/lib/account-reserve"
import { type IdleCashInsight } from "@/lib/account-idle-cash"
import {
  type AccountCashFlowForecast,
  type AccountCashFlowForecastPoint,
  type ForecastEvent,
} from "@/lib/account-cash-flow-forecast"
import { type AccountPerformance } from "@/lib/account-performance"
import {
  type AccountHealth,
  type FactorTone,
  type HealthBand,
} from "@/lib/account-health"
import { formatCurrency } from "@/lib/currency"
import { toDisplayNumber } from "@/lib/money"
import { type CurrencyCode } from "@/lib/data/currencies"
import { cn } from "@/lib/utils"

// PER-218 — presentational analytics for the account detail page. Pure props
// in, chart out. All numbers are pre-derived by the unit-tested helpers in
// src/lib/account-analytics.ts; this file only draws them.

export function RangeSelector({
  value,
  onChange,
}: Readonly<{ value: AccountRange; onChange: (r: AccountRange) => void }>) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border p-0.5">
      {ACCOUNT_RANGES.map((r) => (
        <Button
          key={r.value}
          type="button"
          size="sm"
          variant={r.value === value ? "secondary" : "ghost"}
          className="h-7 px-2.5 text-xs"
          aria-pressed={r.value === value}
          onClick={() => onChange(r.value)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  )
}

const balanceChartConfig = {
  balance: { label: "Balance", color: "var(--chart-2)" },
} satisfies ChartConfig

function compactAxisNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatChartDay(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function BalanceTrendChart({
  series,
  currency,
}: Readonly<{ series: ReadonlyArray<BalancePoint>; currency: string }>) {
  if (series.length < 2) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
        Not enough history yet to draw a trend.
      </div>
    )
  }
  return (
    <ChartContainer
      config={balanceChartConfig}
      className="aspect-auto h-[200px] w-full"
    >
      <AreaChart data={series as Array<BalancePoint>}>
        <defs>
          <linearGradient id="fillAccountBalance" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-balance)"
              stopOpacity={0.8}
            />
            <stop
              offset="95%"
              stopColor="var(--color-balance)"
              stopOpacity={0.1}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={40}
          tickFormatter={formatChartDay}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          tickFormatter={compactAxisNumber}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatChartDay(value as string)}
              formatter={(value) => formatCurrency(Number(value), currency)}
              indicator="dot"
            />
          }
        />
        <Area
          dataKey="balance"
          type="natural"
          fill="url(#fillAccountBalance)"
          stroke="var(--color-balance)"
        />
      </AreaChart>
    </ChartContainer>
  )
}

// PER-229 — investment/gold performance: market value vs cost basis → unrealized
// gain/loss + return %. Shown for valuation-tracked accounts. Green up / red down.
export function PerformancePanel({
  performance,
  currency,
}: Readonly<{ performance: AccountPerformance; currency: string }>) {
  const {
    marketValueMinor,
    costBasisMinor,
    gainMinor,
    isGain,
    isFlat,
    hasBasis,
  } = performance
  const toneText = isFlat
    ? "text-muted-foreground"
    : isGain
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-destructive"
  const pctStr =
    performance.returnPct === null
      ? null
      : `${performance.returnPct >= 0 ? "+" : ""}${(performance.returnPct * 100).toFixed(2)}%`
  const gainStr = `${isGain && !isFlat ? "+" : ""}${formatCurrency(gainMinor.toString(), currency)}`

  return (
    <div className="rounded-2xl border p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <TrendingUp className="size-3.5" aria-hidden />
        Performance
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {formatCurrency(marketValueMinor.toString(), currency)}
      </p>
      {hasBasis ? (
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          Cost {formatCurrency(costBasisMinor.toString(), currency)}
        </p>
      ) : null}
      {hasBasis ? (
        <p
          className={cn(
            "mt-2 flex items-center gap-1 text-sm font-medium tabular-nums",
            toneText
          )}
        >
          {isFlat ? null : isGain ? (
            <TrendingUp className="size-4 shrink-0" aria-hidden />
          ) : (
            <TrendingDown className="size-4 shrink-0" aria-hidden />
          )}
          <span>
            {gainStr}
            {pctStr ? ` (${pctStr})` : ""}
          </span>
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Record your cost — set the opening value at creation, or transfer
          money in as you buy — to see gain/loss and return.
        </p>
      )}
    </div>
  )
}

// PER-224 — account health: one 0–100 score that ALWAYS shows its breakdown.
// Summary of the safety signals (runway + buffer + integrity); never a black box.
const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  attention: "Needs attention",
  unknown: "Not enough data",
}

const HEALTH_BAND_TEXT: Record<HealthBand, string> = {
  excellent: "text-emerald-600 dark:text-emerald-400",
  good: "text-emerald-600 dark:text-emerald-400",
  fair: "text-amber-600 dark:text-amber-400",
  attention: "text-destructive",
  unknown: "text-muted-foreground",
}

const HEALTH_BAND_METER: Record<HealthBand, string> = {
  excellent: "bg-emerald-500",
  good: "bg-emerald-500/80",
  fair: "bg-amber-500",
  attention: "bg-destructive",
  unknown: "bg-muted-foreground/40",
}

const FACTOR_TEXT: Record<FactorTone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  caution: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
}

export function AccountHealthPanel({
  health,
}: Readonly<{ health: AccountHealth }>) {
  return (
    <div className="rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <Activity className="size-3.5" aria-hidden />
          Account health
        </p>
        {health.lowConfidence && health.score !== null ? (
          <span className="text-[10px] font-medium text-muted-foreground">
            Limited history
          </span>
        ) : null}
      </div>

      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums",
            HEALTH_BAND_TEXT[health.band]
          )}
        >
          {health.score === null ? "—" : health.score}
        </span>
        <span
          className={cn("text-sm font-medium", HEALTH_BAND_TEXT[health.band])}
        >
          {HEALTH_BAND_LABEL[health.band]}
        </span>
      </div>

      {health.score !== null ? (
        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
          role="presentation"
        >
          <div
            className={cn(
              "h-full rounded-full",
              HEALTH_BAND_METER[health.band]
            )}
            style={{ width: `${Math.max(health.score, 3)}%` }}
          />
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Add a reserve or a little transaction history to score this account.
        </p>
      )}

      {health.factors.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {health.factors.map((f) => (
            <li key={f.key} className="flex items-center gap-2 text-xs">
              {f.tone === "good" ? (
                <Check
                  className={cn("size-3.5 shrink-0", FACTOR_TEXT.good)}
                  aria-hidden
                />
              ) : (
                <TriangleAlert
                  className={cn("size-3.5 shrink-0", FACTOR_TEXT[f.tone])}
                  aria-hidden
                />
              )}
              <span className="text-foreground">{f.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// PER-217 — "safe to spend" panel: available (balance − reserve) with a gauge
// that splits the balance into its reserved floor and its free headroom. Shown
// on the detail hero only when a reserve is set. Pure props in; the reserve math
// is the unit-tested helpers in src/lib/account-reserve.ts.
export function SafeToSpendPanel({
  balanceMinor,
  reserveMinor,
  currency,
}: Readonly<{ balanceMinor: bigint; reserveMinor: bigint; currency: string }>) {
  const available = availableAfterReserve(balanceMinor, reserveMinor)
  const health = reserveHealth(balanceMinor, reserveMinor)
  const lockedPct = Math.round(
    reserveLockedFraction(balanceMinor, reserveMinor) * 100
  )
  const belowFloor = health === "below"
  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        belowFloor ? "border-destructive/40 bg-destructive/5" : undefined
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <ShieldCheck className="size-3.5" aria-hidden />
          Safe to spend
        </p>
        {belowFloor ? (
          <span className="text-[10px] font-medium text-destructive">
            Below reserve
          </span>
        ) : health === "near" ? (
          <span className="text-[10px] font-medium text-muted-foreground">
            Near reserve
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          belowFloor ? "text-destructive" : undefined
        )}
      >
        {formatCurrency(available.toString(), currency)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
        of {formatCurrency(balanceMinor.toString(), currency)} ·{" "}
        {formatCurrency(reserveMinor.toString(), currency)} reserved
      </p>
      <div
        className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        <div
          className={cn(
            "h-full",
            belowFloor ? "bg-destructive" : "bg-muted-foreground/40"
          )}
          style={{ width: `${lockedPct}%` }}
        />
        <div className="h-full flex-1 bg-primary/70" />
      </div>
    </div>
  )
}

// PER-223 — "idle cash" opportunity: cash that has sat above the reserve,
// untouched, all window. Opportunity tone (emerald), not an alarm. Renders
// nothing unless there is a material surplus, so the caller can mount it freely.
export function IdleCashNote({
  insight,
  currency,
}: Readonly<{ insight: IdleCashInsight; currency: string }>) {
  if (!insight.hasSurplus) return null
  const pct = Math.round(insight.fractionIdle * 100)
  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <PiggyBank className="size-3.5" aria-hidden />
        Idle cash
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        {formatCurrency(insight.idleSurplusMinor.toString(), currency)} sitting
        idle
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        About {pct}% of this account has stayed untouched above your reserve for
        the last {insight.windowDays}+ days — consider moving it somewhere it
        earns.
      </p>
    </div>
  )
}

// PER-263 fast-follow — "cash-flow forecast": ONE causal panel replacing the
// separate Runway (AccountRunwayNote) + Recurring (RecurringNote) panels on
// the account detail page. All the math (double-counting avoidance, overdue
// clamping, reserve-breach projection) lives in the pure, unit-tested
// account-cash-flow-forecast.ts; this section only draws it — pure headline
// copy is still kept out of JSX (describeForecastHeadline), matching the
// codebase's "pure logic, thin JSX" convention.
const forecastChartConfig = {
  historicalBalance: { label: "Balance", color: "var(--chart-2)" },
  forecastBalance: { label: "Forecast", color: "var(--chart-2)" },
} satisfies ChartConfig

interface CashFlowChartPoint {
  date: string
  historicalBalance: number | null
  forecastBalance: number | null
  events: ForecastEvent[]
}

function localIsoDayFor(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function buildCashFlowChartData(
  series: ReadonlyArray<BalancePoint>,
  forecast: AccountCashFlowForecast,
  currency: string
): CashFlowChartPoint[] {
  const historical: CashFlowChartPoint[] = series.map((p) => ({
    date: p.date,
    historicalBalance: p.balance,
    forecastBalance: null,
    events: [],
  }))
  // Bridge point: the last historical point ("today") also seeds the
  // forecast line so the dashed segment visually continues from the solid
  // one instead of starting from a gap.
  const last = historical[historical.length - 1]
  if (last) last.forecastBalance = last.historicalBalance

  const forecastPoints: CashFlowChartPoint[] = forecast.points.map((p) => ({
    date: localIsoDayFor(p.date),
    historicalBalance: null,
    forecastBalance: toDisplayNumber(
      p.projectedBalanceMinor,
      currency as CurrencyCode
    ),
    events: p.events,
  }))
  return [...historical, ...forecastPoints]
}

/**
 * Pure headline copy for the forecast panel. Never frames a dip as a "reserve
 * breach" unless the caller confirms a reserve is actually configured
 * (`hasReserveConfigured`) — see account-cash-flow-forecast.ts's file header
 * for why that gate lives here, in the presentation layer, and not baked into
 * `projectedReserveBreachDate` itself (the PR #341 bug this deliberately does
 * NOT repeat).
 */
function shortDateLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function describeForecastHeadline(
  forecast: AccountCashFlowForecast,
  opts: { hasReserveConfigured: boolean; currency: string }
): string {
  if (!forecast.hasRecurringSignal) {
    return "Not enough recurring history yet — showing plain runway"
  }

  // Already at/under the floor RIGHT NOW — a present-state fact, not a fresh
  // forecast finding (see account-cash-flow-forecast.ts's doc comment on
  // `alreadyAtOrBelowFloor`: without this branch, a zero-balance,
  // no-reserve-configured wallet would say "reaches zero tomorrow" every
  // single day it's opened, since it never meaningfully leaves that state —
  // the exact false-alarm pattern PR #341 already fixed once, recurring here
  // in a new feature if left unhandled).
  if (forecast.alreadyAtOrBelowFloor) {
    const recovery = forecast.projectedRecoveryDate
    if (!opts.hasReserveConfigured) {
      return recovery
        ? `Sitting at zero — recovers around ${shortDateLabel(recovery)}`
        : `Sitting at zero, with no recovery expected in the next ${forecast.horizonDays} days`
    }
    return recovery
      ? `Already below your reserve — recovers around ${shortDateLabel(recovery)}`
      : `Already below your reserve, with no recovery expected in the next ${forecast.horizonDays} days`
  }

  const breachDate = forecast.projectedReserveBreachDate
  if (breachDate === null) {
    return `Trending up — no dip expected in the next ${forecast.horizonDays} days`
  }
  const breachMs = breachDate.getTime()
  const dateLabel = shortDateLabel(breachDate)

  if (!opts.hasReserveConfigured) {
    return `Reaches zero around ${dateLabel} at this pace`
  }

  // Causal detail: the single biggest expense landing at/before the breach —
  // the thing "mainly" responsible for it — and the next inflow after it (if
  // any within the horizon) that would recover the balance.
  const eventsUpToBreach = forecast.points
    .filter((p) => p.date.getTime() <= breachMs)
    .flatMap((p) => p.events)
  const biggestExpense = eventsUpToBreach
    .filter((e) => e.direction === "out")
    .sort((a, b) =>
      b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0
    )[0]

  if (!biggestExpense) {
    return `Dips below reserve around ${dateLabel} at this pace`
  }

  const nextInflow = forecast.points
    .filter((p) => p.date.getTime() > breachMs)
    .flatMap((p) => p.events.map((event) => ({ event, date: p.date })))
    .find(({ event }) => event.direction === "in")

  const expenseLabel = `${biggestExpense.label} (${formatCurrency(biggestExpense.amountMinor, opts.currency)})`
  const inflowClause = nextInflow
    ? `, before ${nextInflow.event.label} lands ${shortDateLabel(nextInflow.date)}`
    : ""

  return `Dips below reserve around ${dateLabel}, mainly your ${expenseLabel}${inflowClause}`
}

function eventDotColor(events: ReadonlyArray<ForecastEvent>): string {
  const allIn = events.every((e) => e.direction === "in")
  if (allIn) return "var(--color-emerald-500)"
  const allOut = events.every((e) => e.direction === "out")
  if (allOut) return "var(--color-destructive)"
  return "var(--color-muted-foreground)"
}

export function AccountCashFlowForecastPanel({
  series,
  forecast,
  hasReserveConfigured,
  reserveMinor,
  currency,
}: Readonly<{
  series: ReadonlyArray<BalancePoint>
  forecast: AccountCashFlowForecast
  hasReserveConfigured: boolean
  reserveMinor: bigint
  currency: string
}>) {
  const chartData = React.useMemo(
    () => buildCashFlowChartData(series, forecast, currency),
    [series, forecast, currency]
  )
  const eventPoints = React.useMemo<AccountCashFlowForecastPoint[]>(
    () => forecast.points.filter((p) => p.events.length > 0),
    [forecast]
  )
  const upcoming = React.useMemo(
    () =>
      eventPoints
        .flatMap((p) => p.events.map((event) => ({ event, date: p.date })))
        .slice(0, 5),
    [eventPoints]
  )
  const headline = React.useMemo(
    () =>
      describeForecastHeadline(forecast, { hasReserveConfigured, currency }),
    [forecast, hasReserveConfigured, currency]
  )
  // Urgent styling for a genuinely NEW forecasted dip, or for being ALREADY
  // below a reserve the user actually configured — but not for a no-reserve
  // account already sitting at zero (its normal, expected resting state; see
  // describeForecastHeadline's "already at/below the floor" branch).
  const breach =
    forecast.projectedReserveBreachDate !== null ||
    (hasReserveConfigured && forecast.alreadyAtOrBelowFloor)
  const lowConfidence = forecast.points[0]?.lowConfidence ?? false

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "rounded-2xl border p-4",
          breach ? "border-destructive/40 bg-destructive/5" : undefined
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {breach ? (
              <TriangleAlert className="size-3.5" aria-hidden />
            ) : (
              <TrendingUp className="size-3.5" aria-hidden />
            )}
            Cash flow forecast
          </p>
          {lowConfidence ? (
            <span className="text-[10px] font-medium text-muted-foreground">
              Low confidence
            </span>
          ) : null}
        </div>
        <p
          className={cn(
            "mt-1 text-sm font-medium",
            breach ? "text-destructive" : "text-foreground"
          )}
        >
          {headline}
        </p>

        {chartData.length > 0 ? (
          <ChartContainer
            config={forecastChartConfig}
            className="mt-3 aspect-auto h-[200px] w-full"
          >
            <AreaChart data={chartData as Array<CashFlowChartPoint>}>
              <defs>
                <linearGradient
                  id="fillCashFlowHistorical"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor="var(--color-historicalBalance)"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-historicalBalance)"
                    stopOpacity={0.1}
                  />
                </linearGradient>
                <linearGradient
                  id="fillCashFlowForecast"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor="var(--color-forecastBalance)"
                    stopOpacity={0.35}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-forecastBalance)"
                    stopOpacity={0.02}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={40}
                tickFormatter={formatChartDay}
              />
              <YAxis
                width={44}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactAxisNumber}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatChartDay(value as string)}
                    formatter={(value, _name, _item, _index, payload) => {
                      if (value === null || value === undefined) return null
                      const point = payload as unknown as CashFlowChartPoint
                      return (
                        <div className="flex w-full flex-col gap-1">
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="text-muted-foreground">
                              Balance
                            </span>
                            <span className="font-mono font-medium text-foreground tabular-nums">
                              {formatCurrency(Number(value), currency)}
                            </span>
                          </div>
                          {point.events.map((e) => (
                            <div
                              key={`${e.seriesKey}-${e.dateConfidence}`}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span
                                className={
                                  e.direction === "in"
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : "text-foreground"
                                }
                              >
                                {e.label}
                                {e.dateConfidence === "overdue"
                                  ? " (overdue)"
                                  : ""}
                              </span>
                              <span className="font-mono tabular-nums">
                                {e.direction === "in" ? "+" : "−"}
                                {formatCurrency(e.amountMinor, currency)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )
                    }}
                    indicator="dot"
                  />
                }
              />
              {hasReserveConfigured ? (
                <ReferenceLine
                  y={toDisplayNumber(reserveMinor, currency as CurrencyCode)}
                  stroke="var(--color-destructive)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.6}
                />
              ) : null}
              <Area
                dataKey="historicalBalance"
                type="natural"
                fill="url(#fillCashFlowHistorical)"
                stroke="var(--color-historicalBalance)"
              />
              <Area
                dataKey="forecastBalance"
                type="natural"
                fill="url(#fillCashFlowForecast)"
                stroke="var(--color-forecastBalance)"
                strokeDasharray="5 5"
              />
              {eventPoints.map((p) => {
                const x = localIsoDayFor(p.date)
                const y = toDisplayNumber(
                  p.projectedBalanceMinor,
                  currency as CurrencyCode
                )
                return (
                  <ReferenceDot
                    key={`${x}-${p.events.map((e) => e.seriesKey).join(",")}`}
                    x={x}
                    y={y}
                    r={4}
                    fill={eventDotColor(p.events)}
                    stroke="var(--background)"
                    strokeWidth={1.5}
                  />
                )
              })}
            </AreaChart>
          </ChartContainer>
        ) : null}
      </div>

      {upcoming.length > 0 ? (
        <div className="rounded-2xl border p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Repeat className="size-3.5" aria-hidden />
            Upcoming
          </p>
          <ul className="mt-2 flex flex-col gap-2.5">
            {upcoming.map(({ event, date }, i) => (
              <li
                key={`${event.seriesKey}-${i}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">
                    {event.label}
                    {event.dateConfidence === "overdue" ? (
                      <span className="ml-1.5 text-[10px] font-medium text-destructive">
                        Overdue
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {date.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    event.direction === "in"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-foreground"
                  )}
                >
                  {event.direction === "in" ? "+" : "−"}
                  {formatCurrency(event.amountMinor, currency)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function CategoryBreakdown({
  slices,
  currency,
}: Readonly<{ slices: ReadonlyArray<CategorySlice>; currency: string }>) {
  if (slices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No spending to break down in this range.
      </p>
    )
  }
  const max = slices.reduce((m, s) => (s.total > m ? s.total : m), 1n)
  return (
    <ul className="flex flex-col gap-2.5">
      {slices.map((slice) => {
        const pct = Number((slice.total * 100n) / max)
        return (
          <li key={slice.name} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  // Category colour is dynamic data, not a design token (same
                  // exception used across the app for category dots).
                  style={{
                    backgroundColor: slice.color ?? "var(--muted-foreground)",
                  }}
                />
                <span className="truncate">{slice.name}</span>
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatCurrency(slice.total, currency)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
