import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { UserCircle2, Sun, Moon, Monitor } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  getSettingsOverviewFn,
  updateProfileFn,
  type Theme,
} from "@/server/settings"
import { SETTINGS_OVERVIEW_KEY } from "./index"

export const Route = createFileRoute("/_protected/settings/profile")({
  ssr: false,
  staticData: { title: "Profile" },
  component: ProfilePage,
})

function ProfilePage() {
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
              <UserCircle2 className="size-6 text-yellow-500" aria-hidden />
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Profile &amp; appearance
                </h1>
                <p className="text-sm text-muted-foreground">
                  Your display name and how Permoney looks on this device.
                </p>
              </div>
            </div>

            <ProfileCard
              key={`${overview?.profile.name}:${overview?.profile.theme}`}
              name={overview?.profile.name}
              email={overview?.profile.email ?? "—"}
              persistedTheme={overview?.profile.theme}
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

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

function ProfileCard({
  name,
  email,
  persistedTheme,
  isLoading,
  onSaved,
}: {
  name: string | undefined
  email: string
  persistedTheme: Theme | undefined
  isLoading: boolean
  onSaved: () => void
}) {
  const { setTheme } = useTheme()
  // Seeded once from the server (the `key` on this component resets it whenever
  // the persisted values change). next-themes owns the live DOM class; this
  // local state is the not-yet-saved selection persisted to User.theme.
  const [displayName, setDisplayName] = React.useState(name ?? "")
  const [theme, setLocalTheme] = React.useState<Theme>(
    persistedTheme ?? "system"
  )

  const mutation = useMutation({
    mutationFn: async () =>
      await updateProfileFn({ data: { name: displayName.trim(), theme } }),
    onSuccess: () => {
      toast.success("Profile updated.")
      onSaved()
    },
    onError: (error) => toast.error((error as Error).message),
  })

  const dirty =
    displayName.trim() !== "" &&
    (displayName.trim() !== (name ?? "") || theme !== persistedTheme)

  // Apply the theme to the DOM immediately for instant preview; the durable
  // write to User.theme happens on Save.
  const chooseTheme = (next: Theme) => {
    setLocalTheme(next)
    setTheme(next)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your profile</CardTitle>
        <CardDescription>
          Visible to other members of your family workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="display-name">Display name</Label>
          <Input
            id="display-name"
            value={displayName}
            maxLength={120}
            disabled={isLoading || mutation.isPending}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            value={email}
            readOnly
            aria-readonly
            tabIndex={-1}
            className="text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">
            Email changes require verification (coming soon).
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label>Theme</Label>
          <div className="flex flex-wrap gap-2">
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon
              const active = theme === option.value
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  className={cn(active && "ring-2 ring-primary/40")}
                  onClick={() => chooseTheme(option.value)}
                >
                  <Icon className="size-4" aria-hidden />
                  {option.label}
                </Button>
              )
            })}
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!dirty || mutation.isPending}
        >
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  )
}
