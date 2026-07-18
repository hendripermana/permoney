import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import {
  LayoutDashboard,
  Plus,
  RefreshCw,
  TriangleAlert,
  Upload,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PermoneyDateRangePicker } from "@/components/ui/date-range-picker"
import {
  BudgetProgressCard,
  CashFlowCard,
  NetWorthCard,
  TopCategoriesCard,
} from "@/components/blocks/dashboard-cards"
import { getCashFlowReportFn, getNetWorthSeriesFn } from "@/server/reporting"
import { getBudgetForPeriodFn, listExpenseCategoriesFn } from "@/server/budgets"
import { getAccountsFn } from "@/server/accounts"

// =============================================================================
// PER-156 / R3 — Dashboard realization (rendering layer only).
//
// `/dashboard` wires the reporting engines (R1 net worth, R2 cash flow, P1
// budget progress) to one shared period selector that is the single source of
// truth for every card. The selection (`from` / `to` / `interval`) lives in the
// TanStack Router search params, so the view is persistent on reload and
// shareable by URL. `ssr: false` — these reads call server fns from the client
// via TanStack Query, mirroring the budgets route; no TanStack DB collection is
// touched here, so no loader preload is required. Budget progress is monthly, so
// it tracks the month of the period's end date.
// =============================================================================

const intervalSchema = z.enum(["day", "week", "month"])
type Interval = z.infer<typeof intervalSchema>

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const dashboardSearchSchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  interval: intervalSchema.optional(),
})
type DashboardSearch = z.infer<typeof dashboardSearchSchema>

