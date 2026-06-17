import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Coins, Plus, RefreshCw } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  getFxOverviewFn,
  rebuildFxProjectionsFn,
  setBaseCurrencyFn,
  upsertFxRateSnapshotFn,
} from "@/server/fx"

const FX_OVERVIEW_KEY = ["fx-overview"] as const

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export const Route = createFileRoute("/_protected/currencies")({
  ssr: false,
  staticData: { title: "Currencies & FX" },
  component: CurrenciesPage,
})

function CurrenciesPage() {
  const queryClient = useQueryClient()
  const overview = useQuery({
    queryKey: FX_OVERVIEW_KEY,
    queryFn: async () => await getFxOverviewFn(),
  })
  const baseCurrency = overview.data?.baseCurrency ?? "—"

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: FX_OVERVIEW_KEY })

  return (
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
          <div className="flex items-center gap-3">
            <Coins className="size-6 text-yellow-500" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold">
                Currencies &amp; FX rates
              </h1>
              <p className="text-sm text-muted-foreground">
                Reporting is normalized to your base currency using dated rate
                snapshots. Native account and transaction amounts never change.
              </p>
            </div>
          </div>

          <BaseCurrencyCard
            baseCurrency={baseCurrency}
            onChanged={invalidate}
          />

          <AddRateCard baseCurrency={baseCurrency} onAdded={invalidate} />

          <RatesTableCard
            baseCurrency={baseCurrency}
            rates={overview.data?.rates ?? []}
            isLoading={overview.isLoading}
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function BaseCurrencyCard({
  baseCurrency,
  onChanged,
}: {
  baseCurrency: string
  onChanged: () => void
}) {
  const [next, setNext] = React.useState("")
  const mutation = useMutation({
    mutationFn: async (currency: string) =>
      await setBaseCurrencyFn({ data: { currency } }),
    onSuccess: () => {
      setNext("")
      onChanged()
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Base reporting currency</CardTitle>
        <CardDescription>
          Current base is{" "}
          <span className="font-mono font-medium">{baseCurrency}</span>.
          Changing it rebuilds every base-currency projection; native amounts
          are untouched.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const code = next.trim().toUpperCase()
            if (code) mutation.mutate(code)
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="base-currency">New base currency</Label>
            <Input
              id="base-currency"
              placeholder="e.g. USD"
              value={next}
              maxLength={5}
              className="w-40 uppercase"
              onChange={(event) => setNext(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            disabled={mutation.isPending || next.trim() === ""}
          >
            {mutation.isPending ? "Rebuilding…" : "Change base"}
          </Button>
          {mutation.isError ? (
            <p className="text-sm text-destructive">
              {(mutation.error as Error).message}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

function AddRateCard({
  baseCurrency,
  onAdded,
}: {
  baseCurrency: string
  onAdded: () => void
}) {
  const [fromCurrency, setFromCurrency] = React.useState("")
  const [toCurrency, setToCurrency] = React.useState(baseCurrency)
  const [rate, setRate] = React.useState("")
  const [asOfDate, setAsOfDate] = React.useState(todayIso())

  const mutation = useMutation({
    mutationFn: async () =>
      await upsertFxRateSnapshotFn({
        data: {
          fromCurrency: fromCurrency.trim().toUpperCase(),
          toCurrency: (toCurrency || baseCurrency).trim().toUpperCase(),
          rate: rate.trim(),
          asOfDate,
          source: "manual",
        },
      }),
    onSuccess: () => {
      setFromCurrency("")
      setRate("")
      onAdded()
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a manual rate</CardTitle>
        <CardDescription>
          One unit of <span className="font-medium">from</span> equals{" "}
          <span className="font-medium">rate</span> units of{" "}
          <span className="font-medium">to</span> (your base currency).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="from-currency">From</Label>
            <Input
              id="from-currency"
              placeholder="USD"
              value={fromCurrency}
              maxLength={5}
              className="w-28 uppercase"
              onChange={(event) => setFromCurrency(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="to-currency">To (base)</Label>
            <Input
              id="to-currency"
              placeholder={baseCurrency}
              value={toCurrency}
              maxLength={5}
              className="w-28 uppercase"
              onChange={(event) => setToCurrency(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rate">Rate</Label>
            <Input
              id="rate"
              inputMode="decimal"
              placeholder="16250.75"
              value={rate}
              className="w-40"
              onChange={(event) => setRate(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="as-of">As of</Label>
            <Input
              id="as-of"
              type="date"
              value={asOfDate}
              className="w-44"
              onChange={(event) => setAsOfDate(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            disabled={
              mutation.isPending ||
              fromCurrency.trim() === "" ||
              rate.trim() === ""
            }
          >
            <Plus className="size-4" aria-hidden />
            {mutation.isPending ? "Saving…" : "Add rate"}
          </Button>
          {mutation.isError ? (
            <p className="w-full text-sm text-destructive">
              {(mutation.error as Error).message}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

function RatesTableCard({
  baseCurrency,
  rates,
  isLoading,
}: {
  baseCurrency: string
  rates: Array<{
    id: string
    fromCurrency: string
    toCurrency: string
    rate: string
    asOfDate: string
    source: string
  }>
  isLoading: boolean
}) {
  const queryClient = useQueryClient()
  const rebuild = useMutation({
    mutationFn: async () => await rebuildFxProjectionsFn({ data: {} }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: FX_OVERVIEW_KEY }),
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Rate snapshots</CardTitle>
          <CardDescription>
            Resolved by the most recent date on or before each transaction.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={rebuild.isPending}
          onClick={() => rebuild.mutate()}
        >
          <RefreshCw className="size-4" aria-hidden />
          {rebuild.isPending ? "Rebuilding…" : "Recompute"}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading rates…</p>
        ) : rates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rates yet. Add one above so foreign-currency rows can be reported
            in {baseCurrency}.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pair</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>As of</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">
                    {row.fromCurrency} → {row.toCurrency}
                  </TableCell>
                  <TableCell className="font-mono">{row.rate}</TableCell>
                  <TableCell>{row.asOfDate}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.source}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
