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
  scaledToQuantityString,
  sortAccountOptions,
  unitsFromAmountScaled,
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
//
// PER-262 — the amount-driven basis toggle `TradeDialog` shipped later
// (PER-259 Slice 5 predates it) is backported here too, reusing the SAME
// `unitsFromAmountScaled` fold — no duplicated math. The Sell quick-allocation
// chips (`SELL_FRACTIONS` in trade-dialog.tsx) are NOT backported: those
// operate on the position's CURRENTLY HELD quantity, which
// `TradeForCorrectionView` does not expose (only this trade's own delta,
// `details.quantity`) — fabricating that number here would be a second,
// worse bug, not a fix.

type Basis = "quantity" | "amount"

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

  // PER-262 — `fundingAccounts` (from the page) is deliberately BROAD: every
  // active same-currency transaction_flow account, INCLUDING this trade's own
  // investment account and INCLUDING whichever account's page the dialog was
  // opened from. The one exclusion that actually matters — a trade can never
  // fund itself — is applied HERE, against the trade's own resolved
  // `investmentAccountId`, never against the page's `accountId` (which the
  // caller doesn't even pass down). This is what makes the dialog correct
  // regardless of which side of the trade's two accounts it was opened from.
  const selectableFundingAccounts = React.useMemo(
    () =>
      sortAccountOptions(
        fundingAccounts.filter((a) => a.id !== details.investmentAccountId)
      ),
    [fundingAccounts, details.investmentAccountId]
  )

  const [side, setSide] = React.useState<"buy" | "sell">(details.side)
  const [fundingAccountId, setFundingAccountId] = React.useState<string>(
    details.fundingAccountId
  )
  const [basis, setBasis] = React.useState<Basis>("quantity")
  const [quantity, setQuantity] = React.useState<string>(details.quantity)
  const [amount, setAmount] = React.useState<string>(() =>
    toDecimalString(BigInt(details.cashAmountMinor), currencyCode)
  )
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

  const isQuantityBasis = basis === "quantity"

  const unitPriceMinor = React.useMemo<bigint | null>(() => {
    if (unitPrice.trim() === "") return null
    const parsed = parseMoneyInput(unitPrice, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [unitPrice, currencyCode])

  const amountMinor = React.useMemo<bigint | null>(() => {
    if (amount.trim() === "") return null
    const parsed = parseMoneyInput(amount, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [amount, currencyCode])

  // Live preview — whichever of {quantity, amount} the user did NOT type is
  // derived here, via the SAME pure helpers `TradeDialog` uses (no duplicated
  // math): quantity basis folds quantity × price → cash; amount basis folds
  // amount ÷ price → units (`unitsFromAmountScaled`), keeping the typed amount
  // itself authoritative for the cash leg — never re-derived from a rounded
  // quantity. Pure derivation, no effect.
  const cashPreview = React.useMemo<
    | { kind: "empty" }
    | { kind: "invalid" }
    | { kind: "valid"; minor: bigint; quantityScaled: bigint }
  >(() => {
    if (unitPriceMinor === null) return { kind: "empty" }
    if (isQuantityBasis) {
      if (quantity.trim() === "") return { kind: "empty" }
      try {
        const scaled = quantityToScaled(quantity.trim())
        if (scaled <= 0n) return { kind: "invalid" }
        return {
          kind: "valid",
          minor: holdingCostMinor(scaled, unitPriceMinor),
          quantityScaled: scaled,
        }
      } catch {
        return { kind: "invalid" }
      }
    }
    if (amountMinor === null) return { kind: "empty" }
    const quantityScaled = unitsFromAmountScaled(amountMinor, unitPriceMinor)
    if (quantityScaled <= 0n) return { kind: "invalid" }
    return { kind: "valid", minor: amountMinor, quantityScaled }
  }, [isQuantityBasis, quantity, amountMinor, unitPriceMinor])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (cashPreview.kind !== "valid") {
      setError(
        `Enter a valid ${isQuantityBasis ? "quantity" : "amount"} and unit price.`
      )
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
          // Quantity basis sends exactly what the user typed; amount basis
          // sends the derived units at the column's own fixed 8-dp scale
          // (mirrors `TradeDialog`'s submit) so nothing is re-rounded.
          quantity: isQuantityBasis
            ? quantity.trim()
            : scaledToQuantityString(cashPreview.quantityScaled),
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
    unitPriceMinor === null ||
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
              {selectableFundingAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label title="Type the units you traded, or the cash you moved — whichever you actually know. The other side is derived at the unit price below.">
          Enter by
        </Label>
        <Select
          value={basis}
          onValueChange={(value) => setBasis(value as Basis)}
          disabled={details.notLatestReason !== null}
        >
          <SelectTrigger aria-label="Trade entry basis">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="quantity">Quantity (units)</SelectItem>
            <SelectItem value="amount">
              {side === "buy"
                ? "Amount (cash to invest)"
                : "Amount (cash proceeds)"}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {isQuantityBasis ? (
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
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="trade-correction-amount">
              Amount ({details.currency})
            </Label>
            <MoneyInput
              id="trade-correction-amount"
              currency={currencyCode}
              value={amount}
              onChange={setAmount}
              disabled={details.notLatestReason !== null}
              required
            />
          </div>
        )}
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
          "flex flex-col gap-1.5 rounded-md border p-3 text-sm",
          cashPreview.kind === "valid" ? "bg-muted/50" : "text-muted-foreground"
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            {side === "buy" ? "Cash out" : "Cash in"}
          </span>
          <span
            className="font-semibold tabular-nums"
            data-testid="trade-correction-cash-total"
          >
            {cashPreview.kind === "valid"
              ? formatCurrency(cashPreview.minor.toString(), details.currency)
              : "—"}
          </span>
        </div>
        {/* The derived side of whichever basis is active — shown always so
            both modes preview the same shape (mirrors TradeDialog). */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            {side === "buy" ? "Units bought" : "Units sold"}
          </span>
          <span
            className="font-semibold tabular-nums"
            data-testid="trade-correction-units-total"
          >
            {cashPreview.kind === "valid"
              ? scaledToQuantityString(cashPreview.quantityScaled)
              : "—"}
          </span>
        </div>
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
