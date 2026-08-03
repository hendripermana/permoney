import * as React from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  ACCOUNT_SUBTYPE_VALUES,
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_VALUES,
  allowsNegativeAssetBalance,
  getAccountClassForType,
  isCashLikeAccount,
  type AccountType,
} from "@/lib/accounts"
import { accountSupportsReserve } from "@/lib/account-reserve"
import type { AccountRecord } from "@/lib/account-collections"
import { CURRENCY_OPTIONS } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { parseUserInput, toDisplayNumber } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import { createAccountFn, updateAccountFn } from "@/server/accounts"

// PER-221 — shared account create/edit dialog. Extracted verbatim from
// accounts.index.tsx so BOTH the list route and the per-account detail route can
// open it. Self-contained (its own submit + idempotency + validation); the
// caller only decides create-vs-edit and refetches on `onSaved`.

// Radix Select forbids an empty-string item value, so an unset subtype uses a
// sentinel that maps back to "default for the chosen type" on submit.
const DEFAULT_SUBTYPE_SENTINEL = "__default"

export type AccountFormState =
  | { mode: "create" }
  | { mode: "edit"; account: AccountRecord }

export function AccountFormDialog({
  state,
  onClose,
  onSaved,
}: {
  state: AccountFormState
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const editing = state.mode === "edit" ? state.account : null

  const [name, setName] = React.useState(editing?.name ?? "")
  const [accountType, setAccountType] = React.useState<AccountType>(
    (editing?.accountType as AccountType) ?? "DEPOSITORY"
  )
  const [accountSubtype, setAccountSubtype] = React.useState<string>(
    editing?.accountSubtype ?? DEFAULT_SUBTYPE_SENTINEL
  )
  const [currency, setCurrency] = React.useState<string>(
    editing?.currency ?? "IDR"
  )
  const [openingBalance, setOpeningBalance] = React.useState<string>("")
  const [institutionName, setInstitutionName] = React.useState<string>(
    editing?.institutionName ?? ""
  )
  const [isImportable, setIsImportable] = React.useState<boolean>(
    editing?.isImportable ?? false
  )
  // PER-217 — reserve/minimum balance, as a user-facing MAJOR-unit string. On
  // edit, seed from the stored minor-unit value (lazy init, no useEffect).
  const [reserveInput, setReserveInput] = React.useState<string>(() =>
    editing?.reserveBalance
      ? String(
          toDisplayNumber(
            BigInt(editing.reserveBalance),
            (editing.currency as CurrencyCode) ?? "IDR"
          )
        )
      : ""
  )
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // Derived, pure: the class and balance source preview track the chosen type.
  const previewClass = getAccountClassForType(accountType)
  const previewCashLike = isCashLikeAccount(accountType)
  // PER-217 — a reserve only makes sense on a cash-like ASSET account. On create
  // this tracks the chosen type; on edit it reflects the (fixed) account.
  const supportsReserve = editing
    ? accountSupportsReserve(editing)
    : previewClass === "ASSET" && previewCashLike

  // Subtypes are flexible; offer the known vocabulary as a convenience, led by
  // the "default for type" sentinel.
  const subtypeOptions = React.useMemo(
    () => [DEFAULT_SUBTYPE_SENTINEL, ...ACCOUNT_SUBTYPE_VALUES],
    []
  )

  const resolvedSubtype =
    accountSubtype === DEFAULT_SUBTYPE_SENTINEL ? undefined : accountSubtype

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // PER-217 — parse the reserve once for whichever branch runs. An empty
      // input on edit CLEARS the reserve (null); on create it means "no reserve"
      // (omit). A malformed non-empty value is rejected before any write.
      let reserveMinor: string | null | undefined
      if (supportsReserve) {
        if (reserveInput.trim() === "") {
          reserveMinor = editing ? null : undefined
        } else {
          const parsedReserve = parseUserInput(
            reserveInput.trim(),
            currency as CurrencyCode
          )
          if (parsedReserve === null || parsedReserve < 0n) {
            throw new Error("Enter a valid reserve amount.")
          }
          reserveMinor = parsedReserve.toString()
        }
      }

      if (editing) {
        await updateAccountFn({
          data: {
            id: editing.id,
            name: name.trim(),
            accountSubtype: resolvedSubtype,
            institutionName: institutionName.trim() || null,
            isImportable,
            ...(reserveMinor === undefined
              ? {}
              : { reserveBalance: reserveMinor }),
            idempotencyKey: createUuidV7(),
          },
        })
      } else {
        // PER-207: parse the user-typed opening balance with `parseUserInput`
        // (handles thousands separators / locale decimal, returns null on
        // malformed) — NOT `toMinorUnits`, which expects a canonical decimal
        // and throws on user-formatted strings.
        let openingMinor = "0"
        if (openingBalance.trim() !== "") {
          const parsed = parseUserInput(
            openingBalance.trim(),
            currency as CurrencyCode
          )
          if (parsed === null) {
            throw new Error("Enter a valid opening balance.")
          }
          openingMinor = parsed.toString()
        }
        await createAccountFn({
          data: {
            name: name.trim(),
            accountType,
            accountSubtype: resolvedSubtype,
            currency,
            openingBalance: openingMinor,
            institutionName: institutionName.trim() || null,
            ...(reserveMinor ? { reserveBalance: reserveMinor } : {}),
            idempotencyKey: createUuidV7(),
          },
        })
      }
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit account" : "New account"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update account metadata. Class and type are fixed at creation."
                : "Classification uses the account taxonomy. The balance source is derived from the type."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. BCA Checking"
              required
            />
          </div>

          {editing ? null : (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label>Type</Label>
                <Select
                  value={accountType}
                  onValueChange={(value) =>
                    setAccountType(value as AccountType)
                  }
                >
                  <SelectTrigger aria-label="Account type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPE_VALUES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {ACCOUNT_TYPE_LABEL[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label>Currency</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger aria-label="Currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map(({ code, name }) => (
                      <SelectItem key={code} value={code}>
                        {code} — {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label>Subtype</Label>
            <Select
              value={accountSubtype}
              onValueChange={(value) => setAccountSubtype(value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Default for type" />
              </SelectTrigger>
              <SelectContent>
                {subtypeOptions.map((subtype) => (
                  <SelectItem key={subtype} value={subtype}>
                    {subtype === DEFAULT_SUBTYPE_SENTINEL
                      ? "Default for type"
                      : subtype}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {editing ? null : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="opening-balance">
                Opening balance ({currency})
              </Label>
              <Input
                id="opening-balance"
                inputMode="decimal"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">
                {previewClass === "LIABILITY"
                  ? "Recorded as amount owed."
                  : "Recorded as current value."}{" "}
                {previewCashLike
                  ? "Cash-like — balance follows transactions."
                  : "Tracked asset — balance follows valuations."}
                {allowsNegativeAssetBalance(accountType)
                  ? " Already overdrawn? Enter a negative amount."
                  : null}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="institution">Institution (optional)</Label>
            <Input
              id="institution"
              value={institutionName}
              onChange={(e) => setInstitutionName(e.target.value)}
              placeholder="e.g. Bank Central Asia"
            />
          </div>

          {supportsReserve ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="reserve-balance">
                Reserve / minimum balance ({currency})
              </Label>
              <Input
                id="reserve-balance"
                inputMode="decimal"
                value={reserveInput}
                onChange={(e) => setReserveInput(e.target.value)}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">
                Money you keep untouched — your “dana mengendap”. It never
                changes your balance or net worth; it only lowers your{" "}
                <span className="font-medium">safe-to-spend</span> (available =
                balance − reserve).{editing ? " Leave empty to remove." : ""}
              </p>
            </div>
          ) : null}

          {editing ? (
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id="is-importable"
                checked={isImportable}
                onCheckedChange={(checked) => setIsImportable(checked === true)}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="is-importable">Allow imports</Label>
                <p className="text-xs text-muted-foreground">
                  Let CSV/QIF imports promote transactions into this account.
                </p>
              </div>
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
            <Button type="submit" disabled={submitting || name.trim() === ""}>
              {submitting ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
