import * as React from "react"
import { IconCheck, IconChevronDown, IconPlus } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export interface EntityComboboxItem {
  id: string
  label: string
}

interface EntityComboboxProps {
  readonly id?: string
  readonly items: Array<EntityComboboxItem>
  readonly value: string
  readonly onChange: (id: string) => void
  readonly onCreate: (name: string) => Promise<EntityComboboxItem>
  readonly placeholder: string
  readonly searchPlaceholder: string
  readonly emptyLabel: string
  readonly createLabel: (query: string) => string
  readonly disabled?: boolean
  readonly "aria-invalid"?: boolean
  /** Optional fields (e.g. Merchant) surface a "-- clear --" item. */
  readonly clearLabel?: string
}

/**
 * Searchable select with an inline "Create '<query>' " affordance (PER-189).
 * The caller owns persistence (`onCreate`) and item refresh — this component
 * only owns the popover/search/pending-state UI contract.
 */
export function EntityCombobox({
  id,
  items,
  value,
  onChange,
  onCreate,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  createLabel,
  disabled,
  "aria-invalid": ariaInvalid,
  clearLabel,
}: EntityComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Bridges the gap between "create resolved" and "the refetched items list
  // actually contains the new row" so the trigger shows the right label
  // immediately instead of falling back to the placeholder for a beat.
  const [optimisticItem, setOptimisticItem] =
    React.useState<EntityComboboxItem | null>(null)

  const selected =
    items.find((item) => item.id === value) ??
    (optimisticItem?.id === value ? optimisticItem : undefined)
  const trimmedSearch = search.trim()
  const hasExactMatch = items.some(
    (item) => item.label.toLowerCase() === trimmedSearch.toLowerCase()
  )
  const canCreate = trimmedSearch.length > 0 && !hasExactMatch

  const resetAndClose = () => {
    setOpen(false)
    setSearch("")
    setError(null)
  }

  const handleCreate = async () => {
    if (!canCreate || pending) return
    setPending(true)
    setError(null)
    try {
      const created = await onCreate(trimmedSearch)
      setOptimisticItem(created)
      onChange(created.id)
      resetAndClose()
    } catch (creationError: unknown) {
      setError(
        creationError instanceof Error
          ? creationError.message
          : "Could not create this entry. Please try again."
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setSearch("")
          setError(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn(!selected && "text-muted-foreground")}>
            {selected ? selected.label : placeholder}
          </span>
          <IconChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {clearLabel && !trimmedSearch && value && (
              <CommandItem
                value="__clear__"
                onSelect={() => {
                  onChange("")
                  resetAndClose()
                }}
              >
                {clearLabel}
              </CommandItem>
            )}
            {items
              .filter((item) =>
                item.label.toLowerCase().includes(trimmedSearch.toLowerCase())
              )
              .map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => {
                    onChange(item.id)
                    resetAndClose()
                  }}
                  data-checked={item.id === value}
                >
                  <IconCheck
                    className={cn(
                      "size-4",
                      item.id === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {item.label}
                </CommandItem>
              ))}
            {!trimmedSearch && items.length === 0 && (
              <CommandEmpty>{emptyLabel}</CommandEmpty>
            )}
            {canCreate && (
              <CommandGroup>
                <CommandItem
                  value={`__create__${trimmedSearch}`}
                  disabled={pending}
                  onSelect={() => void handleCreate()}
                >
                  <IconPlus className="size-4" />
                  {pending ? "Creating…" : createLabel(trimmedSearch)}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
          {error && (
            <p
              role="alert"
              className="border-t border-destructive/20 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
