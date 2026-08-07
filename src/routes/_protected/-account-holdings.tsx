import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  PiggyBank,
  Plus,
  TrendingDown,
  TrendingUp,
  Trash2,
  Wallet,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatCurrency } from "@/lib/currency"
import { instrumentKindLabel } from "@/lib/instruments"
import { cn } from "@/lib/utils"
import type { getAccountHoldingsFn } from "@/server/holdings"

// PER-232 / ADR-0051 — Holdings UI (presentational).
// Pure, props-in rendering of an account's holdings (units, cost, current
// value, unrealized gain). All money crosses the wire as minor-unit digit-
// strings ALREADY computed by the server (holdings.ts) — this component never
// does money math, it only formats. The route (accounts.$accountId.tsx) owns
// the data fetch + the add/edit/delete handlers.

// Client-side types derived from the server fn's return — never import Prisma
// types into UI (CLAUDE.md §6). One source of truth for the shape.
export type AccountHoldingsView = Awaited<
  ReturnType<typeof getAccountHoldingsFn>
>
export type HoldingRecord = AccountHoldingsView["holdings"][number]

function GainText({
  gainMinor,
  returnPct,
  currency,
  className,
}: Readonly<{
  gainMinor: string
  returnPct: number | null
  currency: string
  className?: string
}>) {
  const gain = BigInt(gainMinor)
  const isFlat = gain === 0n
  const isGain = gain > 0n
  const toneText = isFlat
    ? "text-muted-foreground"
    : isGain
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-destructive"
  const pctStr =
    returnPct === null
      ? null
      : `${returnPct >= 0 ? "+" : ""}${(returnPct * 100).toFixed(2)}%`
  return (
    <span
      className={cn(
        "flex items-center justify-end gap-1 tabular-nums",
        toneText,
        className
      )}
    >
      {isFlat ? null : isGain ? (
        <TrendingUp className="size-3.5" aria-hidden />
      ) : (
        <TrendingDown className="size-3.5" aria-hidden />
      )}
      {isGain && !isFlat ? "+" : ""}
      {formatCurrency(gainMinor, currency)}
      {pctStr ? (
        <span className="text-xs text-muted-foreground">({pctStr})</span>
      ) : null}
    </span>
  )
}

export function HoldingsPanel({
  view,
  currency,
  isLoading,
  onAdd,
  onEdit,
  onDelete,
  onBuy,
  onBuyHolding,
  onSellHolding,
}: Readonly<{
  view: AccountHoldingsView | undefined
  currency: string
  isLoading: boolean
  onAdd: () => void
  onEdit: (holding: HoldingRecord) => void
  onDelete: (holding: HoldingRecord) => void
  onBuy: () => void
  onBuyHolding: (holding: HoldingRecord) => void
  onSellHolding: (holding: HoldingRecord) => void
}>) {
  const holdings = view?.holdings ?? []

  return (
    <div className="rounded-2xl border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <PiggyBank className="size-3.5" aria-hidden />
          Holdings
        </h2>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onBuy}>
            <ArrowDownLeft className="size-4" />
            Buy
          </Button>
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="size-4" />
            Add holding
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
      ) : holdings.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-8 text-center">
          <Coins className="size-6 text-muted-foreground" aria-hidden />
          <p className="max-w-xs text-sm text-muted-foreground">
            No holdings yet — record a buy, or add a position you already own to
            track value and returns.
          </p>
        </div>
      ) : (
        <>
          <ul className="divide-y">
            {holdings.map((holding) => (
              <li
                key={holding.id}
                className="flex items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {holding.instrument.name}
                    </p>
                    <Badge variant="secondary" className="shrink-0">
                      {instrumentKindLabel(holding.instrument.kind)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    {holding.quantity} {holding.instrument.name} · cost{" "}
                    {formatCurrency(holding.costMinor, currency)}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => onBuyHolding(holding)}
                    >
                      <ArrowDownLeft className="size-3.5" />
                      Buy
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => onSellHolding(holding)}
                    >
                      <ArrowUpRight className="size-3.5" />
                      Sell
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => onEdit(holding)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                      aria-label={`Delete ${holding.instrument.name}`}
                      onClick={() => onDelete(holding)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums">
                    {formatCurrency(holding.valueMinor, currency)}
                  </p>
                  <GainText
                    gainMinor={holding.gainMinor}
                    returnPct={holding.returnPct}
                    currency={currency}
                    className="mt-0.5 text-sm font-medium"
                  />
                </div>
              </li>
            ))}
          </ul>

          {view ? (
            <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Wallet className="size-3.5" aria-hidden />
                Total
              </div>
              <div className="text-right">
                <p className="text-base font-semibold tabular-nums">
                  {formatCurrency(view.totalValueMinor, currency)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  Cost {formatCurrency(view.totalCostMinor, currency)}
                </p>
                <GainText
                  gainMinor={view.totalGainMinor}
                  returnPct={null}
                  currency={currency}
                  className="mt-0.5 justify-end text-sm font-medium"
                />
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
