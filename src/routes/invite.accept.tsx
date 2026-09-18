import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { InviteAcceptPage } from "@/components/blocks/invite-accept-page"

// ADR-0057 — public route (outside `_protected`, like /login and /signup): the
// invitee may have no session and no family yet, so no auth guard runs here.
// Signed-in state is resolved by `getInviteByTokenFn` itself.
const inviteAcceptSearchSchema = z.object({
  token: z.string().max(256).optional(),
})
type InviteAcceptSearch = z.infer<typeof inviteAcceptSearchSchema>

export const Route = createFileRoute("/invite/accept")({
  validateSearch: (search: Record<string, unknown>): InviteAcceptSearch => {
    const parsed = inviteAcceptSearchSchema.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  // The raw invite token lives in this page's URL. `no-referrer` guarantees it
  // is never sent as a Referer header to any third-party resource this page (or
  // a link on it) loads or navigates to.
  head: () => ({
    meta: [{ name: "referrer", content: "no-referrer" }],
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { token } = Route.useSearch()
  return <InviteAcceptPage token={token} />
}
