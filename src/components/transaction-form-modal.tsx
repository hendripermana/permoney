"use client"

import * as React from "react"
import { useForm, type ReactFormExtendedApi } from "@tanstack/react-form"
import { useHotkeys } from "@tanstack/react-hotkeys"
import { useQuery } from "@tanstack/react-query"
import {
  IconArrowDownLeft,
  IconArrowUpRight,
  IconArrowsExchange,
  IconCalendar,
  IconClock,
  IconPaperclip,
  IconPlus,
  IconScissors,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import * as z from "zod"
import { format } from "date-fns"
import { getCurrencySymbol } from "@/lib/currency"
import { cn } from "@/lib/utils"
import { getTransactionFormData } from "@/server/transactions"
import { toDisplayNumber, toMinorUnits, type Money } from "@/lib/money"
import { CURRENCIES, type CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"

type TransactionFormData = Awaited<ReturnType<typeof getTransactionFormData>>
type FormAccount = TransactionFormData["accounts"][number]
type FormCategory = TransactionFormData["categories"][number]
type FormMerchant = TransactionFormData["merchants"][number]

import {
  transactionCollection,
  type TransactionRecord,
} from "@/lib/collections"
import { TimeInput } from "@/components/ui/time-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FieldError } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

const splitEntrySchema = z.object({
  id: z.string(), // client-generated UUID untuk React key
  description: z.string(),
  amount: z.number().min(0),
  categoryId: z.string().optional(),
  merchantId: z.string().optional(),
})

type SplitEntryValue = z.infer<typeof splitEntrySchema>

interface OptimisticTransactionRelationDraft {
  account: unknown
  category: unknown
  isSplit: boolean
  merchant: unknown
  splitEntries: unknown
  toAccount: unknown
}

const transactionSchema = z.object({
  type: z.enum(["expense", "income", "transfer"]),
  amount: z.number().min(1, "Amount is required"),
  description: z.string().min(1, "Description is required"),
  accountId: z.string().min(1, "Source Account is required"),
  categoryId: z.string().optional(),
  toAccountId: z.string().optional(),
  merchantId: z.string().optional(),
  date: z.date(),
  notes: z.string().optional(),
  // Enterprise: Transaction Lifecycle Status
  status: z.enum(["PENDING", "CLEARED", "RECONCILED"]).default("CLEARED"),
  // Enterprise: Multi-Currency Transfer (Implied Rate Architecture)
  // destinationAmount hanya diisi saat transfer antar akun dengan mata uang berbeda
  destinationAmount: z.number().positive().optional(),
  // Enterprise: Proof of Purchase (URL struk dari S3/R2)
  attachmentUrl: z.string().optional(),
})

type TransactionFormValues = z.infer<typeof transactionSchema>

// =============================================================================
// EDIT-MODE INPUT SHAPE (post-ADR-0001)
//
// Pages that open this modal in EDIT mode (e.g. /transactions) carry records
// straight from the TanStack DB collection, where every monetary field is a
// `Money` (bigint minor units). The form, however, binds to <input type=number>
// and stores decimal-major values in its state. We accept BOTH shapes here:
//
//   - `bigint`/`Money`  \u2014 from a live collection record. We convert to a
//     display number internally via `toDisplayNumber(money, currency)`.
//   - `number`          \u2014 legacy callers OR transient form state.
//
// Currency for the conversion comes from the source `Account.currency` of the
// edited transaction. If the source account has been deleted or the record
// is somehow missing the join, we fall back to "IDR" (the family default).
// =============================================================================
type EditAmount = number | bigint | Money

interface TransactionFormModalProps {
  editData?:
    | (Omit<TransactionFormValues, "amount" | "destinationAmount"> & {
        id: string
        amount: EditAmount
        destinationAmount?: EditAmount
        currency?: string
        isSplit?: boolean
        splitEntries?: Array<
          Omit<SplitEntryValue, "amount"> & { amount: EditAmount }
        >
      })
    | null
  customTrigger?: React.ReactNode
  onClose?: () => void
}

type TransactionType = TransactionFormValues["type"]
type TransactionStatus = TransactionFormValues["status"]
type TransactionFormInstance = ReactFormExtendedApi<
  TransactionFormValues,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  unknown
>
type TransactionFormLookupData = {
  accounts: Array<FormAccount>
  categories: Array<FormCategory>
  merchants: Array<FormMerchant>
}
type SplitEntryState = Array<SplitEntryValue>
type SplitEntryStateSetter = React.Dispatch<
  React.SetStateAction<SplitEntryState>
>

interface TransactionFormSectionProps {
  form: TransactionFormInstance
  activeTab: TransactionType
  formData?: TransactionFormLookupData
  isLoading: boolean
}

const transactionStatusOptions: Array<{
  value: TransactionStatus
  label: string
  icon: string
  activeClass: string
}> = [
  {
    value: "PENDING",
    label: "Pending",
    icon: "⏳",
    activeClass:
      "border-amber-400 bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  },
  {
    value: "CLEARED",
    label: "Cleared",
    icon: "✓",
    activeClass:
      "border-emerald-400 bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  {
    value: "RECONCILED",
    label: "Reconciled",
    icon: "⊙",
    activeClass:
      "border-blue-400 bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  },
]

/**
 * Coerce an EditAmount (which may be Money/bigint OR a JS number) to the
 * decimal-major number the HTML input expects. Currency drives the scale
 * for the bigint case.
 */
function editAmountToInputNumber(amount: EditAmount, currency: string): number {
  if (typeof amount === "bigint") {
    const code = currency as CurrencyCode
    if (CURRENCIES[code]) return toDisplayNumber(amount as Money, code)
    // Unknown currency: assume scale 100 (the modal majority case)
    return Number(amount) / 100
  }
  return amount
}

function createBlankSplitEntry(): SplitEntryValue {
  return {
    id: createUuidV7(),
    description: "",
    amount: 0,
    categoryId: "",
    merchantId: "",
  }
}

function CategoryOptions({
  categories,
  type,
}: {
  categories: Array<FormCategory> | undefined
  type: TransactionType
}) {
  return categories?.reduce<Array<React.ReactNode>>((options, category) => {
    if (category.type === type) {
      options.push(
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      )
    }
    return options
  }, [])
}

function TransactionDialogTrigger({
  customTrigger,
}: {
  customTrigger?: React.ReactNode
}) {
  return (
    <DialogTrigger asChild>
      {customTrigger ? (
        customTrigger
      ) : (
        <Button className="bg-yellow-500 font-bold text-black shadow-md hover:bg-yellow-600">
          <IconPlus className="mr-2 size-4" /> New Transaction
        </Button>
      )}
    </DialogTrigger>
  )
}

function TransactionTypeTabs({
  activeTab,
  form,
  setActiveTab,
}: {
  activeTab: TransactionType
  form: TransactionFormInstance
  setActiveTab: React.Dispatch<React.SetStateAction<TransactionType>>
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => {
        const selectedType = v as TransactionType
        setActiveTab(selectedType)
        form.setFieldValue("type", selectedType)
        if (selectedType === "transfer") form.setFieldValue("categoryId", "")
        else form.setFieldValue("toAccountId", "")
      }}
      className="mt-2 w-full"
    >
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger
          value="expense"
          className="data-[state=active]:text-red-600"
        >
          <IconArrowUpRight className="mr-1 size-4" /> Expense
        </TabsTrigger>
        <TabsTrigger
          value="income"
          className="data-[state=active]:text-emerald-600"
        >
          <IconArrowDownLeft className="mr-1 size-4" /> Income
        </TabsTrigger>
        <TabsTrigger
          value="transfer"
          className="data-[state=active]:text-blue-600"
        >
          <IconArrowsExchange className="mr-1 size-4" /> Transfer
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function FormErrorBanner({ formError }: { formError: string | null }) {
  if (!formError) return null

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive dark:bg-destructive/20"
    >
      <span aria-hidden="true" className="mt-0.5">
        ⚠
      </span>
      <span className="flex-1">{formError}</span>
    </div>
  )
}

function DescriptionField({
  activeTab,
  form,
}: Pick<TransactionFormSectionProps, "activeTab" | "form">) {
  return (
    <form.Field
      name="description"
      validators={{
        onChange: transactionSchema.shape.description,
      }}
    >
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={field.name}>
            {activeTab === "transfer" ? "Transfer Note *" : "Description *"}
          </Label>
          <Input
            id={field.name}
            name={field.name}
            placeholder={
              activeTab === "transfer"
                ? "e.g., Transfer to savings account"
                : "e.g., Target shopping, February Salary"
            }
            value={field.state.value}
            onBlur={field.handleBlur}
            onChange={(e) => field.handleChange(e.target.value)}
            aria-invalid={field.state.meta.errors.length > 0}
            aria-describedby={
              field.state.meta.errors.length > 0
                ? `${field.name}-error`
                : undefined
            }
          />
          <FieldError
            id={`${field.name}-error`}
            errors={field.state.meta.errors}
          />
        </div>
      )}
    </form.Field>
  )
}

function AmountAccountFields({
  activeTab,
  form,
  formData,
  isLoading,
}: TransactionFormSectionProps) {
  return (
    <div
      className={cn(
        "grid gap-4",
        activeTab === "transfer" ? "grid-cols-1" : "grid-cols-2"
      )}
    >
      <form.Field
        name="amount"
        validators={{
          onChange: transactionSchema.shape.amount,
        }}
      >
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Amount *</Label>
            <div className="relative">
              <form.Subscribe selector={(state) => state.values.accountId}>
                {(currentAccountId) => {
                  const selectedCurrency =
                    formData?.accounts.find((a) => a.id === currentAccountId)
                      ?.currency ?? "IDR"
                  return (
                    <span className="absolute top-2.5 left-3 text-sm font-medium text-muted-foreground">
                      {getCurrencySymbol(selectedCurrency)}
                    </span>
                  )
                }}
              </form.Subscribe>
              <Input
                id={field.name}
                name={field.name}
                type="number"
                className="pl-7 text-lg font-bold"
                value={field.state.value || ""}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(Number(e.target.value))}
                aria-invalid={field.state.meta.errors.length > 0}
                aria-describedby={
                  field.state.meta.errors.length > 0
                    ? `${field.name}-error`
                    : undefined
                }
              />
            </div>
            <FieldError
              id={`${field.name}-error`}
              errors={field.state.meta.errors}
            />
          </div>
        )}
      </form.Field>

      {activeTab !== "transfer" && (
        <form.Field
          name="accountId"
          validators={{
            onChange: transactionSchema.shape.accountId,
          }}
        >
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={field.name}>Account *</Label>
              <select
                id={field.name}
                name={field.name}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive/30"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                disabled={isLoading}
                aria-invalid={field.state.meta.errors.length > 0}
                aria-describedby={
                  field.state.meta.errors.length > 0
                    ? `${field.name}-error`
                    : undefined
                }
              >
                <option value="" disabled>
                  {isLoading ? "Loading..." : "Select Account"}
                </option>
                {formData?.accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.currency})
                  </option>
                ))}
              </select>
              <FieldError
                id={`${field.name}-error`}
                errors={field.state.meta.errors}
              />
            </div>
          )}
        </form.Field>
      )}
    </div>
  )
}

