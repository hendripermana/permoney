import * as React from "react"
import {
  IconArrowRight,
  IconArrowsExchange,
  IconChevronRight,
  IconEdit,
  IconPaperclip,
  IconScissors,
  IconTrash,
} from "@tabler/icons-react"
import { format } from "date-fns"

import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { formatCurrency } from "@/lib/currency"
import { decodeMoney, type Money } from "@/lib/money"
import { moneyMovementLabel } from "@/lib/money-movement"
import { signedDeltaForAccount } from "@/lib/account-analytics"
import type { TransactionRecord } from "@/lib/collections"
import type { TransactionFormModal } from "@/components/transaction-form-modal"
import type { TransactionRowDensity } from "@/lib/transaction-list"

// ═══════════════════════════════════════════════════════════════
// SHARED TRANSACTION ROW (PER-241 + revision)
//
// ONE unified ledger row, rendered identically on BOTH pages. `/transactions`
// shows every column; the per-account statement renders the exact same row with
// the (now redundant) account column hidden and a running-balance line under
// the amount — the account page IS the ledger filtered to one account, the way
// Sure / Revolut do it. Everything shared: the contextual PER-247 money-movement
// label, split expansion, inline edit/delete, badges, and the signed + coloured
// amount.
//
// Kept a deep module: the public surface is a handful of grouped props
// (`hideAccountColumn`, `viewedAccountIds`, `runningBalance`, `selection`,
// `onEdit`, `onDelete`) while the per-column layout complexity lives inside.
// ═══════════════════════════════════════════════════════════════

/** The edit payload the singleton `TransactionFormModal` consumes on edit. */
export type TransactionEditData = NonNullable<
  React.ComponentProps<typeof TransactionFormModal>["editData"]
>

/**
 * Map a ledger record to the modal's edit payload. Shared by both pages so the
 * "edit" affordance behaves identically wherever a row is rendered.
 */
export function transactionToEditData(
  trx: TransactionRecord
): TransactionEditData {
  return {
    id: trx.id,
    type: trx.type as "expense" | "income" | "transfer",
    // Money (bigint minor units) → the form converts back at submission.
    amount: trx.amount,
    description: trx.description,
    accountId: trx.accountId,
    categoryId: trx.categoryId ?? undefined,
    toAccountId: trx.toAccountId ?? undefined,
    merchantId: trx.merchantId ?? undefined,
    date: new Date(trx.date),
    notes: trx.notes ?? undefined,
    status: (trx.status as "PENDING" | "CLEARED" | "RECONCILED") ?? "CLEARED",
    // PER-260: carry `kind` so editing an existing reimbursement pre-checks
    // the refund toggle instead of silently reverting it to "standard".
    kind: trx.kind,
    // PER-209: carry the split allocation so an edited split keeps its rows.
    isSplit: trx.isSplit,
    splitEntries:
      trx.splitEntries?.map((e) => ({
        id: e.id,
        description: e.description,
        amount: e.amount,
        categoryId: e.categoryId ?? undefined,
        merchantId: e.merchantId ?? undefined,
      })) ?? [],
  }
}

const STATUS_BADGE: Record<string, { label: string; cls: string } | undefined> =
  {
    PENDING: {
      label: "Pending",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
    },
    RECONCILED: {
      label: "Reconciled",
      cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400",
    },
  }

/** Running (register) balance after this row, in the account's currency. */
export interface RunningBalance {
  amount: Money
  currency: string
}

export interface TransactionListRowProps {
  trx: TransactionRecord
  density?: TransactionRowDensity
  /**
   * Accounts being viewed, for transfer direction + perspective. `/transactions`
   * passes the URL `accounts` filter (may be empty → neutral, whole-book
   * rendering); the per-account statement passes exactly the one account whose
   * page is rendered.
   */
  viewedAccountIds?: ReadonlyArray<string>
  /**
   * Hide the account column — the per-account statement is already scoped to one
   * account, so the chips are redundant. Also switches the amount + transfer
   * label to that account's PERSPECTIVE (money in = +, money out = −).
   */
  hideAccountColumn?: boolean
  /**
   * Running-balance-after-this-row (the account register column). Only supplied
   * for cash-like accounts on the statement; rendered muted under the amount.
   */
  runningBalance?: RunningBalance | null
  /** Bulk-select checkbox (ledger only). Omit to hide the checkbox column. */
  selection?: {
    isSelected: boolean
    onSelect: (value: boolean) => void
  }
  /** Inline edit action. Omit to hide the edit button. */
  onEdit?: (editData: TransactionEditData) => void
  /** Inline delete action. Omit to hide the delete button. */
  onDelete?: (id: string) => void
}

