import * as React from "react"
import { IconCheck, IconPlus, IconX } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
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

export interface TagMultiSelectItem {
  id: string
  name: string
  color: string
}

interface TagMultiSelectProps {
  readonly id?: string
  readonly items: Array<TagMultiSelectItem>
  /** Selected tag ids. */
  readonly value: Array<string>
  readonly onChange: (ids: Array<string>) => void
  readonly onCreate: (name: string) => Promise<TagMultiSelectItem>
  readonly placeholder: string
  readonly searchPlaceholder: string
  readonly emptyLabel: string
  readonly createLabel: (query: string) => string
  readonly disabled?: boolean
}

/**
 * Multi-select tag picker (PER-145). Same popover/search/inline-create
 * contract as `EntityCombobox` (PER-189), extended for a many-value field: a
 * transaction can carry several tags, so the trigger renders removable chips
 * instead of a single label, and selecting an item toggles it rather than
 * closing the popover.
 */
export function TagMultiSelect({
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
}: TagMultiSelectProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Bridges "create resolved" and "the refetched items list actually
  // contains the new row" so the chip renders immediately (mirrors
  // EntityCombobox's optimisticItem).
  const [optimisticItems, setOptimisticItems] = React.useState<
    Array<TagMultiSelectItem>
  >([])

  const allItems = React.useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]))
    for (const item of optimisticItems) {
      if (!byId.has(item.id)) byId.set(item.id, item)
    }
    return byId
  }, [items, optimisticItems])

  const selected = value
    .map((tagId) => allItems.get(tagId))
    .filter((item): item is TagMultiSelectItem => item != null)
  const trimmedSearch = search.trim()
  const hasExactMatch = items.some(
    (item) => item.name.toLowerCase() === trimmedSearch.toLowerCase()
  )
  const canCreate = trimmedSearch.length > 0 && !hasExactMatch

  const toggleTag = (tagId: string) => {
    if (value.includes(tagId)) {
      onChange(value.filter((id) => id !== tagId))
    } else {
      onChange([...value, tagId])
    }
  }

  const removeTag = (tagId: string) => {
    onChange(value.filter((id) => id !== tagId))
  }

  const handleCreate = async () => {
    if (!canCreate || pending) return
    setPending(true)
    setError(null)
    try {
      const created = await onCreate(trimmedSearch)
      setOptimisticItems((prev) => [...prev, created])
      onChange([...value, created.id])
      setSearch("")
    } catch (creationError: unknown) {
      setError(
        creationError instanceof Error
          ? creationError.message
          : "Could not create this tag. Please try again."
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((item) => (
          <Badge
            key={item.id}
            variant="outline"
            className="gap-1 pr-1 font-normal"
            style={{ borderColor: item.color }}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: item.color }}
              aria-hidden
            />
            {item.name}
            {!disabled && (
              <button
                type="button"
                onClick={() => removeTag(item.id)}
                className="ml-0.5 rounded-full text-muted-foreground hover:text-foreground"
                aria-label={`Remove tag ${item.name}`}
              >
                <IconX className="size-3" />
              </button>
            )}
          </Badge>
        ))}

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
              size="sm"
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              className="h-7 gap-1 border-dashed font-normal"
            >
              <IconPlus className="size-3.5" />
              {selected.length === 0 ? placeholder : "Add tag"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={searchPlaceholder}
                value={search}
                onValueChange={setSearch}
              />
              <CommandList>
                {Array.from(allItems.values())
                  .filter((item) =>
                    item.name
                      .toLowerCase()
                      .includes(trimmedSearch.toLowerCase())
                  )
                  .map((item) => {
                    const isChecked = value.includes(item.id)
                    return (
                      <CommandItem
                        key={item.id}
                        value={item.id}
                        onSelect={() => toggleTag(item.id)}
                        data-checked={isChecked}
                      >
                        <IconCheck
                          className={cn(
                            "size-4",
                            isChecked ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: item.color }}
                          aria-hidden
                        />
                        {item.name}
                      </CommandItem>
                    )
                  })}
                {!trimmedSearch && allItems.size === 0 && (
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
      </div>
    </div>
  )
}