function TransferAccountFields({
  activeTab,
  form,
  formData,
  isLoading,
}: TransactionFormSectionProps) {
  if (activeTab !== "transfer") return null

  return (
    <div className="grid grid-cols-2 gap-4">
      <form.Field
        name="accountId"
        validators={{
          onChange: transactionSchema.shape.accountId,
        }}
      >
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="transfer-source-accountId">From Account *</Label>
            <select
              id="transfer-source-accountId"
              name={field.name}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive/30"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              disabled={isLoading}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={
                field.state.meta.errors.length > 0
                  ? `transfer-source-accountId-error`
                  : undefined
              }
            >
              <option value="" disabled>
                {isLoading ? "Loading..." : "Select Source"}
              </option>
              {formData?.accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.currency})
                </option>
              ))}
            </select>
            <FieldError
              id="transfer-source-accountId-error"
              errors={field.state.meta.errors}
            />
          </div>
        )}
      </form.Field>

      <form.Field
        name="toAccountId"
        validators={{
          onChange: z.string().min(1, "Destination account is required"),
        }}
      >
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>To Account *</Label>
            <form.Subscribe selector={(state) => state.values.accountId}>
              {(currentAccountId) => (
                <select
                  id={field.name}
                  name={field.name}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive/30"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  disabled={isLoading}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby={
                    field.state.meta.errors.length > 0
                      ? `${field.name}-error`
                      : undefined
                  }
                >
                  <option value="" disabled>
                    {isLoading ? "Loading..." : "Select Destination"}
                  </option>
                  {formData?.accounts.map((acc) => (
                    <option
                      key={acc.id}
                      value={acc.id}
                      disabled={acc.id === currentAccountId}
                    >
                      {acc.name} ({acc.currency})
                    </option>
                  ))}
                </select>
              )}
            </form.Subscribe>
            <FieldError
              id={`${field.name}-error`}
              errors={field.state.meta.errors}
            />
          </div>
        )}
      </form.Field>
    </div>
  )
}

