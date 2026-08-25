import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowDownLeft, ArrowUpRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DialogDateTimeField } from "@/components/blocks/dialog-date-time-field"
import { DialogLoadingOrError } from "@/components/blocks/dialog-loading-state"
import { MoneyInput } from "@/components/blocks/money-input"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import {
  averageUnitCostMinor,
  holdingCostMinor,
  quantityToScaled,
} from "@/lib/holdings"
import { parseMoneyInput, toDecimalString } from "@/lib/money"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  correctTradeFn,
  getTradeForCorrectionFn,
  type TradeForCorrectionView,
} from "@/server/holdings"

// PER-259 Slice 5 / ADR-0054 — "Edit/correct a trade" dialog. Styled and
// structured like `TradeDialog` (side + funding account + quantity + unit
// price, cash total derived live via the SAME pure helper), but for an
// EXISTING trade: the instrument is fixed (resolved server-side from
// history — not editable, moving a position between instruments/accounts is
// out of scope), and submission is reversal-and-replace
// (`correctTradeFn`) rather than a fresh trade.

export interface TradeCorrectionFundingAccount {
  id: string
  name: string
  currency: string
}

export function TradeCorrectionDialog({
  transactionId,
  fundingAccounts,
  onClose,
  onSaved,
}: {
  transactionId: string
  fundingAccounts: ReadonlyArray<TradeCorrectionFundingAccount>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const {
    data: details,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: ["trade_for_correction", transactionId],
    queryFn: async () =>
      await getTradeForCorrectionFn({ data: { transactionId } }),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      {/* Adding the Time half made every one of these forms a row taller, so
          the footer could fall past the fold on a short viewport and leave the
          submit button unclickable. Same scroll shell the main transaction
          modal already uses. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogLoadingOrError
          isLoading={isLoading}
          error={loadError}
          hasData={details != null}
          loadingLabel="Loading trade…"
          notFoundTitle="Can't edit this trade"
          notFoundMessage="This transaction could not be loaded."
          onClose={onClose}
        >
          {details ? (
            <TradeCorrectionForm
              details={details}
              fundingAccounts={fundingAccounts}
              onClose={onClose}
              onSaved={onSaved}
            />
          ) : null}
        </DialogLoadingOrError>
      </DialogContent>
    </Dialog>
  )
}

// Split into its own component so `useState`'s initializers seed from
// `details` on the ONE render this mounts (details are already resolved by
// the time the parent renders it) — no useEffect, no "sync state from a
// prop" hook needed.
function TradeCorrectionForm({
  details,
  fundingAccounts,
  onClose,
  onSaved,
}: {
  details: TradeForCorrectionView
  fundingAccounts: ReadonlyArray<TradeCorrectionFundingAccount>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = details.currency as CurrencyCode

  const initialUnitPriceMinor = averageUnitCostMinor(
    BigInt(details.cashAmountMinor),
    quantityToScaled(details.quantity)
  )

  const [side, setSide] = React.useState<"buy" | "sell">(details.side)
  const [fundingAccountId, setFundingAccountId] = React.useState<string>(
    details.fundingAccountId
  )
  const [quantity, setQuantity] = React.useState<string>(details.quantity)
  const [unitPrice, setUnitPrice] = React.useState<string>(
    toDecimalString(initialUnitPriceMinor, currencyCode)
  )
  const [date, setDate] = React.useState<Date>(
    () => new Date(details.tradeDate)
  )
  const [error, setError] = React.useState<string | null>(
    details.notLatestReason
  )
  const [submitting, setSubmitting] = React.useState(false)

  // Live cash total = quantity × unit price, via the SAME pure helper the
  // server uses for cost basis — pure derivation, no effect.
  const cashPreview = React.useMemo<
    { kind: "empty" } | { kind: "invalid" } | { kind: "valid"; minor: bigint }
  >(() => {
    if (quantity.trim() === "" || unitPrice.trim() === "") {
      return { kind: "empty" }
    }
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (price === null || price <= 0n) return { kind: "invalid" }
    try {
      const scaled = quantityToScaled(quantity.trim())
      if (scaled <= 0n) return { kind: "invalid" }
      return { kind: "valid", minor: holdingCostMinor(scaled, price) }
    } catch {
      return { kind: "invalid" }
    }
  }, [quantity, unitPrice, currencyCode])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (cashPreview.kind !== "valid") {
      setError("Enter a valid quantity and unit price.")
      return
    }
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (price === null) {
      setError("Enter a valid unit price.")
      return
    }
    setSubmitting(true)
    try {
      await correctTradeFn({
        data: {
          transactionId: details.transactionId,
          fundingAccountId,
          side,
          cashAmount: cashPreview.minor.toString(),
          quantity: quantity.trim(),
          unitPrice: price.toString(),
          tradeDate: date.toISOString(),
          idempotencyKey: createUuidV7(),
        },
      })
      await onSaved()
    } catch (caught) {
      // The HoldingError message (e.g. "this trade has activity after it…")
      // survives the RPC boundary and surfaces here verbatim.
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    fundingAccountId === "" ||
    quantity.trim() === "" ||
    unitPrice.trim() === "" ||
    cashPreview.kind !== "valid" ||
    details.notLatestReason !== null

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {side === "buy" ? (
            <ArrowDownLeft className="size-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ArrowUpRight className="size-4 text-destructive" />
          )}
          Edit {details.instrumentName}
        </DialogTitle>
        <DialogDescription>
          Correcting this trade reverses it and records a new one with the
          corrected details. The old entry stays in your history, tombstoned.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label>Side</Label>
          <Select
            value={side}
            onValueChange={(value) => setSide(value as "buy" | "sell")}
            disabled={details.notLatestReason !== null}
          >
            <SelectTrigger aria-label="Trade side">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="buy">Buy</SelectItem>
              <SelectItem value="sell">Sell</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          {/* A Buy PAYS from this account; a Sell RECEIVES proceeds into it —
              "Funding account" reads backwards for a Sell (see the same fix
              in trade-dialog.tsx). */}
          <Label>
            {side === "buy" ? "Funding account" : "Destination account"}
          </Label>
          <Select
            value={fundingAccountId}
            onValueChange={setFundingAccountId}
            disabled={details.notLatestReason !== null}
          >
            <SelectTrigger
              aria-label={
                side === "buy" ? "Funding account" : "Destination account"
              }
            >
              <SelectValue placeholder="Choose account" />
            </SelectTrigger>
            <SelectContent>
              {fundingAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="trade-correction-quantity">Quantity</Label>
          <Input
            id="trade-correction-quantity"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={details.notLatestReason !== null}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="trade-correction-unit-price">
            Unit price ({details.currency})
          </Label>
          <MoneyInput
            id="trade-correction-unit-price"
            currency={currencyCode}
            value={unitPrice}
            onChange={setUnitPrice}
            disabled={details.notLatestReason !== null}
            required
          />
        </div>
      </div>

      <DialogDateTimeField
        id="trade-correction-date"
        value={date}
        onChange={setDate}
        disabled={details.notLatestReason !== null}
      />

      <div
        className={cn(
          "flex items-center justify-between rounded-md border p-3 text-sm",
          cashPreview.kind === "valid" ? "bg-muted/50" : "text-muted-foreground"
        )}
      >
        <span className="text-muted-foreground">
          {side === "buy" ? "Cash out" : "Cash in"}
        </span>
        <span className="font-semibold tabular-nums">
          {cashPreview.kind === "valid"
            ? formatCurrency(cashPreview.minor.toString(), details.currency)
            : "—"}
        </span>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          {submitting ? "Saving…" : "Save correction"}
        </Button>
      </DialogFooter>
    </form>
  )
}
