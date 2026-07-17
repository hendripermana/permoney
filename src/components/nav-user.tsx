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
import { useRouter } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useServerFn } from "@tanstack/react-start"
import { toast } from "sonner"
import { logoutFn } from "@/server/auth-fns"

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
  const router = useRouter()
  const queryClient = useQueryClient()
  const logout = useServerFn(logoutFn)

  // PER-166 — wire the previously-dead Log out item. Go through the logoutFn
  // server function (same relative, port-agnostic path as loginFn) rather than
  // the client auth-client whose baseURL is pinned to :3006 and silently fails
  // off that port. On success clear the server session, drop cached tenant
  // data, then land on the public landing at "/". On failure surface a toast
  // instead of leaving the user in silent limbo (the failure mode this ticket
  // exists to kill).
  //
  // PER-187 follow-up: this used to call `queryClient.invalidateQueries()`,
  // which means "refetch this, it's still relevant" — but the session was
  // just killed, so every actively-mounted query on this page (dashboard's
  // net-worth/cash-flow/budget/etc.) immediately refetched against a dead
  // session. `query-client.ts`'s global auth-error handler now hard-redirects
  // to /login the instant one of those refetches fails, which raced (and
  // beat) the `router.navigate({ to: "/" })` below. `clear()` matches what
  // this code actually intends ("drop cached tenant data") — it empties the
  // cache with no network calls, so there is nothing left to fail and
  // nothing for that handler to react to.
  const logoutMutation = useMutation({
    mutationFn: () => logout(),
    onSuccess: async () => {
      queryClient.clear()
      await router.invalidate()
      await router.navigate({ to: "/" })
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
          <SidebarMenuButton size="lg" disabled className="cursor-default">
            <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-24 rounded" />
              <Skeleton className="h-3 w-32 rounded" />
            </div>
          </SidebarMenuButton>
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
