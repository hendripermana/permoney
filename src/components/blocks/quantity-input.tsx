import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  formatQuantityGrouped,
  parseQuantityInput,
  quantityInWords,
  unambiguousQuantityText,
} from "@/lib/quantity-input"
import { cn } from "@/lib/utils"

// Shared units/quantity entry field — the quantity twin of <MoneyInput>
// (PER-240). Users type quantities in either convention (`1,354.5` en-US or
// `1.354,5` id-ID) and the strict server contract only accepts canonical
// dot-decimal text, so the raw text is interpreted by `parseQuantityInput` and
// the resolved reading is echoed back beneath the field as
// `Read as: 1,354.5 units`. A text like `1.354` is genuinely ambiguous (1.354
// units, or one thousand three hundred fifty-four?) — never guessed: the field
// shows both readings as buttons, and choosing one rewrites the text to an
// unambiguous spelling.
//
// Deep-module contract (same as MoneyInput): controlled purely by a RAW STRING
// the PARENT owns. The parent derives the canonical value on submit with
// `parseQuantityInput` (single source of truth) and treats anything but
// `status === "ok"` as "not submittable". The preview is a pure `useMemo`
// derivation — no useEffect.

type QuantityInputProps = {
  /** Raw, user-typed text. The parent owns this string. */
  readonly value: string
  /** Called with the new raw text on every keystroke or ambiguity choice. */
  readonly onChange: (raw: string) => void
  /** Noun for the preview line ("units", "grams", "shares"). */
  readonly unitLabel?: string
  /** Optional class for the wrapping element (not the input). */
  readonly className?: string
} & Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "inputMode" | "className"
>

export function QuantityInput({
  value,
  onChange,
  unitLabel = "units",
  className,
  ...inputProps
}: QuantityInputProps) {
  const parsed = React.useMemo(() => parseQuantityInput(value), [value])

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={parsed.status === "invalid" ? true : undefined}
        {...inputProps}
      />
      {parsed.status === "ok" ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          Read as: {formatQuantityGrouped(parsed.value)}{" "}
          {parsed.value === "1" ? "unit" : unitLabel}
        </p>
      ) : null}
      {parsed.status === "invalid" ? (
        <p className="text-xs text-destructive">{parsed.reason}</p>
      ) : null}
      {parsed.status === "ambiguous" ? (
        <div
          role="group"
          aria-label="Choose how to read this quantity"
          className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2"
        >
          <p className="text-xs text-muted-foreground">
            A dot or comma can be a decimal point or a thousands separator.
            Which quantity did you mean?
          </p>
          {parsed.candidates.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto w-full flex-col items-start gap-0 rounded-lg px-3 py-1.5 text-left whitespace-normal"
              onClick={() => onChange(unambiguousQuantityText(candidate))}
            >
              <span className="text-sm font-medium tabular-nums">
                {formatQuantityGrouped(candidate)} {unitLabel}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {quantityInWords(candidate)}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
