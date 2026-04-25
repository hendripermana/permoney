import { useMatches } from "@tanstack/react-router"

import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

// Deklarasi tipe untuk staticData route kita
interface RouteStaticData {
  title?: string
}

export function SiteHeader() {
  // Ambil semua route match yang aktif (dari root sampai halaman saat ini)
  const matches = useMatches()

  // Ambil judul dari route terakhir (paling spesifik/dalam)
  const currentMatch = matches[matches.length - 1]
  const pageTitle =
    (currentMatch?.staticData as RouteStaticData | undefined)?.title ??
    "Permoney"

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <h1 className="text-base font-medium">{pageTitle}</h1>
      </div>
    </header>
  )
}
