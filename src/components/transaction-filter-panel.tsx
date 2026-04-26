// src/components/transaction-filter-panel.tsx
"use client"

import * as React from "react"
import {
  IconFilter,
  IconCalendar,
  IconCategory,
  IconBuildingBank,
  IconReceipt,
  IconCash,
  IconBuildingStore,
  IconSearch,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { getTransactionFormData } from "@/server/transactions"

// THE MAANG TYPE DERIVATION
// Kita merampok tipe data dari hasil kembalian fungsi server, bukan dari database!
type TransactionFormData = Awaited<ReturnType<typeof getTransactionFormData>>
type FormAccount = TransactionFormData["accounts"][number]
type FormCategory = TransactionFormData["categories"][number]
type FormMerchant = TransactionFormData["merchants"][number]

// === NEW IMPORTS UNTUK CALENDAR ===
import { format } from "date-fns"
import type { DateRange } from "react-day-picker"
import { Calendar } from "@/components/ui/calendar"

import { cn } from "@/lib/utils"
import type { TransactionFilters } from "@/lib/transaction-filters"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// === KONFIGURASI FILTER (Extensible Config Array) ===
// Nambah filter baru = nambah entry di sini. Tidak perlu ubah logic lain.

const FILTER_CATEGORIES = [
  { id: "date", label: "Date", icon: IconCalendar },
  { id: "type", label: "Type", icon: IconReceipt },
  { id: "accounts", label: "Account", icon: IconBuildingBank },
  { id: "categories", label: "Category", icon: IconCategory },
  { id: "merchants", label: "Merchant", icon: IconBuildingStore },
  { id: "amount", label: "Amount", icon: IconCash },
] as const

type FilterCategoryId = (typeof FILTER_CATEGORIES)[number]["id"]

// Preset periode waktu
const DATE_PRESETS = [
  { value: "1D", label: "Today" },
  { value: "7D", label: "7 Days" },
  { value: "MTD", label: "This Month" },
  { value: "30D", label: "30 Days" },
  { value: "90D", label: "90 Days" },
  { value: "YTD", label: "Year to Date" },
  { value: "ALL", label: "All Time" },
] as const

// Tipe transaksi
const TYPE_OPTIONS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
] as const

interface TransactionFilterPanelProps {
  filters: TransactionFilters
  onApply: (filters: TransactionFilters) => void
}

