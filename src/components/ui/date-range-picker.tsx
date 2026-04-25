"use client"

import * as React from "react"
import {
  format,
  subDays,
  startOfMonth,
  endOfMonth,
  startOfYear,
  startOfToday,
  endOfToday,
} from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// 1. Definisikan Presets Secara Deklaratif (Bukan Hardcoded di UI)
const PRESETS = [
  {
    label: "Today",
    getValue: (): DateRange => ({ from: startOfToday(), to: endOfToday() }),
  },
  {
    label: "7 Days",
    getValue: (): DateRange => ({
      from: subDays(startOfToday(), 7),
      to: endOfToday(),
    }),
  },
  {
    label: "30 Days",
    getValue: (): DateRange => ({
      from: subDays(startOfToday(), 30),
      to: endOfToday(),
    }),
  },
  {
    label: "This Month",
    getValue: (): DateRange => ({
      from: startOfMonth(startOfToday()),
      to: endOfMonth(startOfToday()),
    }),
  },
  {
    label: "Year to Date",
    getValue: (): DateRange => ({
      from: startOfYear(startOfToday()),
      to: endOfToday(),
    }),
  },
]

interface PermoneyDateRangePickerProps {
  date: DateRange | undefined
  onUpdate: (date: DateRange | undefined) => void
  className?: string
}

export function PermoneyDateRangePicker({
  date,
  onUpdate,
  className,
}: PermoneyDateRangePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false)

  // Internal state untuk menyimpan pilihan SEMENTARA sebelum di-Apply
  const [tempDate, setTempDate] = React.useState<DateRange | undefined>(date)

  // Handler cerdas: Hanya sinkronisasi state saat Popover dibuka
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (open) {
      setTempDate(date) // Reset temp state ke state aktual saat dibuka
    }
  }

  const handleApply = () => {
    onUpdate(tempDate)
    setIsOpen(false)
  }

  const handleClear = () => {
    setTempDate(undefined)
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id="date"
          variant={"outline"}
          className={cn(
            "w-[300px] justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date?.from ? (
            date.to ? (
              <>
                {format(date.from, "LLL dd, y")} -{" "}
                {format(date.to, "LLL dd, y")}
              </>
            ) : (
              format(date.from, "LLL dd, y")
            )
          ) : (
            <span>Filter by Date Range</span>
          )}
        </Button>
      </PopoverTrigger>

      {/* Container Lebar untuk menampung Presets + Calendar */}
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col divide-y md:flex-row md:divide-x md:divide-y-0">
          {/* Bagian Kiri: Presets (Mirip Screenshot) */}
          <div className="flex w-full flex-col gap-2 p-4 md:w-[150px]">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                className="justify-start text-left font-normal"
                onClick={() => setTempDate(preset.getValue())}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {/* Bagian Kanan: Kalender */}
          <div className="p-2">
            <Calendar
              initialFocus
              mode="range"
              defaultMonth={tempDate?.from}
              selected={tempDate}
              onSelect={setTempDate}
              numberOfMonths={2} // Menampilkan 2 bulan sekaligus jika layar cukup
            />
          </div>
        </div>

        {/* Bagian Bawah: Footer Actions */}
        <div className="flex items-center justify-between border-t p-4">
          <Button variant="ghost" size="sm" onClick={handleClear}>
            Clear All
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={handleApply}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
