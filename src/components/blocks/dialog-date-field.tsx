import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// The one Date field shape shared by every money-movement dialog (Buy/Sell,
// Switch, Dividend, and their correction forms) — factored out once several
// of them started carrying byte-identical copies of it.
export function DialogDateField({
  id,
  value,
  onChange,
  disabled,
  required,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Date</Label>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
      />
    </div>
  )
}
