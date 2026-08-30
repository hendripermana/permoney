import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Crown, UserPlus, Users } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  addMemberFn,
  getMembersFn,
  removeMemberFn,
  transferOwnershipFn,
  updateMemberRoleFn,
} from "@/server/family-members"
import { getSettingsOverviewFn, SETTINGS_OVERVIEW_KEY } from "@/server/settings"

const MEMBERS_KEY = ["family-members"] as const

type Member = Awaited<ReturnType<typeof getMembersFn>>[number]

// Owner is intentionally absent from the assignable list — ownership moves only
// through the dedicated transfer flow (ADR-0036), never a casual role change.
const ASSIGNABLE_ROLES = ["admin", "member", "viewer"] as const
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  admin: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  member: "bg-muted text-foreground",
  viewer: "bg-muted text-muted-foreground",
}

export const Route = createFileRoute("/_protected/settings/members")({
  ssr: false,
  staticData: { title: "Family members" },
  component: MembersPage,
})

function MembersPage() {
  const { data: members, isLoading } = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: async () => await getMembersFn(),
  })
  // Reuse the same cache entry every other settings consumer reads (see
  // getSettingsOverviewFn's own doc comment) rather than adding a new
  // "who am I" server fn — match the caller's own row in the member list by
  // email to find their role and userId (self-transfer is blocked server-side
  // regardless, but the UI needs this to know whether to show the action and
  // whom to exclude from the "new owner" list).
  const { data: overview } = useQuery({
    queryKey: SETTINGS_OVERVIEW_KEY,
    queryFn: async () => await getSettingsOverviewFn(),
  })
  const currentMember = (members ?? []).find(
    (member) => member.email === overview?.profile.email
  )
  const isCurrentUserOwner = currentMember?.role === "owner"

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
              <Users className="size-6 text-sky-500" aria-hidden />
              <div>
                <h1 className="text-xl font-semibold">Family members</h1>
                <p className="text-sm text-muted-foreground">
                  Invite people to your family and control what they can do.
                  Roles gate every money and settings action on the server.
                </p>
              </div>
            </div>

            <AddMemberCard />

            <MembersTableCard members={members ?? []} isLoading={isLoading} />

            {isCurrentUserOwner && currentMember ? (
              <TransferOwnershipCard
                members={members ?? []}
                currentUserId={currentMember.userId}
              />
            ) : null}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function AddMemberCard() {
  const queryClient = useQueryClient()
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<AssignableRole>("member")

  const mutation = useMutation({
    mutationFn: async () =>
      await addMemberFn({
        data: {
          email: email.trim().toLowerCase(),
          role,
          idempotencyKey: createUuidV7(),
        },
      }),
    onSuccess: () => {
      setEmail("")
      setRole("member")
      void queryClient.invalidateQueries({ queryKey: MEMBERS_KEY })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a member</CardTitle>
        <CardDescription>
          Enter the email of an existing Permoney account. They are added with
          the role you choose.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              type="email"
              placeholder="person@example.com"
              value={email}
              className="w-72"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="member-role">Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as AssignableRole)}
            >
              <SelectTrigger id="member-role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            disabled={mutation.isPending || email.trim() === ""}
          >
            <UserPlus className="size-4" aria-hidden />
            {mutation.isPending ? "Adding…" : "Add member"}
          </Button>
          {mutation.isError ? (
            <p className="w-full text-sm text-destructive">
              {(mutation.error as Error).message}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

function MembersTableCard({
  members,
  isLoading,
}: {
  members: Member[]
  isLoading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          The owner can manage everyone; admins can manage members and viewers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <MemberRow key={member.id} member={member} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function MemberRow({ member }: { member: Member }) {
  const queryClient = useQueryClient()
  const isOwner = member.role === "owner"

  const changeRole = useMutation({
    mutationFn: async (role: AssignableRole) =>
      await updateMemberRoleFn({
        data: { userId: member.userId, role, idempotencyKey: createUuidV7() },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMBERS_KEY }),
  })

  const remove = useMutation({
    mutationFn: async () =>
      await removeMemberFn({
        data: { userId: member.userId, idempotencyKey: createUuidV7() },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMBERS_KEY }),
  })

  const busy = changeRole.isPending || remove.isPending
  const error = changeRole.error ?? remove.error

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{member.name}</span>
          <span className="text-sm text-muted-foreground">{member.email}</span>
        </div>
        {error ? (
          <p className="mt-1 text-sm text-destructive">
            {(error as Error).message}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        {isOwner ? (
          <Badge className={ROLE_BADGE.owner}>owner</Badge>
        ) : (
          <Select
            value={member.role}
            disabled={busy}
            onValueChange={(value) =>
              changeRole.mutate(value as AssignableRole)
            }
          >
            <SelectTrigger className="w-32" aria-label="Change role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE_ROLES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busy || isOwner}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
      </TableCell>
    </TableRow>
  )
}

// PER-271 — dedicated ownership hand-off flow (ADR-0036 §6). Ownership is
// deliberately excluded from the ordinary role Select above; it moves ONLY
// through transferOwnershipFn, which the server gates on the
// `ownership:transfer` capability (owner-only) and re-checks the caller's
// role again inside the tenant transaction. Hiding this card for non-owners
// is a UX nicety, not the security boundary — the server enforces it
// independently, so a non-owner hitting the endpoint directly still gets
// rejected.
function TransferOwnershipCard({
  members,
  currentUserId,
}: {
  members: Member[]
  currentUserId: string
}) {
  const queryClient = useQueryClient()
  const candidates = members.filter(
    (member) => member.userId !== currentUserId && member.status === "active"
  )
  const [selectedUserId, setSelectedUserId] = React.useState("")
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const resolvedUserId = candidates.some((c) => c.userId === selectedUserId)
    ? selectedUserId
    : (candidates[0]?.userId ?? "")
  const selectedMember = candidates.find((c) => c.userId === resolvedUserId)

  const mutation = useMutation({
    mutationFn: async () =>
      await transferOwnershipFn({
        data: { userId: resolvedUserId, idempotencyKey: createUuidV7() },
      }),
    onSuccess: () => {
      setDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: MEMBERS_KEY })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Crown className="size-4 text-amber-500" aria-hidden />
          Transfer ownership
        </CardTitle>
        <CardDescription>
          Hand primary ownership of this family to another member. You will
          become an admin — you keep full access to money and settings, but you
          lose the ability to manage owners or transfer ownership again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There&apos;s no one else to hand ownership to yet — add another
            member first.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="transfer-target">New owner</Label>
              <Select value={resolvedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger id="transfer-target" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.userId} value={candidate.userId}>
                      {candidate.name} ({candidate.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending || !selectedMember}
              onClick={() => setDialogOpen(true)}
            >
              <Crown className="size-4" aria-hidden />
              Transfer ownership
            </Button>
            {mutation.isError ? (
              <p className="w-full text-sm text-destructive">
                {(mutation.error as Error).message}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Transfer ownership to {selectedMember?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedMember?.name} ({selectedMember?.email}) will become the
              owner of this family, with full control over money movement,
              settings, and membership. You will be moved to admin — you keep
              access to the ledger and settings, but you will no longer be able
              to manage owners, remove the new owner, or transfer ownership
              yourself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog controlled: run the mutation ourselves and
                // only close on success, so a rejection (e.g. a concurrent
                // change) leaves the dialog open with the error visible.
                event.preventDefault()
                mutation.mutate()
              }}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Transferring…" : "Transfer ownership"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
