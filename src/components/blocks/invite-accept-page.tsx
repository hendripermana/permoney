import { Link, useRouter } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MailCheck, MailX } from "lucide-react"

import { AuthShell } from "@/components/blocks/auth-shell"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { createUuidV7 } from "@/lib/uuid-v7"
import { logoutFn } from "@/server/auth-fns"
import {
  acceptFamilyInviteFn,
  getInviteByTokenFn,
} from "@/server/family-invites"

// ADR-0057 — public landing page for an emailed family-invite link. Resolves
// the token to one of: invalid/expired/revoked/used, "sign in or create your
// account" (signed out), "wrong account" (signed in as someone else), or the
// final "Accept invite" confirmation (signed in as the invited email).
//
// It deliberately never says whether the invited address already has an
// account: a signed-out visitor is offered BOTH paths.

const UNAVAILABLE_COPY = {
  not_found: "This invitation link is not valid.",
  expired:
    "This invitation has expired. Ask the family owner to send a new one.",
  revoked:
    "This invitation was cancelled. Ask the family owner to send a new one.",
  accepted: "This invitation has already been used.",
} as const

function InviteCard({
  title,
  description,
  icon,
  children,
  footer,
}: {
  title: string
  description: string
  icon: "ok" | "bad"
  children?: React.ReactNode
  footer?: React.ReactNode
}) {
  const Icon = icon === "ok" ? MailCheck : MailX
  return (
    <AuthShell>
      <Card className="mx-auto w-full max-w-md shadow-lg">
        <CardHeader className="items-center text-center">
          <Icon
            className={
              icon === "ok"
                ? "size-10 text-wise-green"
                : "size-10 text-muted-foreground"
            }
            aria-hidden
          />
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription className="text-balance">
            {description}
          </CardDescription>
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : null}
        {footer ? (
          <CardFooter className="flex-col gap-2">{footer}</CardFooter>
        ) : null}
      </Card>
    </AuthShell>
  )
}

export function InviteAcceptPage({ token }: { token: string | undefined }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const lookupInvite = useServerFn(getInviteByTokenFn)
  const acceptInvite = useServerFn(acceptFamilyInviteFn)
  const logout = useServerFn(logoutFn)

  const lookup = useQuery({
    queryKey: ["family-invite", token],
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => await lookupInvite({ data: { token: token ?? "" } }),
  })

  const accept = useMutation({
    mutationFn: async () =>
      await acceptInvite({
        data: { token: token ?? "", idempotencyKey: createUuidV7() },
      }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries(), router.invalidate()])
      await router.navigate({ to: "/dashboard" })
    },
  })

  const switchAccount = useMutation({
    mutationFn: async () => await logout(),
    onSuccess: async () => {
      queryClient.clear()
      await router.invalidate()
      await router.navigate({ to: "/login", search: { inviteToken: token } })
    },
  })

  if (!token) {
    return (
      <InviteCard
        icon="bad"
        title="Invitation not found"
        description={UNAVAILABLE_COPY.not_found}
        footer={
          <Button asChild variant="outline">
            <Link to="/login">Go to login</Link>
          </Button>
        }
      />
    )
  }

  if (lookup.isPending) {
    return (
      <InviteCard
        icon="ok"
        title="Checking your invitation…"
        description="One moment while we look up your invitation."
      />
    )
  }

  if (lookup.isError) {
    return (
      <InviteCard
        icon="bad"
        title="We couldn't check this invitation"
        description={
          lookup.error.message || "Something went wrong. Please try again."
        }
        footer={
          <Button variant="outline" onClick={() => void lookup.refetch()}>
            Try again
          </Button>
        }
      />
    )
  }

  const { invite, viewer } = lookup.data

  if (invite.status !== "valid") {
    return (
      <InviteCard
        icon="bad"
        title="This invitation can't be used"
        description={UNAVAILABLE_COPY[invite.status]}
        footer={
          <Button asChild variant="outline">
            <Link to="/login">Go to login</Link>
          </Button>
        }
      />
    )
  }

  // Signed out: offer both paths without revealing whether the invited
  // address already has an account.
  if (!viewer.authenticated) {
    return (
      <InviteCard
        icon="ok"
        title={`Join ${invite.familyName} on Permoney`}
        description={`${invite.inviterName} invited ${invite.email} to join as ${invite.role}.`}
        footer={
          <>
            <Button asChild variant="wise" className="w-full font-semibold">
              <Link to="/signup" search={{ inviteToken: token }}>
                Create your account
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login" search={{ inviteToken: token }}>
                I already have an account — log in as {invite.email}
              </Link>
            </Button>
          </>
        }
      />
    )
  }

  // Signed in as a different account than the one invited.
  if (!viewer.emailMatches) {
    return (
      <InviteCard
        icon="bad"
        title="Wrong account"
        description={`You're signed in as ${viewer.email}, but this invitation was sent to ${invite.email}. Sign out and log in with the invited address to accept it.`}
        footer={
          <Button
            variant="outline"
            disabled={switchAccount.isPending}
            onClick={() => switchAccount.mutate()}
          >
            {switchAccount.isPending
              ? "Signing out…"
              : `Sign out and log in as ${invite.email}`}
          </Button>
        }
      />
    )
  }

  if (viewer.familyConflict) {
    return (
      <InviteCard
        icon="bad"
        title="You're already in a family"
        description={`You already belong to another family, so you can't join ${invite.familyName} yet. Leave your current family first, then open this link again.`}
        footer={
          <Button asChild variant="outline">
            <Link to="/dashboard">Back to my dashboard</Link>
          </Button>
        }
      />
    )
  }

  return (
    <InviteCard
      icon="ok"
      title={`Accept invite to join ${invite.familyName}?`}
      description={`${invite.inviterName} invited you to join as ${invite.role}. You'll get access to this family's shared ledger.`}
      footer={
        <>
          <Button
            variant="wise"
            className="w-full font-semibold"
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? "Joining…" : "Accept invitation"}
          </Button>
          {accept.isError ? (
            <p role="alert" className="text-center text-sm text-destructive">
              {accept.error.message}
            </p>
          ) : null}
        </>
      }
    />
  )
}
