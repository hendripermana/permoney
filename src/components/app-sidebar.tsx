"use client"

import * as React from "react"
import {
  IconChartBar,
  IconDashboard,
  IconDatabase,
  IconSettings,
  IconUsers,
  IconReceipt2,
  IconFileSpreadsheet,
} from "@tabler/icons-react"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

// Kita ubah data navigasinya khusus untuk Permoney
const data = {
  user: {
    name: "Hendri Permana",
    email: "hendripermana13@gmail.com",
    avatar: "/avatars/shadcn.jpg", // Nanti bisa diganti foto profilmu
  },
  navMain: [
    {
      title: "Dashboard",
      url: "/dashboard",
      icon: IconDashboard,
    },
    {
      title: "Transactions",
      url: "/transactions",
      icon: IconReceipt2,
    },
    {
      title: "Accounts & Wallets",
      url: "#",
      icon: IconDatabase,
    },
    {
      title: "Smart Import",
      url: "/import",
      icon: IconFileSpreadsheet,
    },
    {
      title: "Budgets",
      url: "#",
      icon: IconChartBar,
    },
  ],
  navSecondary: [
    {
      title: "Family Space",
      url: "#",
      icon: IconUsers,
    },
    {
      title: "Settings",
      url: "#",
      icon: IconSettings,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <a href="/dashboard">
                <div className="flex aspect-square size-6 items-center justify-center rounded-lg bg-yellow-500 text-black">
                  <span className="text-lg font-bold">🍯</span>
                </div>
                <span className="text-base font-bold tracking-tight">
                  Permoney
                </span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Menu Utama */}
        <NavMain items={data.navMain} />
        {/* Menu Secondary (Settings dll) ditaruh di bawah */}
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  )
}