export function TransactionListRow({
  trx,
  density = "comfortable",
  viewedAccountIds,
  hideAccountColumn = false,
  runningBalance,
  selection,
  onEdit,
  onDelete,
}: TransactionListRowProps) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  const hasSplits = trx.isSplit && (trx.splitEntries?.length ?? 0) > 0
  const statusBadge = STATUS_BADGE[trx.status]
  const compact = density === "compact"

  // The single account this row is viewed from (statement, or a single-account
  // ledger filter). Drives transfer direction + counterparty naming.
  const singleAccountId =
    viewedAccountIds && viewedAccountIds.length === 1
      ? viewedAccountIds[0]
      : null

  // PER-241 revision — on the per-account statement, the amount is signed from
  // that account's PERSPECTIVE (a transfer OUT reads −/red, a transfer IN reads
  // +/green), exactly like a bank register. The whole-book ledger keeps its
  // type-based colouring untouched (this only engages when the account column
  // is hidden, i.e. the statement).
  const accountPerspective = hideAccountColumn && singleAccountId != null
  const perspectiveDir = accountPerspective
    ? signedDeltaForAccount(trx, singleAccountId) >= 0n
      ? 1
      : -1
    : 0

  // PER-202: from a viewed DESTINATION account, a transfer leg surfaced via
  // `toAccountId` is INCOMING — flip its sign/colour to read as a credit. The
  // whole-book (unfiltered) ledger passes no viewed accounts, so it stays
  // neutral. (Used only on the non-perspective, whole-book path.)
  //
  // `signedDeltaForAccount(trx, viewedId) >= 0n` is the general, correct test
  // (it accounts for `isAccountCredit`, not just `toAccountId`, see its doc
  // comment — a valuation-linked Sell's cash leg is owned by the account that
  // GAINS money, which `toAccountId` alone can't tell you). Multi-account
  // filters are rare in practice, so checking each viewed id individually
  // here is fine.
  const isIncomingTransfer =
    trx.type === "transfer" &&
    viewedAccountIds != null &&
    viewedAccountIds.length > 0 &&
    !viewedAccountIds.includes(trx.accountId) &&
    viewedAccountIds.some(
      (id) => trx.toAccountId === id && signedDeltaForAccount(trx, id) >= 0n
    )

  const rowActions =
    onEdit || onDelete ? (
      <RowActions
        onEdit={onEdit ? () => onEdit(transactionToEditData(trx)) : undefined}
        onDelete={onDelete ? () => onDelete(trx.id) : undefined}
      />
    ) : null

  return (
    <div
      className={cn(
        "group border-b border-zinc-100 transition-colors dark:border-zinc-800/50",
        selection?.isSelected && "bg-zinc-50/80 dark:bg-zinc-900/40",
        trx.status === "PENDING" && "opacity-80"
      )}
    >
      <div
        className={cn("flex w-full items-start", compact ? "py-1.5" : "py-3")}
      >
        {/* Checkbox column (bulk select — ledger only) */}
        <div className="flex w-12 shrink-0 justify-center pt-0.5">
          {selection ? (
            <Checkbox
              checked={selection.isSelected}
              onCheckedChange={(val) => selection.onSelect(!!val)}
              aria-label="Select row"
            />
          ) : null}
        </div>

        {/* Description + time + badges */}
        <div
          className={cn(
            "min-w-0 flex-1 px-4",
            trx.status === "PENDING" && "italic"
          )}
        >
          <PrimaryBlock
            trx={trx}
            hasSplits={hasSplits}
            isExpanded={isExpanded}
            onToggleExpand={() => setIsExpanded((prev) => !prev)}
            statusBadge={statusBadge}
            compact={compact}
          />
        </div>

        {/* Merchant column (hidden on mobile) */}
        <div className="hidden w-44 shrink-0 px-4 pt-0.5 md:block">
          {trx.merchant ? (
            <span className="text-sm font-medium">{trx.merchant.name}</span>
          ) : (
            <span className="text-sm text-muted-foreground italic">-</span>
          )}
        </div>

        {/* Category / movement column (hidden on tablet) */}
        <div className="hidden w-44 shrink-0 px-4 pt-0.5 lg:block">
          {trx.type === "transfer" ? (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-sm font-medium",
                perspectiveDir === 1 || isIncomingTransfer
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-blue-600 dark:text-blue-400"
              )}
              // Long movement labels ("Withdraw from Hasil Jualan") ellipsis in
              // the fixed column; the title reveals the full text on hover.
              title={transferColumnLabel(
                trx,
                singleAccountId,
                isIncomingTransfer
              )}
            >
              <IconArrowsExchange size={15} className="shrink-0" />
              <span className="truncate">
                {transferColumnLabel(trx, singleAccountId, isIncomingTransfer)}
              </span>
            </span>
          ) : trx.isSplit ? (
            <span className="flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400">
              <IconScissors size={13} className="shrink-0" />
              Multiple
            </span>
          ) : (
            <span
              className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
              title={trx.category?.name ?? "Uncategorized"}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: trx.category?.color ?? "#999" }}
              />
              <span className="truncate">
                {trx.category?.name ?? "Uncategorized"}
              </span>
            </span>
          )}
        </div>

        {/* Account column (hidden until xl; omitted entirely on the statement) */}
        {hideAccountColumn ? null : (
          <div className="hidden w-52 shrink-0 px-4 pt-0.5 xl:block">
            <div className="flex flex-wrap items-center gap-1">
              {/* PER-247: orient chips by money flow — a valuation-linked
                  redemption RECEIVES into `account`, so the true source is
                  `toAccount`. */}
              <span className="rounded-md border bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                {trx.type === "transfer" &&
                trx.transferIncoming &&
                trx.toAccount
                  ? trx.toAccount.name
                  : trx.account.name}
              </span>
              {trx.type === "transfer" && trx.toAccount && (
                <>
                  <IconArrowRight size={12} className="text-muted-foreground" />
                  <span className="rounded-md border bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                    {trx.transferIncoming
                      ? trx.account.name
                      : trx.toAccount.name}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Amount column (+ running balance under it on the statement) */}
        <div
          className={cn(
            "w-36 shrink-0 px-4 pt-0.5 text-right font-bold",
            accountPerspective
              ? perspectiveDir === 1
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
              : trx.type === "expense"
                ? "text-red-600 dark:text-red-400"
                : trx.type === "income" || isIncomingTransfer
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-blue-600 dark:text-blue-400"
          )}
        >
          <span className="tabular-nums">
            {accountPerspective
              ? perspectiveDir === 1
                ? "+"
                : "−"
              : trx.type === "expense"
                ? "−"
                : trx.type === "income" || isIncomingTransfer
                  ? "+"
                  : ""}
            {formatCurrency(trx.amount, trx.currency)}
          </span>
          <AmountExtras trx={trx} />
          {runningBalance ? (
            <div className="mt-0.5 text-[11px] font-normal text-muted-foreground tabular-nums">
              {formatCurrency(runningBalance.amount, runningBalance.currency)}
            </div>
          ) : null}
        </div>

        {/* Actions column */}
        <div className="flex w-20 shrink-0 items-start justify-center gap-1 pt-0.5">
          {rowActions}
        </div>
      </div>

      {hasSplits && isExpanded ? (
        <SplitChildren trx={trx} hideAccountColumn={hideAccountColumn} />
      ) : null}
    </div>
  )
}

