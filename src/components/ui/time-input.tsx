// Komponen input waktu yang ringan, aksesibel, dan selaras dengan estetika Shadcn.
// Menggunakan native <input type="time"> untuk kompatibilitas browser maksimal
// dan aksesibilitas bawaan tanpa dependensi tambahan.

import * as React from "react"
import { cn } from "@/lib/utils"
import { IconClock } from "@tabler/icons-react"

interface TimeInputProps {
  // Menerima full Date object — kita hanya membaca/menulis bagian jam dan menit
  value: Date | undefined
  onChange: (newDate: Date) => void
  className?: string
  disabled?: boolean
  id?: string
  name?: string
}

export function TimeInput({
  value,
  onChange,
  className,
  disabled,
  id,
  name,
}: TimeInputProps) {
  // Format Date → "HH:MM" untuk value native input
  const timeString = value
    ? `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`
    : ""

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const [hours, minutes] = e.target.value.split(":").map(Number)

    // Pertahankan tanggal yang sudah dipilih, hanya update jam & menit
    const updated = value ? new Date(value) : new Date()
    updated.setHours(hours ?? 0, minutes ?? 0, 0, 0)
    onChange(updated)
  }

  return (
    <div className="relative">
      <IconClock className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        id={id}
        name={name}
        type="time"
        value={timeString}
        onChange={handleChange}
        disabled={disabled}
        className={cn(
          // Selaraskan dengan kelas `Input` Shadcn
          "flex h-10 w-full rounded-md border border-input bg-background py-2 pr-3 pl-9 text-sm ring-offset-background",
          "transition-colors placeholder:text-muted-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Hapus chrome-specific arrow styling agar konsisten lintas browser
          "[&::-webkit-calendar-picker-indicator]:opacity-0",
          className
        )}
      />
    </div>
  )
}
