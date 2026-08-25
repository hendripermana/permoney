import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TimeInput } from "@/components/ui/time-input"

// The one Date+Time field shape shared by every money-movement dialog (Buy/Sell,
// Switch, Dividend, Fee, and their correction forms) — factored out once several
// of them started carrying byte-identical copies of it.
//
// 2026-08-25, real creator report: a trade was recorded with the right data but
// the WRONG TIME, and nothing in the UI could fix it — every trade dialog only
// offered a bare `<input type="date">`, which silently posts midnight. The
// column (`Transaction.date`) and the server schemas (`z.coerce.date()`) have
// always carried a full timestamp; the gap was purely client-side.
//
// The time half is the SAME `TimeInput` primitive the main ledger's "New
// Transaction" modal uses (`transaction-form-modal.tsx` → `DateTimeFields`), and
// the merge rule is the same one that modal applies: picking a date keeps the
// chosen time-of-day, picking a time keeps the chosen date. One implementation,
// no per-dialog copies.
//
// The value is a real `Date` with full precision — NOT a "YYYY-MM-DD" string.
// Callers submit `value.toISOString()`, so the instant the user picked is the
// instant that posts.

/**
 * Format a Date as the LOCAL calendar day for `<input type="date">`.
 *
 * Deliberately not `toISOString().slice(0, 10)` (what every dialog used before):
 * that renders the UTC day, so a user east of UTC recording just after midnight
 * saw yesterday's date pre-filled. Local in, local out — the round-trip through
 * the server stays consistent because both directions use the local calendar.
 */
export function toLocalDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function DialogDateTimeField({
  id,
  value,
  onChange,
  disabled,
  required,
}: {
  id: string
  value: Date
  onChange: (value: Date) => void
  disabled?: boolean
  required?: boolean
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>Date</Label>
        <Input
          id={id}
          type="date"
          value={toLocalDateInputValue(value)}
          onChange={(e) => {
            // An empty/incomplete date input must not wipe the time-of-day the
            // user already chose — keep the previous value until the field
            // holds a real day again.
            const [year, month, day] = e.target.value.split("-").map(Number)
            if (!year || !month || !day) return
            const merged = new Date(value)
            merged.setFullYear(year, month - 1, day)
            onChange(merged)
          }}
          disabled={disabled}
          required={required}
        />
      </div>
      <div className="flex min-w-35 flex-col gap-2">
        <Label htmlFor={`${id}-time`}>Time</Label>
        <TimeInput
          id={`${id}-time`}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
