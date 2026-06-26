import { createFileRoute, redirect } from "@tanstack/react-router"
import { LandingPage } from "@/components/blocks/landing-page"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getPublicAuthRouteRedirect } from "@/server/onboarding-contract"

export const Route = createFileRoute("/")({
  // PER-166: the front door. Auth-aware via the shared session guard — authed
  // users are forwarded to /dashboard (or /onboarding if not yet onboarded);
  // guests fall through to the branded landing. Mirrors the login/signup
  // beforeLoad contract so the redirect decision lives server-side, never in an
  // isomorphic loader that could touch the DB on the client.
  //
  // PER-107: keep the public shell in the critical route module and render it
  // for both pending and resolved states so a route Suspense fallback never
  // becomes the hydratable server tree.
  codeSplitGroupings: [],
  pendingComponent: LandingPage,
  beforeLoad: async () => {
    const guard = await getSessionGuardFn()
    const redirectTo = getPublicAuthRouteRedirect(guard)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  component: LandingPage,
})