function DestinationAmountField({
  activeTab,
  form,
  formData,
}: Pick<TransactionFormSectionProps, "activeTab" | "form" | "formData">) {
  if (activeTab !== "transfer") return null

  return (
    <form.Subscribe
      selector={(state) => ({
        accountId: state.values.accountId,
        toAccountId: state.values.toAccountId,
        sourceAmount: state.values.amount,
      })}
    >
      {({ accountId, toAccountId, sourceAmount }) => {
        const srcAccount = formData?.accounts.find((a) => a.id === accountId)
        const dstAccount = formData?.accounts.find((a) => a.id === toAccountId)
        const isCrossCurrency =
          srcAccount &&
          dstAccount &&
          srcAccount.currency !== dstAccount.currency

        if (!isCrossCurrency) return null

        return (
          <form.Field name="destinationAmount">
            {(field) => (
              <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3 dark:border-blue-800 dark:bg-blue-950/20">
                <Label
                  htmlFor="destination-amount"
                  className="flex items-center gap-1.5 text-sm font-semibold text-blue-700 dark:text-blue-400"
                >
                  <IconArrowsExchange className="size-4" />
                  Destination Amount ({dstAccount.currency})
                </Label>
                <p className="text-xs text-muted-foreground">
                  Enter the EXACT amount credited to the destination account.
                  This locks the implied exchange rate for historical accuracy.
                </p>
                <div className="relative">
                  <span className="absolute top-2.5 left-3 text-sm font-medium text-muted-foreground">
                    {getCurrencySymbol(dstAccount.currency)}
                  </span>
                  <Input
                    id="destination-amount"
                    name="destination-amount"
                    type="number"
                    className="pl-8 text-lg font-bold"
                    placeholder="0"
                    value={field.state.value ?? ""}
                    onBlur={field.handleBlur}
                    onChange={(e) =>
                      field.handleChange(
                        e.target.value ? Number(e.target.value) : undefined
                      )
                    }
                  />
                </div>
                {field.state.value && sourceAmount > 0 && (
                  <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
                    Implied rate: 1 {srcAccount.currency} ={" "}
                    {(field.state.value / sourceAmount).toLocaleString(
                      "en-US",
                      {
                        minimumFractionDigits: 4,
                        maximumFractionDigits: 4,
                      }
                    )}{" "}
                    {dstAccount.currency}
                  </p>
                )}
              </div>
            )}
          </form.Field>
        )
      }}
    </form.Subscribe>
  )
}

