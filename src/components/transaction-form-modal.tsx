"use client"

import * as React from "react"
import { useForm, type ReactFormExtendedApi } from "@tanstack/react-form"
import { useHotkeys } from "@tanstack/react-hotkeys"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  IconArrowBackUp,
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
import { createMerchantFn } from "@/server/merchants"
import { createCategoryFn } from "@/server/categories"
import { getAccountHoldingsFn } from "@/server/holdings"
import { DialogLoadingOrError } from "@/components/blocks/dialog-loading-state"
import { TradeDialog } from "@/components/blocks/trade-dialog"
import {
  decodeMoney,
  toDisplayNumber,
  toMinorUnits,
  type Money,
} from "@/lib/money"
import {
  deriveTransferPurpose,
  TRANSFER_PURPOSE_LABELS,
  TRANSFER_PURPOSE_VALUES,
  type TransferPurpose,
} from "@/lib/money-movement"
import {
  deriveTransferKindForAccounts,
  parseAccountType,
} from "@/lib/liability-semantics"
import { CURRENCIES, type CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  balanceOverrideInputSchema,
  BALANCE_OVERRIDE_REASONS,
  isOnOrBeforeAnchorDate,
  OTHER_BALANCE_OVERRIDE_REASON,
  type BalanceOverrideReason,
} from "@/lib/balance-override"
import { getLatestGroundTruthAnchorFn } from "@/server/valuations"
import {
  EntityCombobox,
  type EntityComboboxItem,
} from "@/components/blocks/entity-combobox"

type TransactionFormData = Awaited<ReturnType<typeof getTransactionFormData>>
type FormAccount = TransactionFormData["accounts"][number]
type FormCategory = TransactionFormData["categories"][number]
type FormMerchant = TransactionFormData["merchants"][number]

