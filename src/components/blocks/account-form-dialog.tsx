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
import { MoneyInput } from "@/components/blocks/money-input"
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
  isLiabilityAccountType,
  type AccountType,
} from "@/lib/accounts"
import { accountSupportsReserve } from "@/lib/account-reserve"
import type { AccountRecord } from "@/lib/account-collections"
import { CURRENCY_OPTIONS } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { parseMoneyInput, toDecimalString } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import { createAccountFn, updateAccountFn } from "@/server/accounts"

// PER-221 — shared account create/edit dialog. Extracted verbatim from
// accounts.index.tsx so BOTH the list route and the per-account detail route can
// open it. Self-contained (its own submit + idempotency + validation); the
// caller only decides create-vs-edit and refetches on `onSaved`.

// Radix Select forbids an empty-string item value, so an unset subtype uses a
// sentinel that maps back to "default for the chosen type" on submit.
const DEFAULT_SUBTYPE_SENTINEL = "__default"

// PER-272 — parse a calendar-day input (statement/due day, 1–31). Empty clears
// (null); a malformed non-empty value throws before any write.
function parseCalendarDay(raw: string, label: string): number | null {
  if (raw.trim() === "") return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new Error(`Enter a valid ${label} (1–31).`)
  }
  return value
}

// PER-272 — parse a basis-point interest rate (non-negative integer).
function parseInterestRateBps(raw: string): number | null {
  if (raw.trim() === "") return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Enter a valid interest rate in basis points (100 = 1%).")
  }
  return value
}

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
  // PER-269 — optional as-of date for the opening balance. Defaults to today
  // (the `new Date()` contract the server already had), past dates are allowed,
  // future dates are rejected with a clear message before any write.
  const [openingAsOfDate, setOpeningAsOfDate] = React.useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  )
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
      ? toDecimalString(
          BigInt(editing.reserveBalance),
          (editing.currency as CurrencyCode) ?? "IDR"
        )
      : ""
  )
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  // PER-272 — credit/loan product metadata. mask is a short digit string;
  // creditLimit is a MAJOR-unit string (MoneyInput) seeded from the stored
  // minor-unit value; the day and rate fields are raw strings parsed on submit
  // (lazy init, no useEffect).
  const [mask, setMask] = React.useState<string>(editing?.mask ?? "")
  const [creditLimitInput, setCreditLimitInput] = React.useState<string>(() =>
    editing?.creditLimit
      ? toDecimalString(
          BigInt(editing.creditLimit),
          (editing.currency as CurrencyCode) ?? "IDR"
        )
      : ""
  )
  const [statementDay, setStatementDay] = React.useState<string>(
    editing?.statementDay != null ? String(editing.statementDay) : ""
  )
  const [dueDay, setDueDay] = React.useState<string>(
    editing?.dueDay != null ? String(editing.dueDay) : ""
  )
  const [interestRateBps, setInterestRateBps] = React.useState<string>(
    editing?.interestRateBps != null ? String(editing.interestRateBps) : ""
  )

  // Derived, pure: the class and balance source preview track the chosen type.
  const previewClass = getAccountClassForType(accountType)
  const previewCashLike = isCashLikeAccount(accountType)
  // PER-217 — a reserve only makes sense on a cash-like ASSET account. On create
  // this tracks the chosen type; on edit it reflects the (fixed) account.
  const supportsReserve = editing
    ? accountSupportsReserve(editing)
    : previewClass === "ASSET" && previewCashLike
  // PER-272 — credit/loan product fields only apply to CREDIT/LOAN (liability)
  // accounts. On create this tracks the chosen type; on edit it reflects the
  // (fixed) account.
  const supportsCreditFields = editing
    ? isLiabilityAccountType(editing.accountType as AccountType)
    : isLiabilityAccountType(accountType)

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
          const parsedReserve = parseMoneyInput(
            reserveInput,
            currency as CurrencyCode
          )
          if (parsedReserve === null || parsedReserve < 0n) {
            throw new Error("Enter a valid reserve amount.")
          }
          reserveMinor = parsedReserve.toString()
        }
      }

      // PER-272 — parse the credit/loan product fields when the type supports
      // them. Empty clears (null); a malformed non-empty value is rejected
      // before any write. Fields are left undefined when unsupported so they
      // are omitted from the payload entirely.
      let maskValue: string | null | undefined
      let creditLimitMinor: string | null | undefined
      let statementDayValue: number | null | undefined
      let dueDayValue: number | null | undefined
      let interestRateBpsValue: number | null | undefined

      if (supportsCreditFields) {
        maskValue = mask.trim() === "" ? null : mask.trim()

        if (creditLimitInput.trim() === "") {
          creditLimitMinor = null
        } else {
          const parsedCreditLimit = parseMoneyInput(
            creditLimitInput,
            currency as CurrencyCode
          )
          if (parsedCreditLimit === null || parsedCreditLimit < 0n) {
            throw new Error("Enter a valid credit limit.")
          }
          creditLimitMinor = parsedCreditLimit.toString()
        }

        statementDayValue = parseCalendarDay(statementDay, "statement day")
        dueDayValue = parseCalendarDay(dueDay, "due day")
        interestRateBpsValue = parseInterestRateBps(interestRateBps)
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
            ...(maskValue === undefined ? {} : { mask: maskValue }),
            ...(creditLimitMinor === undefined
              ? {}
              : { creditLimit: creditLimitMinor }),
            ...(statementDayValue === undefined
              ? {}
              : { statementDay: statementDayValue }),
            ...(dueDayValue === undefined ? {} : { dueDay: dueDayValue }),
            ...(interestRateBpsValue === undefined
              ? {}
              : { interestRateBps: interestRateBpsValue }),
            idempotencyKey: createUuidV7(),
          },
        })
      } else {
        // PER-207/PER-240: parse the user-typed opening balance with
        // `parseMoneyInput` (locale-agnostic, handles thousands separators /
        // either decimal convention, returns null on malformed) — NOT
        // `toMinorUnits`, which expects a canonical decimal and throws on
        // user-formatted strings. `<MoneyInput>` previews the same value.
        let openingMinor = "0"
        if (openingBalance.trim() !== "") {
          const parsed = parseMoneyInput(
            openingBalance,
            currency as CurrencyCode
          )
          if (parsed === null) {
            throw new Error("Enter a valid opening balance.")
          }
          openingMinor = parsed.toString()
        }
        // PER-269 — validate the as-of date before any write: an empty value
        // means "today" (the default that preserves current behavior exactly),
        // a past YYYY-MM-DD is stored as the opening Valuation's valuationDate,
        // and a future date is rejected with a clear, user-facing message.
        let openingBalanceAsOfDate: Date | undefined
        if (openingAsOfDate.trim() !== "") {
          // Input type="date" always yields YYYY-MM-DD; guard the shape so a
          // programmatic or autofill value can't slip through as an invalid date.
          if (!/^\d{4}-\d{2}-\d{2}$/.test(openingAsOfDate.trim())) {
            throw new Error("Enter a valid as-of date (YYYY-MM-DD).")
          }
          const picked = new Date(`${openingAsOfDate.trim()}T00:00:00.000Z`)
          if (Number.isNaN(picked.getTime())) {
            throw new Error("Enter a valid as-of date.")
          }
          const today = new Date().toISOString().slice(0, 10)
          if (openingAsOfDate.trim() > today) {
            throw new Error(
              "Opening balance as-of date cannot be in the future"
            )
          }
          openingBalanceAsOfDate = picked
        }
        await createAccountFn({
          data: {
            name: name.trim(),
            accountType,
            accountSubtype: resolvedSubtype,
            currency,
            openingBalance: openingMinor,
            ...(openingBalanceAsOfDate ? { openingBalanceAsOfDate } : {}),
            institutionName: institutionName.trim() || null,
            ...(reserveMinor ? { reserveBalance: reserveMinor } : {}),
            ...(maskValue === undefined ? {} : { mask: maskValue }),
            ...(creditLimitMinor === undefined
              ? {}
              : { creditLimit: creditLimitMinor }),
            ...(statementDayValue === undefined
              ? {}
              : { statementDay: statementDayValue }),
            ...(dueDayValue === undefined ? {} : { dueDay: dueDayValue }),
            ...(interestRateBpsValue === undefined
              ? {}
              : { interestRateBps: interestRateBpsValue }),
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
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="opening-balance">
                    Opening balance ({currency})
                  </Label>
                  <MoneyInput
                    id="opening-balance"
                    currency={currency as CurrencyCode}
                    value={openingBalance}
                    onChange={setOpeningBalance}
                    placeholder="0"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="opening-as-of-date">
                    Balance as of this date
                  </Label>
                  <Input
                    id="opening-as-of-date"
                    type="date"
                    value={openingAsOfDate}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setOpeningAsOfDate(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {previewClass === "LIABILITY"
                  ? "Recorded as amount owed."
                  : "Recorded as current value."}{" "}
                {previewCashLike
                  ? "Cash-like — balance follows transactions."
                  : "Tracked asset — balance follows valuations."}
                {allowsNegativeAssetBalance(accountType)
                  ? " Already overdrawn? Enter a negative amount."
                  : null}{" "}
                Balance as of the date you choose — defaults to today.
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
              <MoneyInput
                id="reserve-balance"
                currency={currency as CurrencyCode}
                value={reserveInput}
                onChange={setReserveInput}
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

          {supportsCreditFields ? (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="credit-mask">
                    Card/account mask (optional)
                  </Label>
                  <Input
                    id="credit-mask"
                    value={mask}
                    onChange={(e) => setMask(e.target.value)}
                    placeholder="e.g. 1234"
                    inputMode="numeric"
                    maxLength={8}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="credit-limit">
                    Credit limit ({currency})
                  </Label>
                  <MoneyInput
                    id="credit-limit"
                    currency={currency as CurrencyCode}
                    value={creditLimitInput}
                    onChange={setCreditLimitInput}
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="statement-day">Statement day</Label>
                  <Input
                    id="statement-day"
                    value={statementDay}
                    onChange={(e) => setStatementDay(e.target.value)}
                    placeholder="1–31"
                    inputMode="numeric"
                    maxLength={2}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="due-day">Due day</Label>
                  <Input
                    id="due-day"
                    value={dueDay}
                    onChange={(e) => setDueDay(e.target.value)}
                    placeholder="1–31"
                    inputMode="numeric"
                    maxLength={2}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="interest-rate">Interest (bps)</Label>
                  <Input
                    id="interest-rate"
                    value={interestRateBps}
                    onChange={(e) => setInterestRateBps(e.target.value)}
                    placeholder="100 = 1%"
                    inputMode="numeric"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Statement and due days are 1–31. Interest is in basis points
                (100 bps = 1%).{editing ? " Leave empty to clear." : ""}
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
