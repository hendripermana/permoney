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
import { decodeMoney } from "@/lib/money"
import { moneyMovementLabel } from "@/lib/money-movement"
import { signedDeltaForAccount } from "@/lib/account-analytics"
import type { TransactionRecord } from "@/lib/collections"
import type { TransactionFormModal } from "@/components/transaction-form-modal"
import type { TransactionRowDensity } from "@/lib/transaction-list"

// ═══════════════════════════════════════════════════════════════
// SHARED TRANSACTION ROW (PER-241)
//
// ONE row design, two variants. `/transactions` renders the full "ledger"
// variant (bulk-select checkbox + merchant/category/account columns); the
// per-account statement renders the denser "statement" variant that folds the
// context into a single secondary line ("Invest to Bibit · Rp 1,000 fee").
// Both share the exact same primary block (chevron + description + badges),
// amount styling, split expansion, and the PER-247 contextual movement label.
//
// Kept a deep module: the public surface is `variant` + a handful of grouped
// props, while the per-variant layout complexity lives inside.
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

export interface TransactionListRowProps {
  trx: TransactionRecord
  /** "ledger" = full columns + checkbox; "statement" = dense single-line. */
  variant: "ledger" | "statement"
  density?: TransactionRowDensity
  /**
   * Accounts being viewed, for transfer direction. The ledger passes the URL
   * `accounts` filter (may be empty → neutral transfer rendering); the
   * statement passes exactly the one account whose page is rendered.
   */
  viewedAccountIds?: ReadonlyArray<string>
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
  variant,
  density = "comfortable",
  viewedAccountIds,
  selection,
  onEdit,
  onDelete,
}: TransactionListRowProps) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  const hasSplits = trx.isSplit && (trx.splitEntries?.length ?? 0) > 0
  const statusBadge = STATUS_BADGE[trx.status]
  const compact = density === "compact"

  // PER-202: from a viewed DESTINATION account, a transfer leg surfaced via
  // `toAccountId` is INCOMING — flip its sign/colour to read as a credit. The
  // global (unfiltered) ledger passes no viewed accounts, so it stays neutral.
  const isIncomingTransfer =
    trx.type === "transfer" &&
    viewedAccountIds != null &&
    viewedAccountIds.length > 0 &&
    trx.toAccountId != null &&
    viewedAccountIds.includes(trx.toAccountId) &&
    !viewedAccountIds.includes(trx.accountId)

  const rowActions =
    onEdit || onDelete ? (
      <RowActions
        onEdit={onEdit ? () => onEdit(transactionToEditData(trx)) : undefined}
        onDelete={onDelete ? () => onDelete(trx.id) : undefined}
      />
    ) : null

  const primaryBlock = (
    <PrimaryBlock
      trx={trx}
      hasSplits={hasSplits}
      isExpanded={isExpanded}
      onToggleExpand={() => setIsExpanded((prev) => !prev)}
      statusBadge={statusBadge}
      compact={compact}
      // The statement variant folds the movement/counterparty into the
      // secondary line under the description; the ledger keeps it in columns.
      secondary={
        variant === "statement"
          ? statementSecondary(trx, viewedAccountIds?.[0])
          : null
      }
    />
  )

  if (variant === "statement") {
    const dir =
      viewedAccountIds && viewedAccountIds.length > 0
        ? signedDeltaForAccount(trx, viewedAccountIds[0]) >= 0n
          ? 1
          : -1
        : trx.type === "expense"
          ? -1
          : 1
    return (
      <div
        className={cn(
          "group border-b border-zinc-100 transition-colors last:border-b-0 dark:border-zinc-800/50",
          trx.status === "PENDING" && "opacity-80"
        )}
      >
        <div
          className={cn(
            "flex w-full items-start gap-3 px-4",
            compact ? "py-1.5" : "py-3"
          )}
        >
          <div className="min-w-0 flex-1">{primaryBlock}</div>
          <StatementAmount trx={trx} dir={dir} compact={compact} />
          {rowActions}
        </div>
        {hasSplits && isExpanded ? (
          <SplitChildren trx={trx} variant="statement" />
        ) : null}
      </div>
    )
  }

  // ── Ledger variant ──────────────────────────────────────────────
  return (
    <div
      className={cn(
        "border-b border-zinc-100 transition-colors dark:border-zinc-800/50",
        selection?.isSelected && "bg-zinc-50/80 dark:bg-zinc-900/40",
        trx.status === "PENDING" && "opacity-80"
      )}
    >
      <div
        className={cn("flex w-full items-start", compact ? "py-1.5" : "py-3")}
      >
        {/* Checkbox column */}
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
          {primaryBlock}
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
                "flex items-center gap-1 text-sm font-medium",
                isIncomingTransfer
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-blue-600 dark:text-blue-400"
              )}
            >
              <IconArrowsExchange size={15} />
              {isIncomingTransfer
                ? `${moneyMovementLabel({ kind: trx.kind, purpose: trx.transferPurpose })} from ${trx.account.name}`
                : moneyMovementLabel({
                    kind: trx.kind,
                    purpose: trx.transferPurpose,
                  })}
            </span>
          ) : trx.isSplit ? (
            <span className="flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400">
              <IconScissors size={13} />
              Multiple
            </span>
          ) : (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: trx.category?.color ?? "#999" }}
              />
              {trx.category?.name ?? "Uncategorized"}
            </span>
          )}
        </div>

        {/* Account column (hidden until xl) */}
        <div className="hidden w-52 shrink-0 px-4 pt-0.5 xl:block">
          <div className="flex flex-wrap items-center gap-1">
            {/* PER-247: orient chips by money flow — a valuation-linked
                redemption RECEIVES into `account`, so the true source is
                `toAccount`. */}
            <span className="rounded-md border bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
              {trx.type === "transfer" && trx.transferIncoming && trx.toAccount
                ? trx.toAccount.name
                : trx.account.name}
            </span>
            {trx.type === "transfer" && trx.toAccount && (
              <>
                <IconArrowRight size={12} className="text-muted-foreground" />
                <span className="rounded-md border bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                  {trx.transferIncoming ? trx.account.name : trx.toAccount.name}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Amount column */}
        <div
          className={cn(
            "w-36 shrink-0 px-4 pt-0.5 text-right font-bold",
            trx.type === "expense"
              ? "text-red-600 dark:text-red-400"
              : trx.type === "income" || isIncomingTransfer
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-blue-600 dark:text-blue-400"
          )}
        >
          <span>
            {trx.type === "expense"
              ? "−"
              : trx.type === "income" || isIncomingTransfer
                ? "+"
                : ""}
            {formatCurrency(trx.amount, trx.currency)}
          </span>
          <AmountExtras trx={trx} />
        </div>

        {/* Actions column */}
        <div className="flex w-20 shrink-0 items-start justify-center gap-1 pt-0.5">
          {rowActions}
        </div>
      </div>

      {hasSplits && isExpanded ? (
        <SplitChildren trx={trx} variant="ledger" />
      ) : null}
    </div>
  )
}

