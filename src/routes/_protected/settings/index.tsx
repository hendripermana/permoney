import * as React from "react"
import { createFileRoute, Link, type LinkProps } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  Settings as SettingsIcon,
  Globe2,
  UserCircle2,
  Users,
  Wand2,
  Coins,
  FileSpreadsheet,
  ChevronRight,
  type LucideIcon,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { getSettingsOverviewFn } from "@/server/settings"

export const SETTINGS_OVERVIEW_KEY = ["settings-overview"] as const

export const Route = createFileRoute("/_protected/settings/")({
  ssr: false,
  staticData: { title: "Settings" },
  component: SettingsHubPage,
})

interface SettingsLink {
  title: string
  description: string
  to: LinkProps["to"]
  icon: LucideIcon
  badge?: string
}

const FAMILY_LINKS: SettingsLink[] = [
  {
    title: "Family preferences",
    description: "Base reporting currency and regional timezone.",
    to: "/settings/family",
    icon: Globe2,
  },
  {
    title: "Members",
    description: "Invite family members and manage their roles.",
    to: "/settings/members",
    icon: Users,
  },
  {
    title: "Smart rules",
    description: "Keyword rules that auto-categorize imported transactions.",
    to: "/settings/rules",
    icon: Wand2,
  },
]

const PERSONAL_LINKS: SettingsLink[] = [
  {
    title: "Profile & appearance",
    description: "Your display name and light / dark / system theme.",
    to: "/settings/profile",
    icon: UserCircle2,
  },
]

const RELATED_LINKS: SettingsLink[] = [
  {
    title: "Currencies & FX",
    description: "Manage exchange-rate snapshots used for base reporting.",
    to: "/currencies",
    icon: Coins,
  },
  {
    title: "Smart Import",
    description: "Import CSV / QIF statements and review staged rows.",
    to: "/import",
    icon: FileSpreadsheet,
  },
]

function SettingsHubPage() {
  const { data: overview } = useQuery({
    queryKey: SETTINGS_OVERVIEW_KEY,
    queryFn: async () => await getSettingsOverviewFn(),
  })

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 72)",
          } as React.CSSProperties
        }
      >
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            <div className="flex items-center gap-3">
              <SettingsIcon className="size-6 text-yellow-500" aria-hidden />
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Settings
                </h1>
                <p className="text-sm text-muted-foreground">
                  Workspace preferences, your profile, and the tools that keep
                  your ledger tidy.
                  {overview ? (
                    <>
                      {" "}
                      Reporting in{" "}
                      <span className="font-medium text-foreground">
                        {overview.family.currency}
                      </span>{" "}
                      · {overview.family.timezone}.
                    </>
                  ) : null}
                </p>
              </div>
            </div>

            <SettingsSection title="Family workspace" links={FAMILY_LINKS} />
            <SettingsSection title="Your account" links={PERSONAL_LINKS} />
            <SettingsSection title="Related tools" links={RELATED_LINKS} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function SettingsSection({
  title,
  links,
}: {
  title: string
  links: SettingsLink[]
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((link) => (
          <SettingsCard key={link.title} link={link} />
        ))}
      </div>
    </section>
  )
}

function SettingsCard({ link }: { link: SettingsLink }) {
  const Icon = link.icon
  return (
    <Link to={link.to} className="group">
      <Card
        className={cn(
          "h-full transition-transform",
          "hover:scale-[1.02] hover:border-primary/40"
        )}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <Icon className="size-5 text-yellow-500" aria-hidden />
            <ChevronRight
              className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </div>
          <CardTitle className="text-base">{link.title}</CardTitle>
          <CardDescription>{link.description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  )
}
