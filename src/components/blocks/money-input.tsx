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
    </div>
  )
}
