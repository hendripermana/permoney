import * as React from "react"
import {
  PiggyBank,
  Tags,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wallet,
} from "lucide-react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis } from "recharts"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { CurrencyCode } from "@/lib/data/currencies"
import { decodeMoney, formatMoney, toDisplayNumber } from "@/lib/money"
import type {
  CashFlowReportResult,
  NetWorthSeriesResult,
  SerializedCashFlowCategoryGroup,
} from "@/server/reporting"
import type {
  SerializedBudgetProgress,
  SerializedExpenseCategory,
} from "@/server/budgets"

// =============================================================================
// PER-156 / R3 — Dashboard realization.
//
// PURE rendering layer over the reporting engines: R1 net-worth series, R2
// cash-flow report, P1 budget progress. NO analytics math lives here — every
// figure is read from the server-fn output. The only client-side work is
// presentation: decoding wire money (minor-unit bigint strings) for display,
// mapping series to chart-friendly display numbers (memoized), and ordering the
// top expense categories. KPIs come straight off `totals`, so there is no heavy
// per-render recompute (CLAUDE.md §5C). FX-pending rows are surfaced via
// "unconverted / partial" badges, never hidden.
// =============================================================================

/** Exact display string from a wire money value (minor-unit bigint string). */
function formatWire(wire: string, currency: CurrencyCode): string {
  return formatMoney(decodeMoney(wire), currency)
}

/** Wire money → display number (major units) for plotting on a chart axis. */
function toChartNumber(wire: string, currency: CurrencyCode): number {
  return toDisplayNumber(decodeMoney(wire), currency)
}

function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

// ─── Top expense categories — pure ordering helper (unit-tested) ─────────────
export interface TopCategoryRow {
  categoryId: string | null
  name: string
  /** Positive expense magnitude as a wire string (minor-unit bigint). */
  expense: string
}

/**
 * Top expense categories for the period, ordered by spend descending. Pure
 * presentation ordering over R2's `byCategory` — no money math, only a bigint
 * compare and a name lookup. `categoryId === null` renders as "Uncategorized".
 */
export function selectTopExpenseCategories(
  byCategory: ReadonlyArray<SerializedCashFlowCategoryGroup>,
  nameById: ReadonlyMap<string, string>,
  limit: number
): TopCategoryRow[] {
  return byCategory
    .filter((group) => decodeMoney(group.expense) > 0n)
    .sort((a, b) => {
      const delta = decodeMoney(b.expense) - decodeMoney(a.expense)
      return delta > 0n ? 1 : delta < 0n ? -1 : 0
    })
    .slice(0, limit)
    .map((group) => ({
      categoryId: group.categoryId,
      name:
        group.categoryId === null
          ? "Uncategorized"
          : (nameById.get(group.categoryId) ?? "Unknown category"),
      expense: group.expense,
    }))
}

// ─── Shared bits ─────────────────────────────────────────────────────────────
function PartialBadge({ count }: { count?: number }) {
  return (
    <Badge
      variant="outline"
      className="gap-1 text-amber-600 dark:text-amber-400"
    >
      <TriangleAlert className="size-3" aria-hidden />
      {typeof count === "number" && count > 0
        ? `${count} unconverted`
        : "Partial — FX pending"}
    </Badge>
  )
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: string
  tone?: "default" | "positive" | "negative"
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "negative" && "text-destructive",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400"
        )}
      >
        {value}
      </span>
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

// ─── Net worth (R1) ──────────────────────────────────────────────────────────
const netWorthChartConfig = {
  netWorth: { label: "Net worth", color: "var(--chart-2)" },
} satisfies ChartConfig