// ── The directional, contextual transfer label for the category column ──
// Whole-book ledger: the plain movement noun ("Invest", "Top-up", "Transfer"),
// plus "from <source>" for a surfaced incoming (redemption) leg. Per-account
// statement: the full directional phrase from THAT account's side — "Invest to
// Bibit", "Withdraw from Hasil Jualan", "Transfer from GoPay".
function transferColumnLabel(
  trx: TransactionRecord,
  singleAccountId: string | null,
  isIncomingTransfer: boolean
): string {
  const noun = moneyMovementLabel({
    kind: trx.kind,
    purpose: trx.transferPurpose,
  })
  if (singleAccountId != null) {
    const incoming = signedDeltaForAccount(trx, singleAccountId) >= 0n
    const counterparty =
      (trx.accountId === singleAccountId
        ? trx.toAccount?.name
        : trx.account?.name) ?? "account"
    return incoming
      ? `${noun} from ${counterparty}`
      : `${noun} to ${counterparty}`
  }
  if (isIncomingTransfer) return `${noun} from ${trx.account.name}`
  return noun
}

// ── Primary block: chevron + description + badges + time ──
function PrimaryBlock({
  trx,
  hasSplits,
  isExpanded,
  onToggleExpand,
  statusBadge,
  compact,
}: {
  trx: TransactionRecord
  hasSplits: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  statusBadge: { label: string; cls: string } | undefined
  compact: boolean
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {hasSplits ? (
          <button
            type="button"
            onClick={onToggleExpand}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={
              isExpanded ? "Collapse split entries" : "Expand split entries"
            }
          >
            <IconChevronRight
              className={cn(
                "size-4 transition-transform duration-150",
                isExpanded && "rotate-90"
              )}
            />
          </button>
        ) : (
          <div className="w-5" aria-hidden />
        )}

        <p className={cn("leading-tight font-semibold", compact && "text-sm")}>
          {trx.description}
        </p>

        {trx.isSplit && (
          <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:bg-amber-950/60 dark:text-amber-400">
            <IconScissors className="size-3" />
            Split
          </span>
        )}

        {statusBadge && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold",
              statusBadge.cls
            )}
          >
            {statusBadge.label}
          </span>
        )}

        {trx.attachmentUrl && (
          <a
            href={trx.attachmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
            title="View Receipt"
            onClick={(e) => e.stopPropagation()}
            aria-label="View attached receipt"
          >
            <IconPaperclip className="size-3.5" />
          </a>
        )}
      </div>

      <p
        className={cn(
          "mt-0.5 pl-6.5 text-xs text-muted-foreground",
          compact && "mt-0"
        )}
      >
        {format(new Date(trx.date), "h:mm a")}
      </p>
    </>
  )
}

