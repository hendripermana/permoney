import * as React from "react"
import { Receipt } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DialogDateTimeField } from "@/components/blocks/dialog-date-time-field"
import { MoneyInput } from "@/components/blocks/money-input"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { sortAccountOptions } from "@/lib/holdings"
import { parseMoneyInput } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { recordFeeFn } from "@/server/holdings"

// PER-259 Slice 3 / ADR-0054 — Investment fee dialog.
// Broker/country-agnostic: a STANDALONE fee tied to an investment (platform,
// annual, one-off transaction/redemption fee charged separately). Modeled as an
// EXPENSE on a user-chosen cash account; the source holding is untouched. The
// heavy lifting (guarded expense posting, category find-or-create, provenance
// audit, idempotency) is SERVER-side (`recordFeeFn`); this dialog only collects
// inputs. NO vendor wording.
//
// Fees embedded in a Buy/Sell (purchase/redemption load) and NAV-embedded
// management fees (expense ratios) are already captured elsewhere and are NOT
// recorded here.

export interface FeeSourceAccount {
  id: string
  name: string
  currency: string
}

export type FeeDialogState = { holding?: HoldingRecord }

export function FeeDialog({
  state,
  investmentAccountId,
  currency,
  holdings,
  sourceAccounts,
  onClose,
  onSaved,
}: {
  state: FeeDialogState
  investmentAccountId: string
  currency: string
  holdings: ReadonlyArray<HoldingRecord>
  sourceAccounts: ReadonlyArray<FeeSourceAccount>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = currency as CurrencyCode

  // PER-262 — sorted alphabetically via the one shared helper every
  // account-option list in this dialog family uses.
  const sortedSourceAccounts = React.useMemo(
    () => sortAccountOptions(sourceAccounts),
    [sourceAccounts]
  )

  const [holdingId, setHoldingId] = React.useState<string>(
    state.holding?.id ?? holdings[0]?.id ?? ""
  )
  const [amount, setAmount] = React.useState<string>("")
  const [date, setDate] = React.useState<Date>(() => new Date())
  const [sourceAccountId, setSourceAccountId] = React.useState<string>(
    sourceAccounts[0]?.id ?? ""
  )
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // Parsed fee amount (minor units) — authoritative for the expense row.
  const amountMinor = React.useMemo<bigint | null>(() => {
    if (amount.trim() === "") return null
    const parsed = parseMoneyInput(amount, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [amount, currencyCode])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (amountMinor === null) {
      setError("Enter a valid fee amount.")
      return
    }
    if (holdingId === "") {
      setError("Choose the holding this fee relates to.")
      return
    }
    if (sourceAccountId === "") {
      setError("Choose the account the fee is charged to.")
      return
    }
    setSubmitting(true)
    try {
      await recordFeeFn({
        data: {
          investmentAccountId,
          holdingId,
          amount: amountMinor.toString(),
          date: date.toISOString(),
          sourceAccountId,
          idempotencyKey: createUuidV7(),
        },
      })
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    amountMinor === null ||
    holdingId === "" ||
    sourceAccountId === ""

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      {/* Adding the Time half made every one of these forms a row taller, so
          the footer could fall past the fold on a short viewport and leave the
          submit button unclickable. Same scroll shell the main transaction
          modal already uses. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="size-4 text-amber-600 dark:text-amber-400" />
              Investment fee
            </DialogTitle>
            <DialogDescription>
              A standalone fee reduces the account it is charged to; the
              position is unchanged.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label>Holding</Label>
            <Select value={holdingId} onValueChange={setHoldingId}>
              <SelectTrigger aria-label="Source holding">
                <SelectValue placeholder="Choose holding" />
              </SelectTrigger>
              <SelectContent>
                {holdings.map((holding) => (
                  <SelectItem key={holding.id} value={holding.id}>
                    {holding.instrument.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogDateTimeField
            id="fee-date"
            value={date}
            onChange={setDate}
            required
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor="fee-amount">Amount ({currency})</Label>
            <MoneyInput
              id="fee-amount"
              currency={currencyCode}
              value={amount}
              onChange={setAmount}
              placeholder="0"
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Charge to</Label>
            <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
              <SelectTrigger aria-label="Fee source account">
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {sortedSourceAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sourceAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No same-currency cash account to charge the fee to.
              </p>
            ) : null}
          </div>

          {amountMinor !== null ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/50 p-3 text-sm">
              <span className="text-muted-foreground">Cash out</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(amountMinor.toString(), currency)}
              </span>
            </div>
          ) : null}

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
              {submitting ? "Recording…" : "Record fee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
