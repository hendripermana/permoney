import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Globe2, ArrowRight } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getSettingsOverviewFn,
  SETTINGS_OVERVIEW_KEY,
  updateFamilyPreferencesFn,
} from "@/server/settings"

export const Route = createFileRoute("/_protected/settings/family")({
  ssr: false,
  staticData: { title: "Family preferences" },
  component: FamilyPreferencesPage,
})

// A curated shortlist for the dropdown. The server accepts any valid IANA zone,
// and the caller's current zone is always merged in below so a value chosen
// elsewhere never disappears from the list.
const COMMON_TIMEZONES = [
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "UTC",
] as const

function FamilyPreferencesPage() {
  const queryClient = useQueryClient()
  const { data: overview, isLoading } = useQuery({
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
              <Globe2 className="size-6 text-yellow-500" aria-hidden />
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Family preferences
                </h1>
                <p className="text-sm text-muted-foreground">
                  Workspace-wide settings that apply to every member.
                </p>
              </div>
            </div>

            <BaseCurrencyCard currency={overview?.family.currency ?? "—"} />
            <TimezoneCard
              key={overview?.family.timezone}
              timezone={overview?.family.timezone}
              isLoading={isLoading}
              onSaved={() =>
                queryClient.invalidateQueries({
                  queryKey: SETTINGS_OVERVIEW_KEY,
                })
              }
            />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function BaseCurrencyCard({ currency }: { currency: string }) {
  // ADR-0035: the base reporting currency is fixed at onboarding — it anchors
  // every historical report and the materialized base projection, so it is
  // intentionally read-only here. Rate management lives under Currencies & FX.
  return (
    <Card>
      <CardHeader>
        <CardTitle>Base reporting currency</CardTitle>
        <CardDescription>
          Every report is normalized to this currency. It was set when your
          workspace was created and is fixed for the life of the ledger.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-md border bg-muted px-3 py-1.5 font-mono text-lg font-semibold">
            {currency}
          </span>
          <span className="text-sm text-muted-foreground">
            Set at onboarding · locked
          </span>
        </div>
      </CardContent>
      <CardFooter>
        <Button asChild variant="outline" size="sm">
          <Link to="/currencies">
            Manage exchange rates
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

function TimezoneCard({
  timezone,
  isLoading,
  onSaved,
}: {
  timezone: string | undefined
  isLoading: boolean
  onSaved: () => void
}) {
  // Initialized once from the server value (the `key` on this component resets
  // state whenever the persisted timezone changes), so no effect-based sync.
  const [selected, setSelected] = React.useState(timezone ?? "")

  const options = React.useMemo(() => {
    const set = new Set<string>(COMMON_TIMEZONES)
    if (timezone) set.add(timezone)
    if (selected) set.add(selected)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [timezone, selected])

  const mutation = useMutation({
    mutationFn: async () =>
      await updateFamilyPreferencesFn({ data: { timezone: selected } }),
    onSuccess: () => {
      toast.success("Timezone updated.")
      onSaved()
    },
    onError: (error) => toast.error((error as Error).message),
  })

  const dirty = selected !== "" && selected !== timezone

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regional timezone</CardTitle>
        <CardDescription>
          Used to align reporting periods and day boundaries for the whole
          workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="timezone">Timezone</Label>
          <Select
            value={selected}
            onValueChange={setSelected}
            disabled={isLoading || mutation.isPending}
          >
            <SelectTrigger id="timezone">
              <SelectValue placeholder="Select a timezone" />
            </SelectTrigger>
            <SelectContent>
              {options.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!dirty || mutation.isPending}
        >
          {mutation.isPending ? "Saving…" : "Save timezone"}
        </Button>
      </CardFooter>
    </Card>
  )
}
