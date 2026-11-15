import * as React from "react"

import { Input } from "@/components/ui/input"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { parseMoneyInput } from "@/lib/money"
import { cn } from "@/lib/utils"

// PER-240 — shared money entry field. Wraps the shadcn <Input> and renders a
// live, locale-agnostic preview beneath it so what will actually be SAVED is
// never ambiguous. The app displays money via Intl (en-US: comma thousands,
// dot decimal), but users may type either convention; `parseMoneyInput`
// auto-detects the decimal separator from the input's own shape, and this
// component echoes the resolved value back as `= Rp 5,085,360.00`.
//
// Deep-module contract: the field is controlled purely by a RAW STRING. The
// PARENT keeps that raw text and derives `Money` on submit via
// `parseMoneyInput` (single source of truth) — this component does not push
// parsed state upward, so there is no callback plumbing or effect to keep in
// sync. The preview is a pure `useMemo` derivation (no useEffect).

type MoneyInputProps = {
  /** Raw, user-typed text. The parent owns this string. */
  readonly value: string
  /** Called with the new raw text on every keystroke. */
  readonly onChange: (raw: string) => void
  /** Currency the preview formats in and the parser targets. */
  readonly currency: CurrencyCode
  /** Optional class for the wrapping element (not the input). */
  readonly className?: string
  /**
   * Optional class for the inner `<Input>` itself. Needed by callers that
   * render a currency symbol as an absolutely-positioned sibling and pad the
   * input to make room for it (the transaction form's money fields).
   */
  readonly inputClassName?: string
  /**
   * The line that explains WHERE this number came from (e.g. "NAV 14 Aug 2026
   * (from market data)"). Rendered under the preview; `null` renders nothing.
   */
  readonly hint?: string | null
  /**
   * When the typed value differs from the field's default, the caller offers a
   * one-click way back to that default ("Use NAV 14 Aug 2026: Rp 1,234.56").
   * The button REPLACES the hint line while it is set.
   */
  readonly restoreLabel?: string | null
  /** Click handler for the restore button (required when `restoreLabel` is set). */
  readonly onRestore?: () => void
} & Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "inputMode" | "className"
>

export function MoneyInput({
  value,
  onChange,
  currency,
  className,
  inputClassName,
  hint,
  restoreLabel,
  onRestore,
  ...inputProps
}: MoneyInputProps) {
  // Pure derivation of the preview — recomputed only when the text or currency
  // changes. `parseMoneyInput` never throws; it returns null for the
  // "not a valid amount yet" state.
  const preview = React.useMemo<
    { kind: "empty" } | { kind: "valid"; text: string } | { kind: "invalid" }
  >(() => {
    if (value.trim() === "") return { kind: "empty" }
    const money = parseMoneyInput(value, currency)
    if (money === null) return { kind: "invalid" }
    return { kind: "valid", text: formatCurrency(money, currency) }
  }, [value, currency])

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Input
        inputMode="decimal"
        className={inputClassName}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...inputProps}
      />
      {/* The line is always laid out and its height reserved, so the first
          keystroke cannot grow the surrounding layout. Before this, the preview
          element appeared only once the field was non-empty — which added ~22px
          to every dialog that uses a MoneyInput, and because dialogs here are
          centred, that pushed their footer button down mid-interaction (CI
          #379: Playwright saw "element is not stable", then "element was
          detached from the DOM, retrying"). It also stops the form jumping
          while a household types. */}
      <p
        className={cn(
          "min-h-[1rem] text-xs tabular-nums",
          preview.kind === "invalid"
            ? "text-muted-foreground/70"
            : "text-muted-foreground"
        )}
      >
        {preview.kind === "valid"
          ? `= ${preview.text}`
          : preview.kind === "invalid"
            ? "Enter a valid amount"
            : ""}
      </p>
      {/* WHERE this number came from — and the one-click way back to the
          default once the user overrides it (the Buy/Sell + Switch price
          field's NAV contract, issue #460).

          The line's height is RESERVED (like the preview line above it) so
          swapping the label for the restore button — or the hint appearing for
          the first time — never pushes the dialog's footer button down
          mid-interaction (the CI #379 "element is not stable" flake). The
          container only exists for fields that opted into a hint, so every
          other money field keeps its current layout. */}
      {hint !== undefined || restoreLabel !== undefined ? (
        <div className="min-h-[1rem]">
          {restoreLabel !== null && restoreLabel !== undefined && onRestore ? (
            <button
              type="button"
              className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={onRestore}
            >
              {restoreLabel}
            </button>
          ) : hint !== null && hint !== undefined ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