function DateTimeFields({ form }: Pick<TransactionFormSectionProps, "form">) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-4">
      <form.Field name="date">
        {(field) => (
          <div className="flex flex-col gap-2">
            <Label htmlFor="transaction-date">Date *</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  id="transaction-date"
                  name="transaction-date"
                  variant={"outline"}
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !field.state.value && "text-muted-foreground"
                  )}
                >
                  <IconCalendar className="mr-2 size-4" />
                  {field.state.value ? (
                    format(field.state.value, "PPP")
                  ) : (
                    <span>Pick a date</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={field.state.value}
                  onSelect={(picked) => {
                    if (!picked) return
                    const existing = field.state.value
                    const merged = new Date(picked)
                    merged.setHours(
                      existing.getHours(),
                      existing.getMinutes(),
                      0,
                      0
                    )
                    field.handleChange(merged)
                  }}
                  autoFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        )}
      </form.Field>

      <form.Field name="date">
        {(field) => (
          <div className="flex min-w-35 flex-col gap-2">
            <Label
              htmlFor="transaction-time"
              className="flex items-center gap-1"
            >
              <IconClock className="size-3" /> Time
            </Label>
            <TimeInput
              id="transaction-time"
              name="transaction-time"
              value={field.state.value}
              onChange={(newDate) => {
                const existing = field.state.value
                const merged = new Date(existing)
                merged.setHours(newDate.getHours(), newDate.getMinutes(), 0, 0)
                field.handleChange(merged)
              }}
            />
          </div>
        )}
      </form.Field>
    </div>
  )
}

function MerchantField({
  activeTab,
  form,
  formData,
  isLoading,
}: TransactionFormSectionProps) {
  if (activeTab === "transfer") return null

  return (
    <form.Field name="merchantId">
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={field.name}>Merchant (Optional)</Label>
          <select
            id={field.name}
            name={field.name}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            disabled={isLoading}
          >
            <option value="">-- No Merchant / General --</option>
            {formData?.merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </form.Field>
  )
}

function SplitModeToggle({
  activeTab,
  isSplit,
  setIsSplit,
}: {
  activeTab: TransactionType
  isSplit: boolean
  setIsSplit: React.Dispatch<React.SetStateAction<boolean>>
}) {
  if (activeTab === "transfer") return null

  return (
    <div className="flex items-center justify-between rounded-md border border-dashed px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconScissors className="size-4" />
        <Label
          htmlFor="split-mode-toggle"
          className="cursor-pointer text-sm font-medium"
        >
          Split Transaction
        </Label>
        {isSplit && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700">
            ACTIVE
          </span>
        )}
      </div>
      <Switch
        id="split-mode-toggle"
        checked={isSplit}
        onCheckedChange={setIsSplit}
      />
    </div>
  )
}

function CategoryField({
  activeTab,
  form,
  formData,
  isLoading,
  isSplit,
}: TransactionFormSectionProps & { isSplit: boolean }) {
  if (activeTab === "transfer" || isSplit) return null

  return (
    <form.Field
      name="categoryId"
      validators={{
        onChange: z.string().min(1, "Category is required"),
      }}
    >
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={field.name}>Category *</Label>
          <select
            id={field.name}
            name={field.name}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive/30"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            disabled={isLoading}
            aria-invalid={field.state.meta.errors.length > 0}
            aria-describedby={
              field.state.meta.errors.length > 0
                ? `${field.name}-error`
                : undefined
            }
          >
            <option value="" disabled>
              {isLoading ? "Loading..." : "Select Category"}
            </option>
            <CategoryOptions
              categories={formData?.categories}
              type={activeTab}
            />
          </select>
          <FieldError
            id={`${field.name}-error`}
            errors={field.state.meta.errors}
          />
        </div>
      )}
    </form.Field>
  )
}