// ── Primary block: chevron + description + badges (+ optional secondary) ──
function PrimaryBlock({
  trx,
  hasSplits,
  isExpanded,
  onToggleExpand,
  statusBadge,
  compact,
  secondary,
}: {
  trx: TransactionRecord
  hasSplits: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  statusBadge: { label: string; cls: string } | undefined
  compact: boolean
  secondary: React.ReactNode
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

      {/* Secondary line: the statement variant shows time · movement; the
          ledger variant shows just the time (its context lives in columns). */}
      <p
        className={cn(
          "mt-0.5 pl-6.5 text-xs text-muted-foreground",
          compact && "mt-0"
        )}
      >
        {format(new Date(trx.date), "h:mm a")}
        {secondary != null ? <> · {secondary}</> : null}
      </p>
    </>
  )
}

// ── Statement secondary label (contextual movement + counterparty + fee) ──
function statementSecondary(
  trx: TransactionRecord,
  viewedAccountId: string | undefined
): React.ReactNode {
  if (trx.type !== "transfer") {
    return (
      trx.category?.name ??
      trx.merchant?.name ??
      (trx.isSplit ? "Split" : "Uncategorized")
    )
  }
  const dir =
    viewedAccountId != null && signedDeltaForAccount(trx, viewedAccountId) >= 0n
      ? 1
      : -1
  const noun = moneyMovementLabel({
    kind: trx.kind,
    purpose: trx.transferPurpose,
  })
  // The counterparty is ALWAYS the other account, never the one being viewed.
  const counterpartyName =
    (trx.accountId === viewedAccountId
      ? trx.toAccount?.name
      : trx.account?.name) ?? "account"
  const feeSuffix =
    trx.transferFee != null
      ? ` · ${formatCurrency(
          decodeMoney(trx.transferFee.amount),
          trx.transferFee.currency
        )} fee`
      : ""
  return dir === 1
    ? `${noun} from ${counterpartyName}${feeSuffix}`
    : `${noun} to ${counterpartyName}${feeSuffix}`
}

// ── Statement amount (signed from the account perspective) ──
function StatementAmount({
  trx,
  dir,
  compact,
}: {
  trx: TransactionRecord
  dir: 1 | -1
  compact: boolean
}) {
  return (
    <p
      className={cn(
        "shrink-0 text-right font-semibold tabular-nums",
        compact ? "text-sm" : "text-sm",
        dir === 1 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"
      )}
    >
      {dir === 1 ? "+" : "−"}
      {formatCurrency(trx.amount, trx.currency)}
    </p>
  )
}

// ── Cross-currency destination amount + fee note (ledger variant) ──
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
  variant,
}: {
  trx: TransactionRecord
  variant: "ledger" | "statement"
}) {
  const entries = trx.splitEntries ?? []
  if (variant === "statement") {
    return (
      <div className="border-l-2 border-l-amber-400 bg-muted/5 pb-1 dark:border-l-amber-600">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center justify-between gap-3 px-4 py-1.5 pl-13 text-sm text-muted-foreground"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.category?.color ?? "#999" }}
              />
              <span className="truncate">{entry.description}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {formatCurrency(entry.amount, trx.currency)}
            </span>
          </div>
        ))}
      </div>
    )
  }

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
            <div className="hidden w-52 shrink-0 px-4 xl:block">
              <span className="text-sm text-muted-foreground italic">-</span>
            </div>
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