// ── Cross-currency destination amount + fee note ──
function AmountExtras({ trx }: { trx: TransactionRecord }) {
  return (
    <>
      {trx.destinationAmount != null &&
        trx.destinationCurrency != null &&
        trx.destinationCurrency !== trx.currency && (
          <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
            → {formatCurrency(trx.destinationAmount, trx.destinationCurrency)}
          </div>
        )}
      {trx.transferFee != null && (
        <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
          +
          {formatCurrency(
            decodeMoney(trx.transferFee.amount),
            trx.transferFee.currency
          )}{" "}
          fee
        </div>
      )}
    </>
  )
}

// ── Inline edit/delete actions (shared) ──
function RowActions({
  onEdit,
  onDelete,
}: {
  onEdit?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex shrink-0 items-start justify-center gap-1 pt-0.5 opacity-70 transition-opacity group-hover:opacity-100">
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          title="Edit Transaction"
        >
          <IconEdit size={15} />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
          title="Delete Transaction"
        >
          <IconTrash size={15} />
        </button>
      ) : null}
    </div>
  )
}

// ── Split entry children (variable height; virtualizer re-measures) ──
function SplitChildren({
  trx,
  hideAccountColumn,
}: {
  trx: TransactionRecord
  hideAccountColumn: boolean
}) {
  const entries = trx.splitEntries ?? []
  return (
    <>
      {entries.map((entry, index) => {
        const isLast = index === entries.length - 1
        return (
          <div
            key={entry.id}
            className={cn(
              "flex w-full items-center border-l-2 border-l-amber-400 bg-muted/5 py-2 pl-13 dark:border-l-amber-600 dark:bg-muted/5",
              !isLast && "border-b border-b-zinc-50 dark:border-b-zinc-900/50"
            )}
          >
            <div className="min-w-0 flex-1 px-4">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  className="shrink-0 text-zinc-300 dark:text-zinc-700"
                  aria-hidden
                >
                  ↳
                </span>
                <span className="truncate">{entry.description}</span>
              </span>
            </div>
            <div className="hidden w-44 shrink-0 px-4 md:block">
              {entry.merchant ? (
                <span className="text-sm text-foreground">
                  {entry.merchant.name}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground italic">-</span>
              )}
            </div>
            <div className="hidden w-44 shrink-0 px-4 lg:block">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.category?.color ?? "#999" }}
                />
                {entry.category?.name ?? "Uncategorized"}
              </span>
            </div>
            {hideAccountColumn ? null : (
              <div className="hidden w-52 shrink-0 px-4 xl:block">
                <span className="text-sm text-muted-foreground italic">-</span>
              </div>
            )}
            <div className="w-36 shrink-0 px-4 text-right font-medium text-muted-foreground">
              {formatCurrency(entry.amount, trx.currency)}
            </div>
            <div className="w-20 shrink-0" />
          </div>
        )
      })}
    </>
  )
}
