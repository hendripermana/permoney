"use client"

import { Link, type LinkProps } from "@tanstack/react-router"
import type { Icon } from "@tabler/icons-react"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export interface NavItem {
  title: string
  url: LinkProps["to"]
  icon: Icon
}

export function NavMain({ items }: { items: NavItem[] }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Menu Utama</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton asChild tooltip={item.title}>
              {/* TanStack <Link> keeps navigation client-side: no full reload,
                  so ssr:false + TanStack DB routes never re-boot on each click. */}
              <Link to={item.url} activeProps={{ "data-active": "true" }}>
                {item.icon && <item.icon className="size-5" />}
                <span className="font-medium">{item.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
