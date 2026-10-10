import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import {
  RiMore2Line,
  RiUserLine,
  RiBankCardLine,
  RiNotification3Line,
  RiLogoutBoxLine,
} from "@remixicon/react"
import { useMutation } from "@tanstack/react-query"
import { useServerFn } from "@tanstack/react-start"
import { toast } from "sonner"
import { logoutFn } from "@/server/auth-fns"

/**
 * The no-data state of the sidebar identity (PER-186 fetches it on mount).
 *
 * It is decorative: an empty `Skeleton` row carries no information, so it must
 * not be exposed to assistive tech. It used to render as a `disabled`
 * `SidebarMenuButton` with only skeleton children, and axe reported it on every
 * protected page as a `button-name` violation (`<button class="…h-14…">` with
 * no discernible text). Rendering through a Slot keeps the sidebar row geometry
 * identical while removing the button role entirely, and `aria-hidden` keeps a
 * screen reader from announcing an empty row.
 */
export function SidebarIdentitySkeleton() {
  return (
    <SidebarMenuButton asChild size="lg" className="cursor-default">
      <div aria-hidden="true">
        <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
        <div className="grid flex-1 gap-1.5">
          <Skeleton className="h-3.5 w-24 rounded" />
          <Skeleton className="h-3 w-32 rounded" />
        </div>
      </div>
    </SidebarMenuButton>
  )
}

// PER-186 — a multi-account user cannot tell which account is live from a name
// alone (two Permoney accounts belonging to the same person share a display
// name). Initials come from the email local-part when it's ambiguous, so the
// avatar itself doesn't repeat the same misleading "same person" impression.
function initialsFor(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  if (words.length === 1 && words[0].length >= 2) {
    return words[0].slice(0, 2).toUpperCase()
  }
  const local = email.split("@")[0] ?? ""
  return (local.slice(0, 2) || "?").toUpperCase()
}

export interface NavUserIdentity {
  name: string
  email: string
  avatar?: string | null
}

export function NavUser({ user }: { user: NavUserIdentity | undefined }) {
  const { isMobile } = useSidebar()
  const logout = useServerFn(logoutFn)

  // PER-166 — wire the previously-dead Log out item. Go through the logoutFn
  // server function (same relative, port-agnostic path as loginFn) rather than
  // the client auth-client whose baseURL is pinned to :3006 and silently fails
  // off that port. On success land on the public landing at "/". On failure
  // surface a toast instead of leaving the user in silent limbo (the failure
  // mode this ticket exists to kill).
  //
  // PER-187 follow-up, now a full document navigation rather than a soft one:
  // `logoutFn` has already killed the server session by the time this runs, so
  // anything the client does next against the network is defined to fail.
  // `queryClient.clear()` used to be enough (it empties the cache without
  // refetching), but with @tanstack/query-db-collection 1.4.0 a removed query
  // whose collection still has subscribers — the dashboard is still mounted —
  // is eagerly re-subscribed and refetched, so the clear itself fires the very
  // refetches this handler exists to avoid: they fail UNAUTHENTICATED and
  // query-client.ts's global auth-error handler hard-redirects to /login,
  // beating the intended landing navigation. A document navigation tears the
  // whole in-memory client down in one step — no refetch can race it, no
  // tenant data survives — which is also the right posture for a logout
  // boundary.
  const logoutMutation = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      window.location.assign("/")
    },
    onError: () => {
      toast.error("Couldn't sign you out. Please try again.")
    },
  })

  // PER-186 — the sidebar identity is fetched from the server on mount (see
  // AppSidebar), so there's a brief window with no data yet. Show a skeleton
  // rather than a placeholder name/email: a fake-but-plausible identity in
  // that gap is exactly the kind of "looks like a real account" ambiguity
  // this ticket exists to remove.
  if (!user) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarIdentitySkeleton />
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  const initials = initialsFor(user.name, user.email)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg grayscale">
                <AvatarImage src={user.avatar ?? undefined} alt={user.name} />
                <AvatarFallback className="rounded-lg">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
              <RiMore2Line className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage src={user.avatar ?? undefined} alt={user.name} />
                  <AvatarFallback className="rounded-lg">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <RiUserLine />
                Account
              </DropdownMenuItem>
              <DropdownMenuItem>
                <RiBankCardLine />
                Billing
              </DropdownMenuItem>
              <DropdownMenuItem>
                <RiNotification3Line />
                Notifications
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={logoutMutation.isPending}
              onSelect={(event) => {
                // Keep the menu logic simple: fire the mutation; the toast/redirect
                // are handled in its callbacks.
                event.preventDefault()
                logoutMutation.mutate()
              }}
            >
              <RiLogoutBoxLine />
              {logoutMutation.isPending ? "Signing out…" : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