import { accountCollection } from "@/lib/account-collections"
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
  // PER-247 (generalizing PER-147 / ADR-0035 §6): optional fee on ANY
  // transfer (top-up/e-wallet/bank charge, or FX spread on cross-currency).
  // Denominated in the fee-bearing account's currency; posts a separate
  // `transfer_fee`/`fx_fee` expense row server-side, linked to the Transfer.
  feeAmount: z.number().nonnegative().optional(),
  feeCategoryId: z.string().optional(),
  // Which side bears the fee (default: the source account). Constrained to
  // the two transfer accounts in this form; the server accepts any
  // tenant-owned account via feeAccountId.
  feeBearerAccountId: z.string().optional(),
  // Optional override of the taxonomy-derived transfer purpose. Empty/undefined
  // = derive server-side (→ E_WALLET = top_up, → INVESTMENT = invest, etc.).
  transferPurpose: z.enum(TRANSFER_PURPOSE_VALUES).optional(),
  // PER-196 / ADR-0048 §1: valuation-linked transfer. Only meaningful when
  // either transfer side is a balanceSource="valuation" account — prefilled
  // client-side as latest ∓ amount (see NewValuationValueField), editable.
  // Left undefined, the server computes the same prefill from fresher data.
  newValuationValue: z.number().optional(),
  // PER-267 / ADR-0043's PER-264 amendment — the "ubah saldo juga" override.
  // Undefined (the default) = "Catat (saldo tetap)": submit normally, no
  // balance-override intent at all. Present only when the user explicitly
  // opted in via BackdatedAnchorBanner; the server re-verifies the gating
  // condition independently (see `applyBalanceOverride`,
  // src/server/transactions.ts) rather than trusting this flag alone.
  balanceOverride: balanceOverrideInputSchema.optional(),
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
    | (Omit<
        TransactionFormValues,
        "amount" | "destinationAmount" | "transferPurpose"
      > & {
        id: string
        amount: EditAmount
        destinationAmount?: EditAmount
        currency?: string
        // PER-260 / ADR-0055: "reimbursement" pre-checks the refund toggle on
        // edit so re-saving an existing reimbursement doesn't silently revert
        // it to a plain income row. Absent/null/"standard" = plain income.
        kind?: string | null
        // PER-247: hydrated from the canonical Transfer row on the ledger
        // record (see findLedgerTransactionsForFamily).
        transferPurpose?: string | null
        transferFee?: {
          accountId: string
          amount: string
          categoryId: string | null
          currency: string
        } | null
        isSplit?: boolean
        splitEntries?: Array<
          Omit<SplitEntryValue, "amount"> & { amount: EditAmount }
        >
      })
    | null
  customTrigger?: React.ReactNode
  onClose?: () => void
  // Seeds the source account when opening the CREATE form (e.g. "Add
  // transaction" launched from a specific account's detail page). Ignored in
  // edit mode, where the account comes from `editData`.
  defaultAccountId?: string
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
  isReimbursement,
  setActiveTab,
  setIsReimbursement,
}: {
  activeTab: TransactionType
  form: TransactionFormInstance
  isReimbursement: boolean
  setActiveTab: React.Dispatch<React.SetStateAction<TransactionType>>
  setIsReimbursement: React.Dispatch<React.SetStateAction<boolean>>
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => {
        const selectedType = v as TransactionType
        setActiveTab(selectedType)
        form.setFieldValue("type", selectedType)
        if (selectedType === "transfer") {
          form.setFieldValue("categoryId", "")
          // PER-267: the balance-override banner is expense/income-only
          // (BackdatedAnchorBanner); a stray selection must not silently
          // ride into a transfer submission the server would reject.
          form.setFieldValue("balanceOverride", undefined)
        } else form.setFieldValue("toAccountId", "")
        // PER-260: the reimbursement toggle + its expense-category picker
        // only make sense on the Income tab. Leaving Income while it was ON
        // resets it AND the now-mismatched expense-category id, so a stray
        // reimbursement category can never ride along into an
        // Expense/Transfer submission. Never touches categoryId when the
        // toggle was already off — today's tab-switch behavior is unchanged.
        if (selectedType !== "income" && isReimbursement) {
          setIsReimbursement(false)
          if (selectedType !== "transfer") form.setFieldValue("categoryId", "")
        }
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
                onChange={(e) => {
                  field.handleChange(e.target.value)
                  // PER-267: a balance-override reason was picked against the
                  // PREVIOUS account's anchor situation; it has no meaning for
                  // whatever account is selected now (no-use-effect Rule 3 —
                  // clear it directly in the event that changes the account,
                  // not via a watching effect).
                  form.setFieldValue("balanceOverride", undefined)
                }}
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

// PER-259 / ADR-0054 — a holdings-tracked account moves money ONLY through
// trades. Marking those options tells the user BEFORE they fill in a whole
// transfer that this leg cannot be one.
function accountOptionLabel(account: FormAccount): string {
  return `${account.name} (${account.currency})${
    account.hasHoldings ? " · holdings" : ""
  }`
}

// Which leg of the in-progress transfer is a holdings account, and therefore
// which trade it should become: money INTO the position is a Buy, money OUT of
// it is a Sell. The counterpart leg is the cash account the user already
// picked, which pre-fills the trade's funding/destination account.
function holdingsTransferLeg(
  formData: TransactionFormLookupData | undefined,
  accountId: string | undefined,
  toAccountId: string | undefined
): {
  investmentAccount: FormAccount
  counterpartAccountId: string | undefined
  side: "buy" | "sell"
} | null {
  const source = formData?.accounts.find((a) => a.id === accountId)
  const destination = formData?.accounts.find((a) => a.id === toAccountId)
  if (destination?.hasHoldings) {
    return {
      investmentAccount: destination,
      counterpartAccountId: source?.hasHoldings ? undefined : source?.id,
      side: "buy",
    }
  }
  if (source?.hasHoldings) {
    return {
      investmentAccount: source,
      counterpartAccountId: destination?.id,
      side: "sell",
    }
  }
  return null
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
                  {accountOptionLabel(acc)}
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
                      {accountOptionLabel(acc)}
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

// PER-259 / ADR-0054 — the global ledger's Transfer tab used to let a user fill
// in an entire transfer against a holdings-tracked account and only learn on
// submit, from a raw server rejection, that such an account moves money through
// trades only. The per-account page already hides that path; this teaches the
// global entry point the same rule and hands the user the REAL Buy/Sell dialog
// (`TradeDialog`, reused as-is — deliberately NOT a second "smart" form that
// tries to be both a transfer and a trade) with what they already picked
// carried over.
function HoldingsTransferNotice({
  activeTab,
  form,
  formData,
  onStartTrade,
}: Pick<TransactionFormSectionProps, "activeTab" | "form" | "formData"> & {
  onStartTrade: (redirect: HoldingsTradeRedirect) => void
}) {
  if (activeTab !== "transfer") return null

  return (
    <form.Subscribe
      selector={(state) => ({
        accountId: state.values.accountId,
        toAccountId: state.values.toAccountId,
      })}
    >
      {({ accountId, toAccountId }) => {
        const leg = holdingsTransferLeg(formData, accountId, toAccountId)
        if (leg === null) return null
        return (
          <div
            className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
            data-testid="holdings-transfer-notice"
          >
            <p>
              <span className="font-medium">{leg.investmentAccount.name}</span>{" "}
              carries holdings, so its money moves with a Buy/Sell trade, not a
              transfer. Its value is always units × price and follows your
              trades automatically.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() =>
                onStartTrade({
                  investmentAccountId: leg.investmentAccount.id,
                  side: leg.side,
                  defaultFundingAccountId: leg.counterpartAccountId,
                })
              }
            >
              {leg.side === "buy" ? "Record a buy instead" : "Record a sell"}
            </Button>
          </div>
        )
      }}
    </form.Subscribe>
  )
}

interface HoldingsTradeRedirect {
  investmentAccountId: string
  side: "buy" | "sell"
  defaultFundingAccountId: string | undefined
}

// Loads the one thing `TradeDialog` needs that the transaction form never had —
// the account's holdings — and only once the user has actually asked for the
// trade flow, so opening the transaction modal costs no extra round-trip. The
// query key matches the account page's, so a warm cache is reused.
function HoldingsTradeRedirectDialog({
  redirect,
  accounts,
  onClose,
  onSaved,
}: {
  redirect: HoldingsTradeRedirect
  accounts: Array<FormAccount>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const investmentAccount = accounts.find(
    (a) => a.id === redirect.investmentAccountId
  )
  const {
    data: holdingsView,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["account_holdings", redirect.investmentAccountId],
    queryFn: async () =>
      await getAccountHoldingsFn({
        data: { accountId: redirect.investmentAccountId },
      }),
  })

  // Cash-like accounts that can fund a buy or receive a sell — the SAME filter
  // the account page applies before handing `TradeDialog` its options.
  const fundingAccounts = React.useMemo(
    () =>
      accounts
        .filter(
          (a) =>
            a.id !== redirect.investmentAccountId &&
            a.balanceSource === "transaction_flow" &&
            a.status === "active" &&
            a.currency === investmentAccount?.currency
        )
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    [accounts, redirect.investmentAccountId, investmentAccount?.currency]
  )

  if (investmentAccount === undefined || holdingsView === undefined) {
    return (
      <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
        <DialogContent>
          <DialogLoadingOrError
            isLoading={isLoading && investmentAccount !== undefined}
            error={error}
            hasData={false}
            loadingLabel="Loading this account's positions…"
            notFoundTitle="Can't open the trade form"
            notFoundMessage="This account's positions could not be loaded."
            onClose={onClose}
          >
            {null}
          </DialogLoadingOrError>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <TradeDialog
      state={{ side: redirect.side }}
      investmentAccountId={redirect.investmentAccountId}
      currency={investmentAccount.currency}
      fundingAccounts={fundingAccounts}
      holdings={holdingsView.holdings}
      defaultFundingAccountId={redirect.defaultFundingAccountId}
      onClose={onClose}
      onSaved={onSaved}
    />
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

// PER-247 — contextual money movement fields: a purpose label (derived from
// the account taxonomy, overridable) and a fee leg on ANY transfer (not only
// cross-currency), with an explicit bearer (default: the source account).
// Both are pure derived-value renders via form.Subscribe (no-use-effect Rule
// 1) — no state sync, everything recomputes from the selected accounts.
function TransferContextFields({
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
        feeBearerAccountId: state.values.feeBearerAccountId,
      })}
    >
      {({ accountId, toAccountId, feeBearerAccountId }) => {
        const srcAccount = formData?.accounts.find((a) => a.id === accountId)
        const dstAccount = formData?.accounts.find((a) => a.id === toAccountId)
        if (!srcAccount || !dstAccount) return null

        const isCrossCurrency = srcAccount.currency !== dstAccount.currency
        const transferKind = deriveTransferKindForAccounts({
          fromAccountType: parseAccountType(srcAccount.accountType),
          toAccountType: parseAccountType(dstAccount.accountType),
        })
        // Purpose only applies to funds_movement (cc_payment / loan_payment /
        // liability_draw already carry their meaning via kind — the server
        // rejects a purpose override for them).
        const isFundsMovement = transferKind === "funds_movement"
        const derivedPurpose = isFundsMovement
          ? deriveTransferPurpose({
              fromAccountType: parseAccountType(srcAccount.accountType),
              toAccountType: parseAccountType(dstAccount.accountType),
              toAccountSubtype: dstAccount.accountSubtype,
            })
          : null

        // The fee is an expense row: it can only post on a transaction_flow
        // account (a valuation-tracked account has no expense deltas).
        const bearerOptions = [srcAccount, dstAccount].filter(
          (account) => account.balanceSource !== "valuation"
        )
        const bearerAccount =
          bearerOptions.find((a) => a.id === feeBearerAccountId) ??
          bearerOptions.find((a) => a.id === srcAccount.id) ??
          bearerOptions[0]

        return (
          <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-800 dark:bg-amber-950/20">
            {isFundsMovement && (
              <form.Field name="transferPurpose">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="transfer-purpose"
                      className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400"
                    >
                      <IconArrowsExchange className="size-4" />
                      Transfer purpose
                      <span className="text-xs font-normal text-muted-foreground">
                        (Optional)
                      </span>
                    </Label>
                    <select
                      id="transfer-purpose"
                      name="transfer-purpose"
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                      value={field.state.value ?? ""}
                      onBlur={field.handleBlur}
                      onChange={(e) =>
                        field.handleChange(
                          e.target.value
                            ? (e.target.value as TransferPurpose)
                            : undefined
                        )
                      }
                    >
                      <option value="">
                        {derivedPurpose
                          ? `Automatic — ${TRANSFER_PURPOSE_LABELS[derivedPurpose]}`
                          : "Automatic"}
                      </option>
                      {TRANSFER_PURPOSE_VALUES.map((purpose) => (
                        <option key={purpose} value={purpose}>
                          {TRANSFER_PURPOSE_LABELS[purpose]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </form.Field>
            )}

            <form.Field name="feeAmount">
              {(field) => (
                <div className="space-y-3">
                  <Label
                    htmlFor="transfer-fee-amount"
                    className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400"
                  >
                    <IconArrowsExchange className="size-4" />
                    {isCrossCurrency
                      ? `FX / transfer fee (${bearerAccount?.currency ?? srcAccount.currency})`
                      : `Transfer fee (${bearerAccount?.currency ?? srcAccount.currency})`}
                    <span className="text-xs font-normal text-muted-foreground">
                      (Optional)
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {isCrossCurrency
                      ? "The bank or exchange spread charged on this conversion."
                      : "The fee charged on this movement (e.g. an e-wallet top-up charge)."}{" "}
                    Posted as a separate expense — it never distorts the
                    transferred amounts.
                  </p>
                  <div className="relative">
                    <span className="absolute top-2.5 left-3 text-sm font-medium text-muted-foreground">
                      {getCurrencySymbol(
                        bearerAccount?.currency ?? srcAccount.currency
                      )}
                    </span>
                    <Input
                      id="transfer-fee-amount"
                      name="transfer-fee-amount"
                      type="number"
                      className="pl-8 font-semibold"
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
                </div>
              )}
            </form.Field>

            {bearerOptions.length > 1 && (
              <form.Field name="feeBearerAccountId">
                {(bearerField) => (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="fee-bearer-account"
                      className="text-xs text-muted-foreground"
                    >
                      Fee paid by (default: source account)
                    </Label>
                    <select
                      id="fee-bearer-account"
                      name="fee-bearer-account"
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                      value={bearerField.state.value ?? ""}
                      onBlur={bearerField.handleBlur}
                      onChange={(e) =>
                        bearerField.handleChange(e.target.value || undefined)
                      }
                    >
                      <option value="">Source account</option>
                      {bearerOptions.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </form.Field>
            )}

            <form.Field name="feeCategoryId">
              {(categoryField) => (
                <div className="space-y-1.5">
                  <Label
                    htmlFor="transfer-fee-category"
                    className="text-xs text-muted-foreground"
                  >
                    Fee category (optional)
                  </Label>
                  <select
                    id="transfer-fee-category"
                    name="transfer-fee-category"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    value={categoryField.state.value ?? ""}
                    onChange={(e) => categoryField.handleChange(e.target.value)}
                  >
                    <option value="">-- No category --</option>
                    <CategoryOptions
                      categories={formData?.categories}
                      type="expense"
                    />
                  </select>
                </div>
              )}
            </form.Field>
          </div>
        )
      }}
    </form.Subscribe>
  )
}

// PER-196 / ADR-0048 §1 — the valuation-linked transfer field. Shown only
// when exactly one transfer side is a balanceSource="valuation" account
// (a TRACKED_ASSET like a mutual fund or gold holding — see
// docs/account-taxonomy.md). Two valuation-tracked sides is an explicit v1
// scope boundary (ADR-0048 §2), rejected server-side with a typed error, so
// this field intentionally does not render for that shape either.
//
// Prefill is a pure derived value (no-use-effect Rule 1): `trackedBalance ∓
// amount`, recomputed on every render from the live form state via
// form.Subscribe. The field itself only holds the user's manual override
// (undefined until they type); `field.state.value ?? prefill` is what's
// shown, so the box always displays a real, editable number without ever
// needing an effect to "sync" the prefill into field state.
function NewValuationValueField({
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
        amount: state.values.amount,
      })}
    >
      {({ accountId, toAccountId, amount }) => {
        const srcAccount = formData?.accounts.find((a) => a.id === accountId)
        const dstAccount = formData?.accounts.find((a) => a.id === toAccountId)
        const srcIsValuation = srcAccount?.balanceSource === "valuation"
        const dstIsValuation = dstAccount?.balanceSource === "valuation"

        if (
          !srcAccount ||
          !dstAccount ||
          srcIsValuation === dstIsValuation // neither, or both — out of scope
        ) {
          return null
        }

        const trackedAccount = srcIsValuation ? srcAccount : dstAccount
        const trackedCurrency = trackedAccount.currency as CurrencyCode
        const trackedDisplayBalance = toDisplayNumber(
          trackedAccount.balance,
          trackedCurrency
        )
        // Redemption (tracked -> cash): the withdrawal reduces the tracked
        // value. Contribution (cash -> tracked): it increases it.
        const prefill = srcIsValuation
          ? trackedDisplayBalance - amount
          : trackedDisplayBalance + amount

        return (
          <form.Field name="newValuationValue">
            {(field) => {
              const displayValue = field.state.value ?? prefill
              return (
                <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
                  <Label
                    htmlFor="new-valuation-value"
                    className="text-sm font-semibold text-emerald-700 dark:text-emerald-400"
                  >
                    New value of {trackedAccount.name}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {srcIsValuation
                      ? "Prefilled as the current value minus this withdrawal. Edit if the fund's real remaining value differs — this captures any market gain or loss since the last valuation."
                      : "Prefilled as the current value plus this contribution. Edit if the fund's real value differs — this captures any market gain or loss since the last valuation."}
                  </p>
                  <div className="relative">
                    <span className="absolute top-2.5 left-3 text-sm font-medium text-muted-foreground">
                      {getCurrencySymbol(trackedCurrency)}
                    </span>
                    <Input
                      id="new-valuation-value"
                      name="new-valuation-value"
                      type="number"
                      className="pl-8 text-lg font-bold"
                      value={displayValue}
                      onBlur={field.handleBlur}
                      onChange={(e) =>
                        field.handleChange(
                          e.target.value ? Number(e.target.value) : undefined
                        )
                      }
                    />
                  </div>
                </div>
              )
            }}
          </form.Field>
        )
      }}
    </form.Subscribe>
  )
}

// PER-267 / ADR-0043's PER-264 amendment, "UI surface" section.
//
// Derived state, not an effect: this compares the currently-selected account
// + date against that account's latest `ground_truth` anchor (a small query
// keyed on accountId, since the anchor itself doesn't depend on the chosen
// date) and renders inline — no useEffect, no local mirror of form state
// (no-use-effect Rule 1/2). Scoped to expense/income: the server's override
// path (`applyBalanceOverride`, src/server/transactions.ts) only supports a
// single-account entry, whose post-delta balance has one unambiguous meaning;
// a transfer's two legs don't.
function BackdatedAnchorBanner({
  activeTab,
  form,
}: Pick<TransactionFormSectionProps, "activeTab" | "form">) {
  if (activeTab === "transfer") return null

  return (
    <form.Subscribe
      selector={(state) => ({
        accountId: state.values.accountId,
        date: state.values.date,
      })}
    >
      {({ accountId, date }) =>
        accountId ? (
          <BackdatedAnchorBannerInner
            // Remount on account change: a chip picked for one account's
            // anchor situation must never silently carry over to another
            // account's (no-use-effect Rule 5 — reset via `key`, not effect
            // choreography). The account/date `onChange` handlers below also
            // clear `balanceOverride` directly, so the committed FORM value
            // never goes stale even while this component stays mounted for
            // the same account across a date edit.
            key={accountId}
            accountId={accountId}
            date={date}
            form={form}
          />
        ) : null
      }
    </form.Subscribe>
  )
}

function BackdatedAnchorBannerInner({
  accountId,
  date,
  form,
}: {
  accountId: string
  date: Date
  form: TransactionFormInstance
}) {
  const { data: anchor } = useQuery({
    queryKey: ["latestGroundTruthAnchor", accountId],
    queryFn: () => getLatestGroundTruthAnchorFn({ data: { accountId } }),
  })

  // Local, UI-only picker state — never the source of truth for what gets
  // submitted (that's the `balanceOverride` FORM field, set explicitly below
  // whenever the picked reason becomes complete). Keying the outer component
  // by accountId (above) resets this on account change.
  const [isExpanded, setIsExpanded] = React.useState(false)
  const [selectedReason, setSelectedReason] =
    React.useState<BalanceOverrideReason | null>(null)
  const [otherNote, setOtherNote] = React.useState("")

  if (!anchor || !isOnOrBeforeAnchorDate(date, anchor.valuationDate)) {
    return null
  }

  const anchorCurrency = anchor.currency as CurrencyCode
  const anchorDateLabel = format(
    new Date(`${anchor.valuationDate}T00:00:00`),
    "d MMM yyyy"
  )
  const anchorValueLabel = `${getCurrencySymbol(anchorCurrency)}${toDisplayNumber(
    decodeMoney(anchor.value),
    anchorCurrency
  ).toLocaleString("en-US")}`

  const resetOverride = () => {
    setIsExpanded(false)
    setSelectedReason(null)
    setOtherNote("")
    form.setFieldValue("balanceOverride", undefined)
  }

  const pickReason = (reason: BalanceOverrideReason, note: string) => {
    setSelectedReason(reason)
    setOtherNote(note)
    const isComplete =
      reason !== OTHER_BALANCE_OVERRIDE_REASON || note.trim().length > 0
    form.setFieldValue(
      "balanceOverride",
      isComplete
        ? {
            reason,
            note: reason === OTHER_BALANCE_OVERRIDE_REASON ? note : undefined,
          }
        : undefined
    )
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      data-testid="backdated-anchor-banner"
      role="status"
    >
      <p>
        Transaksi ini tetap tercatat untuk riwayat, kategori, dan anggaran —
        tapi <span className="font-semibold">tidak mengubah saldo</span> akun
        ini, karena sudah direkonsiliasi pada{" "}
        <span className="font-medium">{anchorDateLabel}</span> ke{" "}
        <span className="font-medium">{anchorValueLabel}</span>.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={resetOverride}
        >
          Catat (saldo tetap)
        </Button>
        <Button
          type="button"
          variant={isExpanded ? "secondary" : "outline"}
          size="sm"
          aria-expanded={isExpanded}
          onClick={() => (isExpanded ? resetOverride() : setIsExpanded(true))}
        >
          Ubah saldo juga
        </Button>
      </div>

      {isExpanded && (
        <div
          className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-background/60 p-2"
          data-testid="balance-override-reasons"
        >
          <p className="text-xs text-muted-foreground">Pilih alasan:</p>
          <div className="flex flex-wrap gap-1.5">
            {BALANCE_OVERRIDE_REASONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={
                  selectedReason === option.value ? "default" : "outline"
                }
                aria-pressed={selectedReason === option.value}
                onClick={() => pickReason(option.value, otherNote)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          {selectedReason === OTHER_BALANCE_OVERRIDE_REASON && (
            <Input
              placeholder="Ceritakan singkat…"
              aria-label="Alasan lainnya"
              value={otherNote}
              onChange={(e) =>
                pickReason(OTHER_BALANCE_OVERRIDE_REASON, e.target.value)
              }
            />
          )}
          <form.Subscribe selector={(state) => state.values.balanceOverride}>
            {(committed) =>
              !committed ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {selectedReason === null
                    ? "Pilih salah satu alasan untuk melanjutkan."
                    : "Tulis alasan singkat untuk melanjutkan."}
                </p>
              ) : null
            }
          </form.Subscribe>
        </div>
      )}
    </div>
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
                    // PER-267: a balance-override reason was picked against
                    // the PREVIOUS date's anchor situation (no-use-effect
                    // Rule 3 — clear directly in the event, not via effect).
                    form.setFieldValue("balanceOverride", undefined)
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
                // PER-267: see the date field's onSelect above.
                form.setFieldValue("balanceOverride", undefined)
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
  onCreateMerchant,
}: TransactionFormSectionProps & {
  onCreateMerchant: (name: string) => Promise<EntityComboboxItem>
}) {
  if (activeTab === "transfer") return null

  const items: Array<EntityComboboxItem> =
    formData?.merchants.map((m) => ({ id: m.id, label: m.name })) ?? []

  return (
    <form.Field name="merchantId">
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={field.name}>Merchant (Optional)</Label>
          <EntityCombobox
            id={field.name}
            items={items}
            value={field.state.value ?? ""}
            onChange={field.handleChange}
            onCreate={onCreateMerchant}
            disabled={isLoading}
            placeholder={
              isLoading ? "Loading..." : "-- No Merchant / General --"
            }
            searchPlaceholder="Search merchants..."
            emptyLabel="No merchants yet"
            createLabel={(query) => `Create merchant "${query}"`}
            clearLabel="-- No Merchant / General --"
          />
        </div>
      )}
    </form.Field>
  )
}

function SplitModeToggle({
  activeTab,
  isSplit,
  setIsReimbursement,
  setIsSplit,
}: {
  activeTab: TransactionType
  isSplit: boolean
  // PER-260: turning Split ON while a reimbursement was active would leave
  // "reimbursement" pointed at no category (split nulls the parent
  // categoryId) — see the matching comment on ReimbursementToggle.
  setIsReimbursement: React.Dispatch<React.SetStateAction<boolean>>
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
        onCheckedChange={(checked) => {
          setIsSplit(checked)
          if (checked) setIsReimbursement(false)
        }}
      />
    </div>
  )
}

// PER-260 / ADR-0055: income-tab-only toggle. OFF (default) leaves the
// category picker + submitted kind completely unchanged. ON swaps the
// category picker's source to the family's EXPENSE categories (see
// CategoryField below) so the income row nets against that category's
// spending in both the Spending report and Budget progress.
function ReimbursementToggle({
  activeTab,
  formData,
  isLoading,
  isReimbursement,
  isSplit,
  setIsReimbursement,
}: {
  activeTab: TransactionType
  formData: TransactionFormLookupData | undefined
  isLoading: boolean
  isReimbursement: boolean
  isSplit: boolean
  // Plain callback (not a raw Dispatch) — the caller wraps the state setter
  // to also clear the now-mismatched categoryId on every flip. See the
  // call site in the main component body.
  setIsReimbursement: (value: boolean) => void
}) {
  // PER-260: reimbursement nets a single categorized income row against one
  // expense category. Split mode already hides the (parent) category picker
  // entirely — mixing the two would leave "reimbursement" pointed at no
  // category at all, so keep them mutually exclusive rather than defining a
  // second, untested interaction.
  if (activeTab !== "income" || isSplit) return null

  const hasExpenseCategories =
    isLoading || (formData?.categories ?? []).some((c) => c.type === "expense")

  const toggle = (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border border-dashed px-3 py-2",
        !hasExpenseCategories && "opacity-50"
      )}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconArrowBackUp className="size-4" />
        <Label
          htmlFor="reimbursement-toggle"
          className={cn(
            "text-sm font-medium",
            hasExpenseCategories && "cursor-pointer"
          )}
        >
          This is a refund/reimbursement
        </Label>
        {isReimbursement && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">
            ACTIVE
          </span>
        )}
      </div>
      <Switch
        id="reimbursement-toggle"
        checked={isReimbursement}
        disabled={!hasExpenseCategories}
        onCheckedChange={setIsReimbursement}
      />
    </div>
  )

  if (hasExpenseCategories) return toggle

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{toggle}</div>
      </TooltipTrigger>
      <TooltipContent>
        Create an expense category first to mark income as a reimbursement.
      </TooltipContent>
    </Tooltip>
  )
}

function CategoryField({
  activeTab,
  form,
  formData,
  isLoading,
  isReimbursement,
  isSplit,
  onCreateCategory,
}: TransactionFormSectionProps & {
  isReimbursement: boolean
  isSplit: boolean
  onCreateCategory: (name: string) => Promise<EntityComboboxItem>
}) {
  if (activeTab === "transfer" || isSplit) return null

  // PER-260: reimbursement swaps the picker's source to EXPENSE categories
  // (the income row nets against one of those). Every other tab/state keeps
  // today's behavior byte-for-byte. A `↩` prefix keeps it unambiguous in the
  // list that these are expense categories being used to offset, not real
  // income categories.
  const useReimbursementSource = activeTab === "income" && isReimbursement
  const items: Array<EntityComboboxItem> = (formData?.categories ?? [])
    .filter((c) =>
      useReimbursementSource ? c.type === "expense" : c.type === activeTab
    )
    .map((c) => ({
      id: c.id,
      label: useReimbursementSource ? `↩ ${c.name}` : c.name,
    }))

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
          <EntityCombobox
            id={field.name}
            items={items}
            value={field.state.value ?? ""}
            onChange={field.handleChange}
            onCreate={onCreateCategory}
            disabled={isLoading}
            placeholder={isLoading ? "Loading..." : "Select Category"}
            searchPlaceholder="Search categories..."
            emptyLabel="No categories yet"
            createLabel={(query) => `Create category "${query}"`}
            aria-invalid={field.state.meta.errors.length > 0}
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

// PER-209 polish: the allocation status line. Extracted to a component with
// early returns (instead of a nested ternary) so the three states — balanced /
// under-allocated / over-allocated — stay readable and each keeps its own
// styling + copy.
function SplitAllocationStatus({
  isBalanced,
  remaining,
  currency,
}: {
  isBalanced: boolean
  remaining: number
  currency: string
}) {
  if (isBalanced) {
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
            {getCurrencySymbol(currency)} {remaining.toLocaleString("en-US")}
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
          {getCurrencySymbol(currency)}{" "}
          {Math.abs(remaining).toLocaleString("en-US")}
        </strong>
      </span>
    </p>
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

  // Panel-level mutation helpers keep the JSX event handlers shallow one-liners
  // (avoids nesting setSplitEntries → map/filter callbacks inside the render
  // prop, which otherwise breaches the 5-level function-nesting limit).
  const updateSplitEntry = (id: string, patch: Partial<SplitEntryValue>) =>
    setSplitEntries((prev) =>
      prev.map((en) => (en.id === id ? { ...en, ...patch } : en))
    )
  const removeSplitEntry = (id: string) =>
    setSplitEntries((prev) => prev.filter((en) => en.id !== id))
  const addSplitEntry = () =>
    setSplitEntries((prev) => [...prev, createBlankSplitEntry()])

  return (
    <form.Subscribe selector={(state) => state.values.amount}>
      {(parentAmount) => {
        // When the allocation is fully balanced, promote the whole panel frame
        // to emerald (matching the status line), else keep the amber "still
        // allocating" frame. Light + dark variants.
        const splitTotal = splitEntries.reduce((s, e) => s + e.amount, 0)
        const remaining = parentAmount - splitTotal
        const isBalanced = remaining === 0 && parentAmount > 0

        return (
          <div
            className={cn(
              "space-y-3 rounded-lg border p-3",
              isBalanced
                ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20"
                : "border-amber-200 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20"
            )}
          >
            <p
              className={cn(
                "text-xs font-semibold tracking-wider uppercase",
                isBalanced
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-amber-700 dark:text-amber-400"
              )}
            >
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
                      updateSplitEntry(entry.id, { categoryId: e.target.value })
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
                      updateSplitEntry(entry.id, {
                        description: e.target.value,
                      })
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
                      updateSplitEntry(entry.id, {
                        amount: Number(e.target.value),
                      })
                    }
                  />

                  <button
                    type="button"
                    disabled={splitEntries.length <= 2}
                    onClick={() => removeSplitEntry(entry.id)}
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
              onClick={addSplitEntry}
            >
              <IconPlus className="mr-1 size-3" /> Add Row
            </Button>

            <SplitAllocationStatus
              isBalanced={isBalanced}
              remaining={remaining}
              currency={selectedAccountCurrency}
            />
          </div>
        )
      }}
    </form.Subscribe>
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
  defaultAccountId,
}: Pick<
  TransactionFormModalProps,
  "editData" | "onClose" | "defaultAccountId"
>) {
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

  // PER-205: the "New Transaction" modal is a persistently-mounted singleton
  // (transactions.tsx renders <TransactionFormModal /> with no key and no
  // editData), so isSplit + splitEntries survive across open/submit cycles.
  // TanStack Form resets itself on submit, but this split state lives OUTSIDE
  // the form and must be cleared explicitly on the two user actions that begin
  // a fresh entry: a successful non-edit submit, and reopening the modal for a
  // new transaction. Edit mode never calls this — its allocation is seeded
  // from editData in the useState initializers above and must be preserved.
  const resetSplitState = React.useCallback(() => {
    setIsSplit(false)
    setSplitEntries([createBlankSplitEntry(), createBlankSplitEntry()])
  }, [])

  // === REIMBURSEMENT/REFUND TOGGLE (PER-260 / ADR-0055) ===
  // Income-tab-only. OFF (default) is byte-for-byte today's behavior: the
  // category picker stays income-type and submitted kind is "standard". ON
  // swaps the category picker's source to expense-type categories and the
  // submitted kind becomes "reimbursement" (validated server-side). Lives
  // OUTSIDE the form, same reasoning as isSplit above.
  const [isReimbursement, setIsReimbursement] = React.useState(
    editData?.kind === "reimbursement"
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

  const [tradeRedirect, setTradeRedirect] =
    React.useState<HoldingsTradeRedirect | null>(null)

  const { data: formData, isLoading } = useQuery<{
    accounts: Array<FormAccount>
    categories: Array<FormCategory>
    merchants: Array<FormMerchant>
  }>({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  // Quick-create (PER-189): the combobox calls these, then the lookup query
  // is invalidated so the newly created merchant/category is immediately
  // selectable — the canonical createMerchantFn/createCategoryFn server fns
  // own tenant scoping, audit, idempotency, and duplicate-name rejection.
  const queryClient = useQueryClient()

  const createMerchantOption = React.useCallback(
    async (name: string): Promise<EntityComboboxItem> => {
      const created = await createMerchantFn({
        data: { name, idempotencyKey: createUuidV7() },
      })
      await queryClient.invalidateQueries({
        queryKey: ["transactionFormData"],
      })
      return { id: created.id, label: created.name }
    },
    [queryClient]
  )

  const createCategoryOption = React.useCallback(
    async (name: string): Promise<EntityComboboxItem> => {
      const created = await createCategoryFn({
        data: {
          name,
          // PER-260: when the reimbursement toggle is on, the picker's
          // source is EXPENSE categories — a quick-created category here
          // must match, or it would vanish from the very list it was
          // created from.
          type:
            activeTab === "income" && !isReimbursement ? "income" : "expense",
          idempotencyKey: createUuidV7(),
        },
      })
      await queryClient.invalidateQueries({
        queryKey: ["transactionFormData"],
      })
      return { id: created.id, label: created.name }
    },
    [activeTab, isReimbursement, queryClient]
  )

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
        // PER-247: prefill the fee + purpose from the edited transfer's
        // canonical Transfer row (exposed on the ledger record as
        // transferPurpose / transferFee).
        feeAmount: editData.transferFee
          ? editAmountToInputNumber(
              decodeMoney(editData.transferFee.amount),
              editData.transferFee.currency
            )
          : undefined,
        feeCategoryId: editData.transferFee?.categoryId ?? "",
        feeBearerAccountId: editData.transferFee?.accountId ?? undefined,
        transferPurpose:
          (editData.transferPurpose as TransferPurpose | null | undefined) ??
          undefined,
        attachmentUrl: "",
      }
    : {
        type: "expense" as const,
        amount: 0,
        description: "",
        accountId: defaultAccountId ?? "",
        categoryId: "",
        toAccountId: "",
        merchantId: "",
        // Auto-capture waktu saat ini agar presisi urutan ledger terjamin
        date: new Date(),
        notes: "",
        status: "CLEARED" as const,
        destinationAmount: undefined,
        feeAmount: undefined,
        feeCategoryId: "",
        feeBearerAccountId: undefined,
        transferPurpose: undefined,
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
        // Transfer fee (PER-247): ANY transfer can carry a fee (top-up /
        // e-wallet / bank charge, or FX spread cross-currency). Denominated
        // in the fee bearer's currency (default: the source account); the
        // server posts it as a separate expense leg linked to the Transfer
        // (fx_fee when cross-currency, transfer_fee otherwise).
        const feeBearerAccount =
          value.type === "transfer"
            ? (formData?.accounts.find(
                (a) => a.id === (value.feeBearerAccountId || value.accountId)
              ) ?? null)
            : null
        const feeMoney: Money | null =
          value.type === "transfer" &&
          value.feeAmount != null &&
          value.feeAmount > 0
            ? toMoney(
                value.feeAmount,
                feeBearerAccount?.currency ?? sourceCurrency
              )
            : null
        // PER-196 / ADR-0048 §1: only sent when the user manually edited the
        // prefill (NewValuationValueField leaves the field undefined until
        // touched) — an absolute value in whichever side is
        // balanceSource="valuation", never a delta. Harmlessly ignored
        // server-side for a non-valuation-linked transfer.
        const newValuationValueString: string | null =
          value.type === "transfer" && value.newValuationValue != null
            ? (() => {
                const trackedCurrency =
                  formData?.accounts.find((a) => a.id === value.accountId)
                    ?.balanceSource === "valuation"
                    ? sourceCurrency
                    : (destCurrency ?? sourceCurrency)
                return toMoney(
                  value.newValuationValue as number,
                  trackedCurrency
                ).toString()
              })()
            : null
        const selectedAccount = formData?.accounts.find(
          (a) => a.id === value.accountId
        )
        const selectedToAccount =
          value.toAccountId && value.type === "transfer"
            ? formData?.accounts.find((a) => a.id === value.toAccountId)
            : null
        // Purpose override: only funds_movement transfers carry a purpose
        // (liability kinds already mean something via `kind`; the server
        // rejects an override there). Recomputed here — the user may have
        // changed the destination AFTER picking a purpose.
        // PER-241 revision — kill the "Transfer → Invest" flash. The optimistic
        // row must carry the SAME purpose the server would derive, so it reads
        // "Invest" / "Top-up" / "Withdraw" immediately instead of a generic
        // "Transfer" for the ~1s until the post-mutation refetch lands. When the
        // user leaves the purpose on "Automatic", fall back to the taxonomy
        // derivation (identical to the server's `resolveTransferPurpose`, so the
        // forwarded value stays idempotent — the server resolves the same thing
        // whether we send the derived override or null).
        const transferPurposePayload: TransferPurpose | null =
          value.type === "transfer" && selectedAccount && selectedToAccount
            ? deriveTransferKindForAccounts({
                fromAccountType: parseAccountType(selectedAccount.accountType),
                toAccountType: parseAccountType(selectedToAccount.accountType),
              }) === "funds_movement"
              ? (value.transferPurpose ??
                deriveTransferPurpose({
                  fromAccountType: parseAccountType(
                    selectedAccount.accountType
                  ),
                  toAccountType: parseAccountType(
                    selectedToAccount.accountType
                  ),
                  toAccountSubtype: selectedToAccount.accountSubtype,
                }))
              : null
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
          kind:
            value.type === "transfer"
              ? "funds_movement"
              : // PER-260: the toggle is only rendered/actionable on the
                // Income tab and resets whenever Split turns on or the tab
                // changes away from Income (see the state resets above), so
                // this check alone is sufficient — no separate `isSplit`
                // guard needed here.
                value.type === "income" && isReimbursement
                ? "reimbursement"
                : "standard",
          amount: amountMoney,
          description: value.description,
          accountId: value.accountId,
          categoryId: isSplit ? null : value.categoryId || null,
          toAccountId: value.toAccountId || null,
          // PER-210: a split parent keeps its single merchant (merchant = whole
          // receipt); only categoryId is nulled on split. Keep merchantId so it
          // actually reaches the server and persists on the parent row.
          merchantId: value.merchantId || null,
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
            // PER-200: destinationAmount + destinationCurrency are the
            // cross-currency FX destination pair. The DB CHECK
            // `destination_pair_consistency` requires them BOTH null or BOTH
            // set — so the currency may only be present when the amount is.
            // A same-currency transfer has destAmountMoney === null, so both
            // stay null; previously the currency was set unconditionally,
            // producing an inconsistent (null amount, non-null currency) pair
            // that the constraint rejected — the transfer silently vanished
            // (optimistic insert rolled back).
            if (
              destAmountMoney != null &&
              value.type === "transfer" &&
              value.toAccountId
            ) {
              return (
                formData?.accounts.find((a) => a.id === value.toAccountId)
                  ?.currency ?? null
              )
            }
            return null
          })(),
          // Transfer fee + purpose inputs are write-only ledger inputs (not
          // collection columns). They ride along on the optimistic insert so
          // `onInsert` can forward them to the server; the post-mutation
          // refetch then surfaces the server-posted fee expense as its own
          // ledger row and the resolved purpose on the movement.
          feeAmount: feeMoney,
          feeAccountId: feeMoney ? (feeBearerAccount?.id ?? null) : null,
          feeCategoryId: feeMoney ? value.feeCategoryId || null : null,
          transferPurpose: transferPurposePayload,
          newValuationValue: newValuationValueString,
          // PER-267: the "ubah saldo juga" override — expense/income only
          // (BackdatedAnchorBanner never sets this for a transfer, and the
          // tab-switch handler above clears it defensively). The server
          // (`applyBalanceOverride`) re-verifies the gating condition itself.
          balanceOverride:
            value.type !== "transfer" ? (value.balanceOverride ?? null) : null,
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
          // PER-210: split parent retains its merchant, so hydrate the
          // optimistic merchant relation for splits too (only category is
          // dropped on split).
          merchant: value.merchantId
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
            // PER-247: ephemeral fee + purpose inputs must ride on the draft
            // so collections.onUpdate can forward them to updateTransactionFn
            // (they are write-only, not collection columns).
            ;(draft as Record<string, unknown>)["transferPurpose"] =
              payload.transferPurpose
            ;(draft as Record<string, unknown>)["feeAmount"] = payload.feeAmount
            ;(draft as Record<string, unknown>)["feeAccountId"] =
              payload.feeAccountId
            ;(draft as Record<string, unknown>)["feeCategoryId"] =
              payload.feeCategoryId
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
            // PER-199: provider-identity binding is import-only; UI-created
            // transactions never carry one.
            externalProvider: null,
            externalId: null,
            // PER-247: the fee leg is posted server-side as its own row; the
            // post-mutation refetch surfaces it + the resolved purpose.
            transferFee: null,
            // PER-247: `transferIncoming` orients the account arrow for a
            // valuation-linked redemption's cash leg (server-only). A
            // form-authored transfer is always the outflow-authored leg, so the
            // optimistic row is `false`; the post-mutation refetch replaces it
            // with the authoritative server value.
            transferIncoming: false,
            // splitEntries di optimistic payload adalah versi ringkas (tanpa relasi Prisma)
            splitEntries:
              payload.splitEntries as TransactionRecord["splitEntries"],
          })
        }

        setIsOpen(false)
        if (onClose) onClose()

        if (!isEditMode) {
          form.reset()
          // PER-261: `form.reset()` restores EVERY field to
          // `defaultFormValues`, which hardcodes `type: "expense"` — but the
          // visually-controlled `activeTab` (the Tabs UI) is untouched, so a
          // successful Transfer submit leaves the tab still showing
          // "Transfer" while the form's own `type` field silently reverted
          // to "expense". `TransactionTypeTabs`'s `onValueChange` is the ONLY
          // other place that syncs `type` to the tab, and it only fires on an
          // ACTIVE user click — reopening with the tab already visually on
          // "Transfer" and typing straight into the fields never re-fires it,
          // so a same-tab resubmit silently posted the stale reset type
          // instead of what the UI displayed. Resync here so the form always
          // agrees with the tab the user is looking at. `categoryId` and
          // `toAccountId` don't need the same treatment: create-mode
          // defaults already reset BOTH to "" regardless of tab, which is
          // exactly what a fresh Transfer or Expense/Income tab wants (no
          // stale category riding into a transfer; no stale destination
          // account riding into an expense/income) — the same values
          // `onValueChange` clears to when actively switching tabs.
          form.setFieldValue("type", activeTab)
          // Split state lives outside TanStack Form; clear it too so the next
          // "New Transaction" open starts with a clean, inactive allocation
          // (PER-205 — no stale rows, no phantom "Over allocated" banner).
          resetSplitState()
          // PER-260: same reasoning — the reimbursement toggle lives outside
          // the form too.
          setIsReimbursement(false)
        }
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
      setIsReimbursement(editData.kind === "reimbursement")
      form.reset()
    } else if (open && !editData) {
      // PER-205: reopening the singleton "New Transaction" modal must present a
      // clean split allocation even if a prior split entry was never submitted
      // (e.g. the user toggled Split on, then closed the dialog).
      resetSplitState()
      setIsReimbursement(false)
    }
  }

  const handleCancel = () => {
    setIsOpen(false)
    if (onClose) onClose()
  }

  // PER-259 / ADR-0054 — the Transfer tab hands a holdings-account leg over to
  // the real Buy/Sell dialog. Starting the trade closes this form (one dialog
  // at a time); finishing it resyncs the ledger the same way a transfer would.
  const startTradeRedirect = React.useCallback(
    (redirect: HoldingsTradeRedirect) => {
      setTradeRedirect(redirect)
      setIsOpen(false)
    },
    []
  )

  const finishTradeRedirect = React.useCallback(async () => {
    setTradeRedirect(null)
    // A trade moves cash AND re-materializes the investment account's value, so
    // the account collection has to resync too — the same pairing every other
    // ledger mutation does. `transactionFormData` is invalidated because the
    // very first buy on an account flips its `hasHoldings` flag.
    await Promise.all([
      transactionCollection.utils.refetch(),
      accountCollection.utils.refetch(),
      queryClient.invalidateQueries({ queryKey: ["transactionFormData"] }),
      queryClient.invalidateQueries({ queryKey: ["account_holdings"] }),
    ])
    if (onClose) onClose()
  }, [onClose, queryClient])

  return {
    activeTab,
    createCategoryOption,
    createMerchantOption,
    finishTradeRedirect,
    form,
    formData,
    formError,
    handleCancel,
    handleDelete,
    handleOpenChange,
    isEditMode,
    isLoading,
    isOpen,
    isReimbursement,
    isSplit,
    setActiveTab,
    setIsReimbursement,
    setIsSplit,
    setSplitEntries,
    setTradeRedirect,
    splitEntries,
    startTradeRedirect,
    tradeRedirect,
  }
}

