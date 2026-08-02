import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

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
import { formatCurrency } from "@/lib/currency"

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
              labelFormatter={(value) => formatChartDay(String(value))}
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
