import * as React from "react"
import { IconLayoutList, IconLayoutRows } from "@tabler/icons-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  readStoredDensity,
  writeStoredDensity,
  type TransactionRowDensity,
} from "@/lib/transaction-list"

/**
 * PER-241 — persisted density preference for the transaction lists.
 *
 * Reads the stored choice ONCE in the initializer (client-only routes), and
 * persists on change from the event handler — no `useEffect` (no-use-effect
 * rule). Sensible default is "comfortable".
 */
export function useTransactionDensity(): readonly [
  TransactionRowDensity,
  (next: TransactionRowDensity) => void,
] {
  const [density, setDensity] =
    React.useState<TransactionRowDensity>(readStoredDensity)

  const update = React.useCallback((next: TransactionRowDensity) => {
    setDensity(next)
    writeStoredDensity(next)
  }, [])

  return [density, update]
}

/** Compact ↔ comfortable segmented control. */
export function TransactionDensityToggle({
  density,
  onChange,
}: {
  density: TransactionRowDensity
  onChange: (next: TransactionRowDensity) => void
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={density}
      onValueChange={(value) => {
        // Radix emits "" when the active item is re-clicked; ignore that so the
        // list always has a density.
        if (value === "comfortable" || value === "compact") onChange(value)
      }}
      aria-label="Row density"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="comfortable" aria-label="Comfortable rows">
            <IconLayoutRows className="size-4" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Comfortable</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="compact" aria-label="Compact rows">
            <IconLayoutList className="size-4" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Compact</TooltipContent>
      </Tooltip>
    </ToggleGroup>
  )
}