export function TransactionFormModal({
  editData,
  customTrigger,
  onClose,
  defaultAccountId,
}: TransactionFormModalProps) {
  const {
    activeTab,
    createCategoryOption,
    createMerchantOption,
    finishTradeRedirect,
    form,
    formData,
    formError,
    handleCancel,
    handleDelete,
    handleOpenChange,
    isEditMode,
    isLoading,
    isOpen,
    isReimbursement,
    isSplit,
    setActiveTab,
    setIsReimbursement,
    setIsSplit,
    setSplitEntries,
    setTradeRedirect,
    splitEntries,
    startTradeRedirect,
    tradeRedirect,
  } = useTransactionFormModalController({ editData, onClose, defaultAccountId })

  return (
    <>
      {/* The trade flow replaces this form while it is open — one dialog at a
          time — but the page's trigger below must stay mounted either way. */}
      {tradeRedirect !== null ? (
        <HoldingsTradeRedirectDialog
          redirect={tradeRedirect}
          accounts={formData?.accounts ?? []}
          onClose={() => setTradeRedirect(null)}
          onSaved={finishTradeRedirect}
        />
      ) : null}
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
            isReimbursement={isReimbursement}
            setActiveTab={setActiveTab}
            setIsReimbursement={setIsReimbursement}
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
            <HoldingsTransferNotice
              activeTab={activeTab}
              form={form}
              formData={formData}
              onStartTrade={startTradeRedirect}
            />
            <DestinationAmountField
              activeTab={activeTab}
              form={form}
              formData={formData}
            />
            <NewValuationValueField
              activeTab={activeTab}
              form={form}
              formData={formData}
            />
            <TransferContextFields
              activeTab={activeTab}
              form={form}
              formData={formData}
            />
            <DateTimeFields form={form} />
            <BackdatedAnchorBanner activeTab={activeTab} form={form} />
            <MerchantField
              activeTab={activeTab}
              form={form}
              formData={formData}
              isLoading={isLoading}
              onCreateMerchant={createMerchantOption}
            />
            <SplitModeToggle
              activeTab={activeTab}
              isSplit={isSplit}
              setIsReimbursement={setIsReimbursement}
              setIsSplit={setIsSplit}
            />
            <ReimbursementToggle
              activeTab={activeTab}
              formData={formData}
              isLoading={isLoading}
              isReimbursement={isReimbursement}
              isSplit={isSplit}
              setIsReimbursement={(checked) => {
                setIsReimbursement(checked)
                // The picker's source (income <-> expense categories) flips
                // with this toggle in either direction; a stale selection
                // from the other list would silently ride along otherwise.
                form.setFieldValue("categoryId", "")
              }}
            />
            <CategoryField
              activeTab={activeTab}
              form={form}
              formData={formData}
              isLoading={isLoading}
              isReimbursement={isReimbursement}
              isSplit={isSplit}
              onCreateCategory={createCategoryOption}
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
    </>
  )
}