export function TransactionFilterPanel({
  filters,
  onApply,
}: TransactionFilterPanelProps) {
  const [isOpen, setIsOpen] = React.useState(false)
  // Panel kiri: kategori filter yang aktif
  const [activeCategory, setActiveCategory] =
    React.useState<FilterCategoryId>("date")

  // Draft state lokal — user bisa edit tanpa langsung apply
  const [draft, setDraft] = React.useState<TransactionFilters>(filters)

  // Search dalam panel filter (untuk cari akun/kategori/merchant)
  const [panelSearch, setPanelSearch] = React.useState("")

  // Ambil data referensi untuk dropdown
  const { data: formData } = useQuery<{
    accounts: Array<FormAccount>
    categories: Array<FormCategory>
    merchants: Array<FormMerchant>
  }>({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  // Reset draft saat popover dibuka
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setDraft(filters)
      setPanelSearch("")
    }
    setIsOpen(open)
  }

  // === UPDATED: Hitung Badge Utama ===
  const activeFilterCount = React.useMemo(() => {
    let count = 0
    // Cek apakah ada filter tanggal aktif (Preset ATAU Custom)
    if (
      (filters.period && filters.period !== "ALL") ||
      filters.dateFrom ||
      filters.dateTo
    )
      count++
    if (filters.type?.length) count++
    if (filters.accounts?.length) count++
    if (filters.categories?.length) count++
    if (filters.merchants?.length) count++
    if (filters.amountMin != null || filters.amountMax != null) count++
    return count
  }, [filters])

  // === UPDATED: Hitung Badge Kategori ===
  const getCategoryBadge = (categoryId: FilterCategoryId): number => {
    switch (categoryId) {
      case "date":
        return (draft.period && draft.period !== "ALL") ||
          draft.dateFrom ||
          draft.dateTo
          ? 1
          : 0
      case "type":
        return draft.type?.length ?? 0
      case "accounts":
        return draft.accounts?.length ?? 0
      case "categories":
        return draft.categories?.length ?? 0
      case "merchants":
        return draft.merchants?.length ?? 0
      case "amount":
        return (
          (draft.amountMin != null ? 1 : 0) + (draft.amountMax != null ? 1 : 0)
        )
      default:
        return 0
    }
  }

  // Handler Apply
  const handleApply = () => {
    onApply(draft)
    setIsOpen(false)
  }

  // Handler Cancel
  const handleCancel = () => {
    setDraft(filters)
    setIsOpen(false)
  }

  // Handler Clear All
  const handleClearAll = () => {
    setDraft({
      period: "ALL",
      dateFrom: undefined,
      dateTo: undefined,
      type: undefined,
      accounts: undefined,
      categories: undefined,
      merchants: undefined,
      amountMin: undefined,
      amountMax: undefined,
      q: filters.q, //preserve search query
    })
  }

  // Toggle item dalam array filter (account, category, merchant, type)
  const toggleArrayItem = (
    field: "type" | "accounts" | "categories" | "merchants",
    value: string
  ) => {
    setDraft((prev) => {
      const current = (prev[field] ?? []) as string[]
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      return {
        ...prev,
        [field]: next.length > 0 ? next : undefined,
      } as TransactionFilters
    })
  }

  // Helper: render searchable checkbox list (reusable untuk Account/Category/Merchant)
  function renderCheckboxList<T>(
    items: T[],
    field: "accounts" | "categories" | "merchants",
    getId: (item: T) => string,
    getLabel: (item: T) => string
  ) {
    const filtered = panelSearch
      ? items.filter((item) =>
          getLabel(item).toLowerCase().includes(panelSearch.toLowerCase())
        )
      : items

    return (
      <div className="space-y-3">
        {/* Search dalam panel */}
        <div className="relative">
          <IconSearch className="absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
          {/*
           * Accessibility: the visible label here is the dynamic placeholder, but
           * a placeholder is not a label — screen readers and Chrome's a11y audit
           * still demand a stable id/name pair plus an aria-label. The id is
           * scoped to the active category so each panel section gets its own
           * autofill history bucket in the browser.
           */}
          <Input
            id={`filter-panel-search-${activeCategory}`}
            name={`filter-panel-search-${activeCategory}`}
            aria-label={`Filter ${activeCategory}`}
            type="search"
            placeholder={`Filter ${activeCategory}...`}
            className="pl-8"
            value={panelSearch}
            onChange={(e) => setPanelSearch(e.target.value)}
          />
        </div>
        {/* Checkbox list */}
        <div className="max-h-48 space-y-2 overflow-y-auto">
          {filtered.map((item) => {
            const id = getId(item)
            return (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-3"
              >
                <Checkbox
                  checked={(draft[field] ?? []).includes(id)}
                  onCheckedChange={() => toggleArrayItem(field, id)}
                />
                <span className="text-sm">{getLabel(item)}</span>
              </label>
            )
          })}
          {filtered.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No results found.
            </p>
          )}
        </div>
      </div>
    )
  }

  // Render panel kanan berdasarkan kategori aktif
  const renderPanel = () => {
    switch (activeCategory) {
      // === NEW: DATE TAB DENGAN KALENDER DAN PRESET ===
      case "date":
        return (
          <div className="flex flex-col gap-5 pb-4">
            {/* Bagian Atas: Presets */}
            <div>
              <Label className="mb-3 block text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Quick Presets
              </Label>
              <div className="flex flex-wrap gap-2">
                {DATE_PRESETS.map((preset) => {
                  // Preset aktif JIKA valuenya cocok DAN tidak ada custom date yang terpilih
                  const isActive =
                    draft.period === preset.value &&
                    !draft.dateFrom &&
                    !draft.dateTo

                  return (
                    <Button
                      key={preset.value}
                      variant={isActive ? "default" : "outline"}
                      size="sm"
                      className={cn(
                        isActive &&
                          "bg-yellow-500 text-black hover:bg-yellow-600"
                      )}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          period: preset.value,
                          dateFrom: undefined, // Matikan custom date jika preset di-klik
                          dateTo: undefined,
                        }))
                      }
                    >
                      {preset.label}
                    </Button>
                  )
                })}
              </div>
            </div>

            {/* Bagian Bawah: Custom Calendar */}
            <div className="border-t pt-4">
              <Label className="mb-2 block text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Custom Range
              </Label>
              <div className="flex justify-center rounded-md border p-2">
                <Calendar
                  initialFocus
                  mode="range"
                  defaultMonth={
                    draft.dateFrom ? new Date(draft.dateFrom) : new Date()
                  }
                  selected={{
                    from: draft.dateFrom ? new Date(draft.dateFrom) : undefined,
                    to: draft.dateTo ? new Date(draft.dateTo) : undefined,
                  }}
                  onSelect={(range: DateRange | undefined) => {
                    setDraft((prev) => ({
                      ...prev,
                      period: undefined, // Matikan preset string jika kalender di-klik
                      dateFrom: range?.from
                        ? format(range.from, "yyyy-MM-dd")
                        : undefined,
                      dateTo: range?.to
                        ? format(range.to, "yyyy-MM-dd")
                        : undefined,
                    }))
                  }}
                  numberOfMonths={1}
                  captionLayout="dropdown"
                  fromYear={2000}
                  toYear={new Date().getFullYear() + 5}
                />
              </div>
            </div>
          </div>
        )

      case "type":
        return (
          <div className="space-y-3">
            {TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center gap-3"
              >
                <Checkbox
                  checked={draft.type?.includes(opt.value) ?? false}
                  onCheckedChange={() => toggleArrayItem("type", opt.value)}
                />
                <span className="text-sm">{opt.label}</span>
              </label>
            ))}
          </div>
        )

      case "accounts":
        return renderCheckboxList(
          formData?.accounts ?? [],
          "accounts",
          (a) => a.id,
          (a) => `${a.name} (${a.currency})`
        )

      case "categories":
        return renderCheckboxList(
          formData?.categories ?? [],
          "categories",
          (c) => c.id,
          (c) => c.name
        )

      case "merchants":
        return renderCheckboxList(
          formData?.merchants ?? [],
          "merchants",
          (m) => m.id,
          (m) => m.name
        )

      case "amount":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="filter-amount-min"
                className="text-xs text-muted-foreground"
              >
                Minimum Amount
              </Label>
              <Input
                id="filter-amount-min"
                name="filter-amount-min"
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={draft.amountMin ?? ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    amountMin: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="filter-amount-max"
                className="text-xs text-muted-foreground"
              >
                Maximum Amount
              </Label>
              <Input
                id="filter-amount-max"
                name="filter-amount-max"
                type="number"
                inputMode="decimal"
                placeholder="No limit"
                value={draft.amountMax ?? ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    amountMax: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  }))
                }
              />
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="bg-white dark:bg-zinc-900">
          <IconFilter className="mr-2 h-4 w-4" />
          Filter
          {activeFilterCount > 0 && (
            <Badge
              variant="secondary"
              className="ml-2 h-5 min-w-5 rounded-full bg-yellow-500 px-1.5 text-xs text-black"
            >
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[480px] p-0" align="start" sideOffset={8}>
        <div className="flex h-[380px]">
          {/* PANEL KIRI: Kategori Filter */}
          <div className="w-[160px] shrink-0 border-r bg-zinc-50/50 p-2 dark:bg-zinc-900/50">
            {FILTER_CATEGORIES.map((category) => {
              const badge = getCategoryBadge(category.id)
              return (
                <button
                  key={category.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    activeCategory === category.id
                      ? "bg-yellow-500/10 font-medium text-yellow-700 dark:text-yellow-400"
                      : "text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  )}
                  onClick={() => {
                    setActiveCategory(category.id)
                    setPanelSearch("")
                  }}
                >
                  <category.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{category.label}</span>
                  {badge > 0 && (
                    <Badge
                      variant="secondary"
                      className="h-5 min-w-5 rounded-full bg-yellow-500 px-1.5 text-xs text-black"
                    >
                      {badge}
                    </Badge>
                  )}
                </button>
              )
            })}
          </div>

          {/* PANEL KANAN: Konten filter aktif */}
          <div className="flex-1 overflow-y-auto p-4">{renderPanel()}</div>
        </div>

        {/* FOOTER: Cancel / Clear / Apply */}
        <div className="flex items-center justify-between border-t p-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={handleClearAll}
          >
            Clear All
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-yellow-500 font-bold text-black hover:bg-yellow-600"
              onClick={handleApply}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
