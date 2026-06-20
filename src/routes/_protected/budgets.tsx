import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PiggyBank, TriangleAlert } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { CurrencyCode } from "@/lib/data/currencies"
import { decodeMoney, formatMoney, parseUserInput } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  getBudgetForPeriodFn,
  listExpenseCategoriesFn,
  setBudgetAllocationsFn,
  type SerializedBudgetProgress,
  type SerializedExpenseCategory,
} from "@/server/budgets"

export const Route = createFileRoute("/_protected/budgets")({
  ssr: false,
  staticData: { title: "Budgets" },
  component: BudgetsPage,
})

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

function formatWire(wire: string, currency: string): string {
  return formatMoney(decodeMoney(wire), currency as CurrencyCode)
}

function spendPercent(actualWire: string, allocatedWire: string): number {
  const allocated = Number(allocatedWire)
  if (allocated <= 0) return 0
  return Math.min(100, Math.round((Number(actualWire) / allocated) * 100))
}

function BudgetsPage() {
  const [month, setMonth] = React.useState<string>(currentMonth)

  const { data: progress, isLoading } = useQuery({
    queryKey: ["budget", month],
    queryFn: async () => await getBudgetForPeriodFn({ data: { month } }),
  })
  const { data: categories } = useQuery({
    queryKey: ["budget-expense-categories"],
    queryFn: async () => await listExpenseCategoriesFn(),
  })

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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <PiggyBank className="size-6 text-emerald-500" aria-hidden />
                <div>
                  <h1 className="text-xl font-semibold">Budgets</h1>
                  <p className="text-sm text-muted-foreground">
                    Set what you plan to spend per category, and track it
                    against your real ledger — normalized to your base currency.
                  </p>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="budget-month">Period</Label>
                <Input
                  id="budget-month"
                  type="month"
                  value={month}
                  className="w-44"
                  onChange={(event) => setMonth(event.target.value)}
                />
              </div>
            </div>

            {isLoading || !progress ? (
              <p className="text-sm text-muted-foreground">Loading budget…</p>
            ) : (
              <>
                <SummaryCard progress={progress} />
                <ProgressCard progress={progress} />
                <BudgetEditor
                  key={`${month}:${progress.budgetId ?? "new"}`}
                  month={month}
                  currency={progress.currency}
                  categories={categories ?? []}
                  progress={progress}
                />
              </>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function SummaryCard({ progress }: { progress: SerializedBudgetProgress }) {
  const { totals, currency } = progress
  const pending = totals.pendingTransactionCount
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {progress.name}
          {totals.isOver ? (
            <Badge variant="destructive">Over budget</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {progress.periodStart} → {progress.periodEnd} · base {currency}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Budgeted"
          value={formatWire(totals.allocatedAmount, currency)}
        />
        <Stat label="Spent" value={formatWire(totals.actualAmount, currency)} />
        <Stat
          label="Remaining"
          value={formatWire(totals.remainingAmount, currency)}
          tone={totals.isOver ? "negative" : "default"}
        />
        {pending > 0 ? (
          <p className="flex items-center gap-2 text-sm text-amber-600 sm:col-span-3 dark:text-amber-400">
            <TriangleAlert className="size-4" aria-hidden />
            {pending} transaction{pending === 1 ? "" : "s"} unconverted (no FX
            rate) — excluded from totals until a rate is added.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: string
  tone?: "default" | "negative"
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "negative" && "text-destructive"
        )}
      >
        {value}
      </span>
    </div>
  )
}

function ProgressCard({ progress }: { progress: SerializedBudgetProgress }) {
  const { categories, uncategorized, currency } = progress
  return (
    <Card>
      <CardHeader>
        <CardTitle>By category</CardTitle>
        <CardDescription>
          Spend is summed from cleared and pending ledger rows for this period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No category allocations yet. Set some below to start tracking.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Budgeted</TableHead>
                <TableHead className="text-right">Spent</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead className="w-40">Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) => (
                <TableRow key={category.categoryId}>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: category.categoryColor }}
                        aria-hidden
                      />
                      {category.categoryName}
                      {category.pendingCount > 0 ? (
                        <Badge variant="outline" className="text-amber-600">
                          {category.pendingCount} unconverted
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWire(category.allocatedAmount, currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWire(category.actualAmount, currency)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      category.isOver && "text-destructive"
                    )}
                  >
                    {formatWire(category.remainingAmount, currency)}
                  </TableCell>
                  <TableCell>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          category.isOver ? "bg-destructive" : "bg-emerald-500"
                        )}
                        style={{
                          width: `${spendPercent(
                            category.actualAmount,
                            category.allocatedAmount
                          )}%`,
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {Number(uncategorized.actualAmount) > 0 ||
        uncategorized.pendingCount > 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Uncategorized spend this period:{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatWire(uncategorized.actualAmount, currency)}
            </span>
            {uncategorized.pendingCount > 0
              ? ` (+${uncategorized.pendingCount} unconverted)`
              : ""}
            . Assign a category to budget it.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function BudgetEditor({
  month,
  currency,
  categories,
  progress,
}: {
  month: string
  currency: string
  categories: SerializedExpenseCategory[]
  progress: SerializedBudgetProgress
}) {
  const queryClient = useQueryClient()
  // Initialized once per period (the parent re-keys this component on month
  // change), so no effect is needed to sync from the query — see no-use-effect.
  const [inputs, setInputs] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const category of progress.categories) {
      if (Number(category.allocatedAmount) > 0) {
        initial[category.categoryId] = formatMoney(
          decodeMoney(category.allocatedAmount),
          currency as CurrencyCode,
          { showSymbol: false }
        )
      }
    }
    return initial
  })
  const [error, setError] = React.useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const allocations: { categoryId: string; allocatedAmount: string }[] = []
      for (const category of categories) {
        const raw = (inputs[category.id] ?? "").trim()
        if (raw === "") continue
        const parsed = parseUserInput(raw, currency as CurrencyCode)
        if (parsed === null) {
          throw new Error(`Invalid amount for ${category.name}`)
        }
        if (parsed <= 0n) continue
        allocations.push({
          categoryId: category.id,
          allocatedAmount: parsed.toString(),
        })
      }
      return await setBudgetAllocationsFn({
        data: { month, allocations, idempotencyKey: createUuidV7() },
      })
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["budget", month] })
    },
    onError: (mutationError: unknown) => {
      setError((mutationError as Error).message)
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set allocations</CardTitle>
        <CardDescription>
          Amounts are in your base currency ({currency}). Leave a category blank
          to remove its budget. Saving replaces this period's allocations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No expense categories yet. Create categories first.
          </p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {categories.map((category) => (
                <div key={category.id} className="grid gap-1.5">
                  <Label
                    htmlFor={`alloc-${category.id}`}
                    className="flex items-center gap-2"
                  >
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: category.color }}
                      aria-hidden
                    />
                    {category.name}
                  </Label>
                  <Input
                    id={`alloc-${category.id}`}
                    inputMode="decimal"
                    placeholder="0"
                    value={inputs[category.id] ?? ""}
                    onChange={(event) =>
                      setInputs((prev) => ({
                        ...prev,
                        [category.id]: event.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Saving…" : "Save budget"}
              </Button>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