export const Route = createFileRoute("/_protected/dashboard")({
  ssr: false,
  staticData: { title: "Dashboard" },
  validateSearch: (search: Record<string, unknown>): DashboardSearch => {
    const parsed = dashboardSearchSchema.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  component: DashboardPage,
})

/** Local-calendar YYYY-MM-DD (the user's clock, matching the date picker). */
function toDateOnly(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function DashboardPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  // Anchor the defaults once per mount so the query keys (and thus the fetched
  // range) stay stable across renders: last 6 months ending today.
  const [defaults] = React.useState(() => {
    const now = new Date()
    const fromDate = new Date(now)
    fromDate.setMonth(fromDate.getMonth() - 6)
    return { from: toDateOnly(fromDate), to: toDateOnly(now) }
  })

  const from = search.from ?? defaults.from
  const to = search.to ?? defaults.to
  const interval: Interval = search.interval ?? "month"
  // Budget periods are monthly; track the month the selected range ends in.
  const month = to.slice(0, 7)

  const netWorth = useQuery({
    queryKey: ["dashboard", "net-worth", from, to, interval],
    queryFn: async () =>
      await getNetWorthSeriesFn({ data: { from, to, interval } }),
  })
  const cashFlow = useQuery({
    queryKey: ["dashboard", "cash-flow", from, to, interval],
    queryFn: async () =>
      await getCashFlowReportFn({ data: { from, to, interval } }),
  })
  const budget = useQuery({
    queryKey: ["dashboard", "budget", month],
    queryFn: async () => await getBudgetForPeriodFn({ data: { month } }),
  })
  const categories = useQuery({
    queryKey: ["dashboard", "expense-categories"],
    queryFn: async () => await listExpenseCategoriesFn(),
  })
  // PER-183: a brand-new family has zero accounts (onboarding no longer
  // seeds a demo one). Net worth/cash flow/budget cards are meaningless
  // against nothing, so a fresh user gets a clear next step instead of a
  // wall of empty charts.
  const accountsQuery = useQuery({
    queryKey: ["dashboard", "accounts"],
    queryFn: async () => await getAccountsFn(),
  })
  const hasNoAccounts = accountsQuery.data?.length === 0

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 72)",
          } as React.CSSProperties
        }
      >
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex items-center gap-3">
                <LayoutDashboard
                  className="size-6 text-emerald-500"
                  aria-hidden
                />
                <div>
                  <h1 className="text-xl font-semibold">Dashboard</h1>
                  <p className="text-sm text-muted-foreground">
                    Your net worth, cash flow, and budget — all in your base
                    currency for the selected period.
                  </p>
                </div>
              </div>
              {hasNoAccounts ? null : (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="grid gap-1.5">
                    <Label>Period</Label>
                    <PermoneyDateRangePicker
                      date={{
                        from: parseDateOnly(from),
                        to: parseDateOnly(to),
                      }}
                      onUpdate={(range) => {
                        if (!range?.from || !range?.to) return
                        void navigate({
                          search: {
                            from: toDateOnly(range.from),
                            to: toDateOnly(range.to),
                            interval,
                          },
                        })
                      }}
                      className="w-[260px]"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Interval</Label>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={interval}
                      onValueChange={(value) => {
                        if (!value) return
                        void navigate({
                          search: { from, to, interval: value as Interval },
                        })
                      }}
                    >
                      <ToggleGroupItem value="day">Day</ToggleGroupItem>
                      <ToggleGroupItem value="week">Week</ToggleGroupItem>
                      <ToggleGroupItem value="month">Month</ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                </div>
              )}
            </div>

            {hasNoAccounts ? (
              <DashboardEmptyState />
            ) : (
              <>
                <Section
                  query={netWorth}
                  skeletonHeight="h-[300px]"
                  label="net worth"
                >
                  {(data) => <NetWorthCard data={data} />}
                </Section>

                <div className="grid gap-6 lg:grid-cols-2">
                  <Section
                    query={cashFlow}
                    skeletonHeight="h-[360px]"
                    label="cash flow"
                  >
                    {(data) => <CashFlowCard data={data} />}
                  </Section>
                  <Section
                    query={cashFlow}
                    skeletonHeight="h-[360px]"
                    label="top categories"
                  >
                    {(data) => (
                      <TopCategoriesCard
                        data={data}
                        categories={categories.data}
                      />
                    )}
                  </Section>
                </div>

                <Section
                  query={budget}
                  skeletonHeight="h-[360px]"
                  label="budget progress"
                >
                  {(data) => <BudgetProgressCard progress={data} />}
                </Section>
              </>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

interface SectionQuery<TData> {
  data: TData | undefined
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  error: unknown
  refetch: () => void
}

function DashboardEmptyState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
        <LayoutDashboard
          className="size-10 text-muted-foreground"
          aria-hidden
        />
        <div className="max-w-sm">
          <p className="text-lg font-medium">Nothing tracked yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add an account to start seeing your net worth, cash flow, and budget
            here.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link to="/accounts">
              <Plus className="size-4" />
              Add your first account
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/import/sure">
              <Upload className="size-4" />
              Moving from Sure? Import your data
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Section<TData>({
  query,
  children,
  skeletonHeight,
  label,
}: {
  query: SectionQuery<TData>
  children: (data: TData) => React.ReactNode
  skeletonHeight: string
  label: string
}) {
  if (query.isLoading) {
    return <Skeleton className={`w-full ${skeletonHeight} rounded-xl`} />
  }
  if (query.isError || query.data === undefined) {
    return (
      <SectionError
        label={label}
        message={
          query.error instanceof Error
            ? query.error.message
            : `Something went wrong loading ${label}.`
        }
        isRetrying={query.isFetching}
        onRetry={query.refetch}
      />
    )
  }
  return <>{children(query.data)}</>
}

function SectionError({
  label,
  message,
  isRetrying,
  onRetry,
}: {
  label: string
  message: string
  isRetrying: boolean
  onRetry: () => void
}) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-5" aria-hidden />
          Couldn&apos;t load {label}
        </CardTitle>
        <CardDescription>
          If you just pulled this branch, make sure the database migrations have
          run (<code>vp run db:migrate</code>).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-3 rounded-md bg-destructive/10 p-3 font-mono text-sm text-destructive">
          {message}
        </p>
        <Button
          variant="outline"
          className="w-fit"
          disabled={isRetrying}
          onClick={onRetry}
        >
          <RefreshCw className="size-4" aria-hidden />
          {isRetrying ? "Retrying…" : "Retry"}
        </Button>
      </CardContent>
    </Card>
  )
}