export function NetWorthCard({ data }: { data: NetWorthSeriesResult }) {
  const base = data.baseCurrency as CurrencyCode
  const points = data.points
  const last = points.at(-1)
  const first = points.at(0)

  const chartData = React.useMemo(
    () =>
      points.map((point) => ({
        date: point.date,
        netWorth: toChartNumber(point.netWorth, base),
      })),
    [points, base]
  )

  // Headline KPIs derived from the already-computed endpoints (no recompute).
  const { headline, delta } = React.useMemo(() => {
    if (!last) return { headline: null as string | null, delta: 0 }
    const lastNum = toChartNumber(last.netWorth, base)
    const firstNum = first ? toChartNumber(first.netWorth, base) : lastNum
    return {
      headline: formatWire(last.netWorth, base),
      delta: lastNum - firstNum,
    }
  }, [last, first, base])

  const isPartial =
    (last?.isPartial ?? false) || (last?.unconverted.length ?? 0) > 0

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Wallet className="size-4" aria-hidden />
          Net worth in base currency ({data.baseCurrency})
        </CardDescription>
        <CardTitle
          className="text-3xl tabular-nums"
          data-testid="dashboard-net-worth-value"
        >
          {headline ?? "—"}
        </CardTitle>
        {headline ? (
          <CardAction>
            <Badge
              variant="outline"
              className={cn(
                "gap-1",
                delta >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive"
              )}
            >
              {delta >= 0 ? (
                <TrendingUp className="size-3" aria-hidden />
              ) : (
                <TrendingDown className="size-3" aria-hidden />
              )}
              {formatSignedNumber(delta, base)}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6">
        {points.length === 0 ? (
          <EmptyHint>
            No balances in this range yet. Add accounts and transactions to see
            your net worth over time.
          </EmptyHint>
        ) : (
          <>
            {isPartial ? (
              <div className="mb-2 px-2 sm:px-0">
                <PartialBadge count={last?.unconverted.length} />
              </div>
            ) : null}
            <ChartContainer
              config={netWorthChartConfig}
              className="aspect-auto h-[220px] w-full"
            >
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="fillNetWorth" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor="var(--color-netWorth)"
                      stopOpacity={0.8}
                    />
                    <stop
                      offset="95%"
                      stopColor="var(--color-netWorth)"
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
                  minTickGap={32}
                  tickFormatter={formatDay}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => formatDay(String(value))}
                      indicator="dot"
                    />
                  }
                />
                <Area
                  dataKey="netWorth"
                  type="natural"
                  fill="url(#fillNetWorth)"
                  stroke="var(--color-netWorth)"
                />
              </AreaChart>
            </ChartContainer>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Signed, human display of a delta number in the given currency. */
function formatSignedNumber(value: number, currency: CurrencyCode): string {
  const sign = value > 0 ? "+" : ""
  try {
    return `${sign}${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      notation: "compact",
    }).format(value)}`
  } catch {
    return `${sign}${value.toFixed(2)}`
  }
}

// ─── Cash flow (R2) ──────────────────────────────────────────────────────────
const cashFlowChartConfig = {
  income: { label: "Income", color: "var(--chart-2)" },
  expense: { label: "Expense", color: "var(--chart-4)" },
} satisfies ChartConfig

export function CashFlowCard({ data }: { data: CashFlowReportResult }) {
  const base = data.baseCurrency as CurrencyCode
  const { totals, series } = data

  const chartData = React.useMemo(
    () =>
      series.map((bucket) => ({
        label: bucket.periodStart,
        income: toChartNumber(bucket.income, base),
        expense: toChartNumber(bucket.expense, base),
      })),
    [series, base]
  )

  const netIsNegative = decodeMoney(totals.net) < 0n
  const hasData = series.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="size-5 text-emerald-500" aria-hidden />
          Cash flow
        </CardTitle>
        <CardDescription>
          Income vs expense for the selected period · base {data.baseCurrency}
        </CardDescription>
        {totals.unconvertedCount > 0 ? (
          <CardAction>
            <PartialBadge count={totals.unconvertedCount} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            label="Income"
            value={formatWire(totals.income, base)}
            tone="positive"
          />
          <Stat label="Expense" value={formatWire(totals.expense, base)} />
          <Stat
            label="Net cash flow"
            value={formatWire(totals.net, base)}
            tone={netIsNegative ? "negative" : "positive"}
          />
        </div>

        {hasData ? (
          <ChartContainer
            config={cashFlowChartConfig}
            className="aspect-auto h-[220px] w-full"
          >
            <BarChart data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={formatDay}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDay(String(value))}
                    indicator="dot"
                  />
                }
              />
              <Bar dataKey="income" fill="var(--color-income)" radius={4} />
              <Bar dataKey="expense" fill="var(--color-expense)" radius={4} />
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyHint>No income or expense recorded in this period.</EmptyHint>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Top categories (R2 byCategory) ──────────────────────────────────────────
export function TopCategoriesCard({
  data,
  categories,
  limit = 5,
}: {
  data: CashFlowReportResult
  categories: ReadonlyArray<SerializedExpenseCategory> | undefined
  limit?: number
}) {
  const base = data.baseCurrency as CurrencyCode

  const rows = React.useMemo(() => {
    const nameById = new Map<string, string>()
    for (const category of categories ?? [])
      nameById.set(category.id, category.name)
    return selectTopExpenseCategories(data.byCategory, nameById, limit)
  }, [data.byCategory, categories, limit])

  const max = React.useMemo(
    () =>
      rows.reduce(
        (acc, row) =>
          decodeMoney(row.expense) > acc ? decodeMoney(row.expense) : acc,
        0n
      ),
    [rows]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tags className="size-5 text-emerald-500" aria-hidden />
          Top spending categories
        </CardTitle>
        <CardDescription>
          Where your money went this period · base {data.baseCurrency}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyHint>No categorized spending in this period yet.</EmptyHint>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const pct =
                max > 0n ? Number((decodeMoney(row.expense) * 100n) / max) : 0
              return (
                <li
                  key={row.categoryId ?? "uncategorized"}
                  className="flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{row.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatWire(row.expense, base)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Budget progress (P1) ────────────────────────────────────────────────────
function spendPercent(actualWire: string, allocatedWire: string): number {
  const allocated = Number(allocatedWire)
  if (allocated <= 0) return 0
  return Math.min(100, Math.round((Number(actualWire) / allocated) * 100))
}

export function BudgetProgressCard({
  progress,
  limit = 5,
}: {
  progress: SerializedBudgetProgress
  limit?: number
}) {
  const currency = progress.currency as CurrencyCode
  const { totals, categories } = progress
  const topCategories = React.useMemo(
    () => categories.slice(0, limit),
    [categories, limit]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="size-5 text-emerald-500" aria-hidden />
          Budget progress
          {totals.isOver ? (
            <Badge variant="destructive">Over budget</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {progress.name} · {progress.periodStart} → {progress.periodEnd}
        </CardDescription>
        {totals.pendingTransactionCount > 0 ? (
          <CardAction>
            <PartialBadge count={totals.pendingTransactionCount} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            label="Budgeted"
            value={formatWire(totals.allocatedAmount, currency)}
          />
          <Stat
            label="Spent"
            value={formatWire(totals.actualAmount, currency)}
          />
          <Stat
            label="Remaining"
            value={formatWire(totals.remainingAmount, currency)}
            tone={totals.isOver ? "negative" : "default"}
          />
        </div>

        {topCategories.length === 0 ? (
          <EmptyHint>
            No category allocations yet. Set some on the Budgets page to start
            tracking.
          </EmptyHint>
        ) : (
          <ul className="flex flex-col gap-3">
            {topCategories.map((category) => (
              <li key={category.categoryId} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: category.categoryColor }}
                      aria-hidden
                    />
                    {category.categoryName}
                  </span>
                  <span
                    className={cn(
                      "text-muted-foreground tabular-nums",
                      category.isOver && "text-destructive"
                    )}
                  >
                    {formatWire(category.actualAmount, currency)} /{" "}
                    {formatWire(category.allocatedAmount, currency)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      category.isOver ? "bg-destructive" : "bg-emerald-500"
                    )}
                    style={{
                      width: `${spendPercent(category.actualAmount, category.allocatedAmount)}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