function SplitEntriesPanel({
  activeTab,
  form,
  formData,
  isSplit,
  setSplitEntries,
  splitEntries,
}: Pick<TransactionFormSectionProps, "activeTab" | "form" | "formData"> & {
  isSplit: boolean
  setSplitEntries: SplitEntryStateSetter
  splitEntries: SplitEntryState
}) {
  if (!isSplit || activeTab === "transfer") return null

  const selectedAccountCurrency =
    formData?.accounts.find((a) => a.id === form.getFieldValue("accountId"))
      ?.currency ?? "IDR"

  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-800 dark:bg-amber-950/20">
      <p className="text-xs font-semibold tracking-wider text-amber-700 uppercase dark:text-amber-400">
        Category Allocation
      </p>

      <div className="grid grid-cols-[1fr_1.6fr_6rem_1.5rem] gap-2 px-0.5">
        <span className="text-xs font-medium text-muted-foreground">
          Category
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          Item Note
        </span>
        <span className="text-right text-xs font-medium text-muted-foreground">
          Amount
        </span>
        <span />
      </div>

      <div className="space-y-2">
        {splitEntries.map((entry) => (
          <div
            key={entry.id}
            className="grid grid-cols-[1fr_1.6fr_6rem_1.5rem] items-center gap-2"
          >
            <select
              aria-label="Category for split entry"
              name={`split-category-${entry.id}`}
              id={`split-category-${entry.id}`}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={entry.categoryId ?? ""}
              onChange={(e) =>
                setSplitEntries((prev) =>
                  prev.map((en) =>
                    en.id === entry.id
                      ? {
                          ...en,
                          categoryId: e.target.value,
                        }
                      : en
                  )
                )
              }
            >
              <option value="">-- Select --</option>
              <CategoryOptions
                categories={formData?.categories}
                type={activeTab}
              />
            </select>

            <Input
              aria-label="Description for split entry"
              name={`split-desc-${entry.id}`}
              id={`split-desc-${entry.id}`}
              placeholder="e.g., Soap & Shampoo"
              className="h-8 text-sm"
              value={entry.description}
              onChange={(e) =>
                setSplitEntries((prev) =>
                  prev.map((en) =>
                    en.id === entry.id
                      ? {
                          ...en,
                          description: e.target.value,
                        }
                      : en
                  )
                )
              }
            />

            <Input
              aria-label="Amount for split entry"
              name={`split-amount-${entry.id}`}
              id={`split-amount-${entry.id}`}
              type="number"
              placeholder="0"
              className="h-8 text-right text-sm font-semibold"
              value={entry.amount || ""}
              onChange={(e) =>
                setSplitEntries((prev) =>
                  prev.map((en) =>
                    en.id === entry.id
                      ? {
                          ...en,
                          amount: Number(e.target.value),
                        }
                      : en
                  )
                )
              }
            />

            <button
              type="button"
              disabled={splitEntries.length <= 2}
              onClick={() =>
                setSplitEntries((prev) =>
                  prev.filter((en) => en.id !== entry.id)
                )
              }
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-red-100 hover:text-red-600 disabled:opacity-30"
            >
              <IconX className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full border border-dashed text-xs text-muted-foreground hover:border-amber-400 hover:text-amber-700"
        onClick={() =>
          setSplitEntries((prev) => [...prev, createBlankSplitEntry()])
        }
      >
        <IconPlus className="mr-1 size-3" /> Add Row
      </Button>

      <form.Subscribe selector={(state) => state.values.amount}>
        {(parentAmount) => {
          const splitTotal = splitEntries.reduce((s, e) => s + e.amount, 0)
          const remaining = parentAmount - splitTotal

          if (remaining === 0 && parentAmount > 0) {
            return (
              <p className="flex items-center gap-1.5 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
                <span>✓</span>
                <span>Perfect! All funds allocated</span>
              </p>
            )
          }
          if (remaining > 0) {
            return (
              <p className="flex items-center gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                <span>○</span>
                <span>
                  Remaining{" "}
                  <strong>
                    {getCurrencySymbol(selectedAccountCurrency)}{" "}
                    {remaining.toLocaleString("en-US")}
                  </strong>{" "}
                  unallocated
                </span>
              </p>
            )
          }
          return (
            <p className="flex items-center gap-1.5 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-600 dark:bg-red-950/30 dark:text-red-400">
              <span>✕</span>
              <span>
                Over allocated by{" "}
                <strong>
                  {getCurrencySymbol(selectedAccountCurrency)}{" "}
                  {Math.abs(remaining).toLocaleString("en-US")}
                </strong>
              </span>
            </p>
          )
        }}
      </form.Subscribe>
    </div>
  )
}

function StatusField({ form }: Pick<TransactionFormSectionProps, "form">) {
  return (
    <form.Field name="status">
      {(field) => (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Status</Label>
          <div className="flex gap-2">
            {transactionStatusOptions.map((status) => (
              <button
                key={status.value}
                type="button"
                onClick={() => field.handleChange(status.value)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold transition-all",
                  field.state.value === status.value
                    ? status.activeClass
                    : "border-input bg-background text-muted-foreground hover:border-zinc-400 dark:hover:border-zinc-500"
                )}
              >
                <span>{status.icon}</span>
                <span>{status.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </form.Field>
  )
}

function NotesField({
  activeTab,
  form,
}: Pick<TransactionFormSectionProps, "activeTab" | "form">) {
  if (activeTab === "transfer") return null

  return (
    <form.Field name="notes">
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={field.name}>Notes (Optional)</Label>
          <Textarea
            id={field.name}
            name={field.name}
            placeholder="Add additional details here..."
            className="resize-none"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        </div>
      )}
    </form.Field>
  )
}

function AttachmentField({ form }: Pick<TransactionFormSectionProps, "form">) {
  return (
    <form.Field name="attachmentUrl">
      {(field) => (
        <div className="space-y-2">
          <Label
            htmlFor="attachment-url"
            className="flex items-center gap-1.5 text-sm"
          >
            <IconPaperclip className="size-3.5" />
            Receipt / Attachment URL
            <span className="text-xs font-normal text-muted-foreground">
              (Optional)
            </span>
          </Label>
          <Input
            id="attachment-url"
            name="attachment-url"
            type="url"
            placeholder="https://... (paste receipt photo URL)"
            value={field.state.value ?? ""}
            onBlur={field.handleBlur}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        </div>
      )}
    </form.Field>
  )
}

function TransactionActionBar({
  activeTab,
  form,
  isEditMode,
  isSplit,
  onCancel,
  onDelete,
  splitEntries,
}: {
  activeTab: TransactionType
  form: TransactionFormInstance
  isEditMode: boolean
  isSplit: boolean
  onCancel: () => void
  onDelete: () => void | Promise<void>
  splitEntries: SplitEntryState
}) {
  return (
    <form.Subscribe selector={(state) => state.values.amount}>
      {(parentAmount) => {
        const splitTotal = splitEntries.reduce((s, e) => s + e.amount, 0)
        const remaining = parentAmount - splitTotal
        const isSaveDisabled =
          isSplit && activeTab !== "transfer" && remaining !== 0

        return (
          <div className="mt-6 flex items-center justify-between border-t pt-4">
            <div>
              {isEditMode && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={onDelete}
                  className="bg-red-500/10 text-red-600 hover:bg-red-500/20"
                >
                  <IconTrash className="mr-2 size-4" /> Delete
                </Button>
              )}
            </div>

            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSaveDisabled}
                className="bg-yellow-500 font-bold text-black hover:bg-yellow-600 disabled:opacity-50"
              >
                {isEditMode ? "Update Changes" : "Save Transaction"}
              </Button>
            </div>
          </div>
        )
      }}
    </form.Subscribe>
  )
}

function useTransactionFormModalController({
  editData,
  onClose,
}: Pick<TransactionFormModalProps, "editData" | "onClose">) {
  const isEditMode = !!editData

  // THE TOP-LEVEL FIX:
  // Jika dia lahir membawa editData, dia otomatis terbuka dari sananya! Zero re-render.
  const [isOpen, setIsOpen] = React.useState(isEditMode)

  const [activeTab, setActiveTab] = React.useState<
    "expense" | "income" | "transfer"
  >(isEditMode ? editData.type : "expense")

  // === SPLIT TRANSACTION ENGINE STATE ===
  // isSplit: toggle untuk mengaktifkan mode split
  const [isSplit, setIsSplit] = React.useState(editData?.isSplit ?? false)
  // splitEntries: array baris line item yang bisa ditambah/hapus secara dinamis.
  // Initialize from editData by converting any bigint amounts to display numbers
  // (the form input is `<input type="number">`). The edit currency is taken
  // from editData.currency, falling back to "IDR".
  const editCurrency = editData?.currency ?? "IDR"
  const [splitEntries, setSplitEntries] = React.useState<
    Array<SplitEntryValue>
  >(
    editData?.splitEntries
      ? editData.splitEntries.map((e) => ({
          id: e.id,
          description: e.description,
          amount: editAmountToInputNumber(e.amount, editCurrency),
          categoryId: e.categoryId,
          merchantId: e.merchantId,
        }))
      : [createBlankSplitEntry(), createBlankSplitEntry()]
  )

  useHotkeys([
    {
      hotkey: "Shift+N",
      callback: (e) => {
        if (!isEditMode) {
          e.preventDefault()
          setIsOpen(true)
        }
      },
      // === NEW: Mencegah spam peringatan di console ===
      options: { conflictBehavior: "replace" },
    },
  ])

  const { data: formData, isLoading } = useQuery<{
    accounts: Array<FormAccount>
    categories: Array<FormCategory>
    merchants: Array<FormMerchant>
  }>({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  const defaultFormValues: TransactionFormValues = isEditMode
    ? {
        type: editData.type,
        // Convert Money (bigint) → decimal-major for the HTML input. abs()
        // on the resulting number is a fallback for the unlikely number-input
        // path; bigint amounts from the collection are already pre-abs'd by
        // the route's onEdit handler.
        amount: Math.abs(
          editAmountToInputNumber(editData.amount, editCurrency)
        ),
        description: editData.description,
        accountId: editData.accountId,
        categoryId: editData.categoryId ?? "",
        toAccountId: editData.toAccountId ?? "",
        merchantId: editData.merchantId ?? "",
        date: new Date(editData.date),
        notes: editData.notes ?? "",
        status: "CLEARED" as const,
        destinationAmount: undefined,
        attachmentUrl: "",
      }
    : {
        type: "expense" as const,
        amount: 0,
        description: "",
        accountId: "",
        categoryId: "",
        toAccountId: "",
        merchantId: "",
        // Auto-capture waktu saat ini agar presisi urutan ledger terjamin
        date: new Date(),
        notes: "",
        status: "CLEARED" as const,
        destinationAmount: undefined,
        attachmentUrl: "",
      }

  // Form-level error state for cross-field rules that can't live on a single
  // field (split-parity, missing-split-row description, post-submit server
  // failures). Field-level errors stay local to their <FieldError> sibling;
  // this banner is reserved for issues that span >1 field or a row collection.
  const [formError, setFormError] = React.useState<string | null>(null)

  const form = useForm<
    TransactionFormValues,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    unknown
  >({
    defaultValues: defaultFormValues,
    onSubmit: async ({ value }) => {
      // Field-level validators (wired below on each <form.Field>) already
      // catch the per-field required rules and surface them inline via
      // <FieldError>. Submission is gated on TanStack Form's validation
      // pass, so by the time we reach this handler the per-field rules are
      // already green. What remains here are the *cross-field* rules.
      setFormError(null)

      // Cross-field rule: split mode total must equal the parent amount,
      // and every split row must have a description. The submit button is
      // already disabled when split is unbalanced (see action bar), so this
      // is a defense-in-depth check; we still set formError so the banner
      // shows the *reason* the submission was rejected if a race lands here.
      if (isSplit && value.type !== "transfer") {
        if (!value.description) {
          // Split mode hides the parent description; auto-label it so the
          // ledger row is still self-describing.
          form.setFieldValue("description", "Split Transaction")
          value.description = "Split Transaction"
        }
        const splitTotal = splitEntries.reduce((sum, e) => sum + e.amount, 0)
        if (Math.abs(splitTotal - value.amount) > 0.01) {
          setFormError(
            `Split total (${splitTotal.toLocaleString()}) must equal the transaction amount (${value.amount.toLocaleString()}).`
          )
          return
        }
        if (splitEntries.some((e) => !e.description)) {
          setFormError("Every split row needs a description.")
          return
        }
      }

      try {
        // === MONEY CONVERSION (post-ADR-0001) ===
        // The form binds to <input type="number"> so `value.amount` is a
        // decimal-major JS number (e.g. 15000 means Rp 15,000). Before the
        // optimistic insert/update, convert to `Money` (bigint minor units)
        // using the source account's currency. This is the ONLY conversion
        // boundary on the client; everything downstream sees Money.
        const sourceCurrency =
          formData?.accounts.find((a) => a.id === value.accountId)?.currency ??
          "IDR"
        const destCurrency =
          value.type === "transfer" && value.toAccountId
            ? (formData?.accounts.find((a) => a.id === value.toAccountId)
                ?.currency ?? null)
            : null

        const toMoney = (n: number, code: string): Money => {
          const c = code as CurrencyCode
          if (CURRENCIES[c]) return toMinorUnits(n.toString(), c)
          // Fallback: treat as IDR-style ×100 currency to avoid runtime crash
          // for an unknown code; the server's Zod will reject if it's bogus.
          return BigInt(Math.round(n * 100)) as Money
        }

        const amountMoney: Money = toMoney(value.amount, sourceCurrency)
        const destAmountMoney: Money | null =
          value.destinationAmount != null && destCurrency
            ? toMoney(value.destinationAmount, destCurrency)
            : null
        const selectedAccount = formData?.accounts.find(
          (a) => a.id === value.accountId
        )
        const selectedToAccount =
          value.toAccountId && value.type === "transfer"
            ? formData?.accounts.find((a) => a.id === value.toAccountId)
            : null
        const accountRelation = selectedAccount
          ? {
              accountType: selectedAccount.accountType,
              color: selectedAccount.color,
              name: selectedAccount.name,
              type: selectedAccount.accountType,
            }
          : {
              accountType: "",
              color: null,
              name: "...",
              type: "",
            }
        const toAccountRelation = selectedToAccount
          ? {
              accountType: selectedToAccount.accountType,
              color: selectedToAccount.color,
              name: selectedToAccount.name,
              type: selectedToAccount.accountType,
            }
          : null

        const payload = {
          type: value.type,
          kind: value.type === "transfer" ? "funds_movement" : "standard",
          amount: amountMoney,
          description: value.description,
          accountId: value.accountId,
          categoryId: isSplit ? null : value.categoryId || null,
          toAccountId: value.toAccountId || null,
          merchantId: isSplit ? null : value.merchantId || null,
          date: value.date,
          notes: value.notes || null,
          isSplit: value.type === "transfer" ? false : isSplit,
          splitEntries:
            isSplit && value.type !== "transfer"
              ? splitEntries.map((e) => ({
                  // Include client-side id agar React punya key stabil di optimistic state
                  id: e.id,
                  description: e.description,
                  amount: toMoney(e.amount, sourceCurrency),
                  categoryId: e.categoryId || null,
                  merchantId: e.merchantId || null,
                }))
              : [],
          currency: sourceCurrency,
          excluded: false,
          status: value.status ?? "CLEARED",
          destinationAmount: destAmountMoney,
          destinationCurrency: (() => {
            // Compute destinationCurrency from toAccountId's account currency
            if (value.type === "transfer" && value.toAccountId) {
              return (
                formData?.accounts.find((a) => a.id === value.toAccountId)
                  ?.currency ?? null
              )
            }
            return null
          })(),
          accountBalanceAfter: null, // Computed server-side
          attachmentUrl: value.attachmentUrl || null,
          deletedAt: null,
          userId: "",
          account: accountRelation,
          toAccount: toAccountRelation,
          // Jika split, category di parent null
          category:
            !isSplit && value.categoryId
              ? (formData?.categories.find((c) => c.id === value.categoryId) ??
                null)
              : null,
          merchant:
            !isSplit && value.merchantId
              ? (formData?.merchants.find((m) => m.id === value.merchantId) ??
                null)
              : null,
          updatedAt: new Date(),
        }

        if (editData) {
          // Hanya Update UI Lokal (Optimistic)
          // PENTING: Gunakan Immer Draft Pattern — mutate draft, JANGAN reassign!
          // (docs: "Passing an object instead of draft callback silently fails")
          transactionCollection.update(editData.id, (draft) => {
            draft.type = payload.type
            draft.kind = payload.kind
            draft.amount = payload.amount
            draft.description = payload.description
            draft.accountId = payload.accountId
            draft.categoryId = payload.categoryId
            draft.toAccountId = payload.toAccountId
            draft.merchantId = payload.merchantId
            draft.date = payload.date
            draft.notes = payload.notes
            draft.currency = payload.currency
            ;(draft as Record<string, unknown>)["status"] = payload.status
            ;(draft as Record<string, unknown>)["destinationAmount"] =
              payload.destinationAmount
            ;(draft as Record<string, unknown>)["destinationCurrency"] =
              payload.destinationCurrency
            ;(draft as Record<string, unknown>)["attachmentUrl"] =
              payload.attachmentUrl
            draft.updatedAt = payload.updatedAt
            // Immer draft hanya mengenal scalar fields di schema collection-nya.
            // Relasi dan field baru (account, isSplit, splitEntries) di-cast secara eksplisit.
            const relationDraft =
              draft as unknown as OptimisticTransactionRelationDraft
            relationDraft.account = payload.account
            relationDraft.toAccount = payload.toAccount
            relationDraft.category = payload.category
            relationDraft.merchant = payload.merchant
            relationDraft.isSplit = payload.isSplit
            relationDraft.splitEntries = payload.splitEntries
          })
        } else {
          // 1. Generate Client-Side ID untuk Sinkronisasi Optimistic ke Database
          const optimisticId = createUuidV7()
          const idempotencyKey = createUuidV7()

          // 2. CUKUP Insert ke UI Lokal saja!
          // Arsitektur kita di collections.ts (onInsert) akan melanjutkannya ke server secara gaib.
          transactionCollection.insert({
            ...payload,
            id: optimisticId,
            idempotencyKey,
            supersededBy: null,
            supersedes: null,
            createdAt: new Date(),
            familyId: "",
            // FX base projection (PER-147) is materialized server-side; the
            // optimistic row is "FX-pending" until the post-mutation refetch
            // backfills it from the server source of truth.
            baseAmount: null,
            baseCurrency: null,
            fxRateScaled: null,
            fxRateSnapshotId: null,
            // splitEntries di optimistic payload adalah versi ringkas (tanpa relasi Prisma)
            splitEntries:
              payload.splitEntries as TransactionRecord["splitEntries"],
          })
        }

        setIsOpen(false)
        if (onClose) onClose()

        if (!isEditMode) form.reset()
      } catch (error: unknown) {
        console.error("Failed to save transaction:", error)
        setFormError(
          error instanceof Error
            ? `Could not save transaction: ${error.message}`
            : "Could not save transaction. Please try again."
        )
      }
    },
  })

  // FUNGSI DELETE
  const handleDelete = async () => {
    if (!editData) return
    const confirmed = window.confirm(
      "Are you sure you want to delete this transaction? This action will reverse all balances."
    )
    if (confirmed) {
      try {
        // Hapus dari UI Lokal secara Optimistic
        // Sinkronisasi ke database akan digerakkan oleh collections.ts (onDelete)
        transactionCollection.delete(editData.id)
        setIsOpen(false)
        if (onClose) onClose()
      } catch (error: unknown) {
        console.error("Failed to delete transaction:", error)
        alert(
          "An error occurred while deleting the transaction. Please try again."
        )
      }
    }
  }

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    // == NEW: Beritahu parent (transaction.tsx) bahwa modal ditutup
    if (!open && onClose) {
      onClose()
    }
    if (open && editData) {
      setActiveTab(editData.type)
      form.reset()
    }
  }

  const handleCancel = () => {
    setIsOpen(false)
    if (onClose) onClose()
  }

  return {
    activeTab,
    form,
    formData,
    formError,
    handleCancel,
    handleDelete,
    handleOpenChange,
    isEditMode,
    isLoading,
    isOpen,
    isSplit,
    setActiveTab,
    setIsSplit,
    setSplitEntries,
    splitEntries,
  }
}

export function TransactionFormModal({
  editData,
  customTrigger,
  onClose,
}: TransactionFormModalProps) {
  const {
    activeTab,
    form,
    formData,
    formError,
    handleCancel,
    handleDelete,
    handleOpenChange,
    isEditMode,
    isLoading,
    isOpen,
    isSplit,
    setActiveTab,
    setIsSplit,
    setSplitEntries,
    splitEntries,
  } = useTransactionFormModalController({ editData, onClose })

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <TransactionDialogTrigger customTrigger={customTrigger} />

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit Transaction" : "Add Transaction"}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Modify your transaction details below. Balances will auto-adjust."
              : "Record your new transaction details below."}
          </DialogDescription>
        </DialogHeader>

        <TransactionTypeTabs
          activeTab={activeTab}
          form={form}
          setActiveTab={setActiveTab}
        />

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void form.handleSubmit()
          }}
          className="mt-4 space-y-4"
        >
          <FormErrorBanner formError={formError} />
          <DescriptionField activeTab={activeTab} form={form} />
          <AmountAccountFields
            activeTab={activeTab}
            form={form}
            formData={formData}
            isLoading={isLoading}
          />
          <TransferAccountFields
            activeTab={activeTab}
            form={form}
            formData={formData}
            isLoading={isLoading}
          />
          <DestinationAmountField
            activeTab={activeTab}
            form={form}
            formData={formData}
          />
          <DateTimeFields form={form} />
          <MerchantField
            activeTab={activeTab}
            form={form}
            formData={formData}
            isLoading={isLoading}
          />
          <SplitModeToggle
            activeTab={activeTab}
            isSplit={isSplit}
            setIsSplit={setIsSplit}
          />
          <CategoryField
            activeTab={activeTab}
            form={form}
            formData={formData}
            isLoading={isLoading}
            isSplit={isSplit}
          />
          <SplitEntriesPanel
            activeTab={activeTab}
            form={form}
            formData={formData}
            isSplit={isSplit}
            setSplitEntries={setSplitEntries}
            splitEntries={splitEntries}
          />
          <StatusField form={form} />
          <NotesField activeTab={activeTab} form={form} />
          <AttachmentField form={form} />
          <TransactionActionBar
            activeTab={activeTab}
            form={form}
            isEditMode={isEditMode}
            isSplit={isSplit}
            onCancel={handleCancel}
            onDelete={handleDelete}
            splitEntries={splitEntries}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
