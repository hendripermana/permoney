"use client"

import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  IconChartBar,
  IconDashboard,
  IconDatabase,
  IconSettings,
  IconUsers,
  IconReceipt2,
} from "@tabler/icons-react"

import { NavMain, type NavItem } from "@/components/nav-main"
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
import { getSettingsOverviewFn, SETTINGS_OVERVIEW_KEY } from "@/server/settings"

// Kita ubah data navigasinya khusus untuk Permoney
const data: {
  navMain: NavItem[]
  navSecondary: NavItem[]
} = {
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
      url: "/accounts",
      icon: IconDatabase,
    },
    {
      title: "Budgets",
      url: "/budgets",
      icon: IconChartBar,
    },
    // PER-166 follow-up: "Smart Import" (/import) and "Currencies & FX"
    // (/currencies) intentionally live under Settings → "Related tools"
    // (settings/index.tsx), not the primary sidebar. PER-113 surfaced them in
    // Settings but left the duplicate top-level entries here; removed so each
    // destination has a single home.
  ],
  navSecondary: [
    {
      title: "Members",
      url: "/settings/members",
      icon: IconUsers,
    },
    {
      title: "Settings",
      url: "/settings",
      icon: IconSettings,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  // PER-186 — the sidebar is the one surface visible on every protected page,
  // so it's the canonical place to show WHICH account is live. Reading the
  // real session identity (instead of a hardcoded name/email) is the actual
  // fix: a multi-account user must never see a plausible-looking identity
  // that isn't the one they're actually acting as.
  const { data: overview } = useQuery({
    queryKey: SETTINGS_OVERVIEW_KEY,
    queryFn: () => getSettingsOverviewFn(),
  })

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <Link to="/dashboard">
                <div className="flex aspect-square size-6 items-center justify-center rounded-lg bg-yellow-500 text-black">
                  <span className="text-lg font-bold">🍯</span>
                </div>
                <span className="text-base font-bold tracking-tight">
                  Permoney
                </span>
              </Link>
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
        <NavUser
          user={
            overview
              ? {
                  name: overview.profile.name,
                  email: overview.profile.email,
                  avatar: overview.profile.image,
                }
              : undefined
          }
        />
      </SidebarFooter>
    </Sidebar>
  )
}
