export type AuthRouteRedirect = "/login" | "/onboarding" | "/dashboard"

export interface SessionGuardState {
  authenticated: boolean
  hasFamilyId: boolean
}

export function hasFamilyIdValue(familyId: unknown): familyId is string {
  return typeof familyId === "string" && familyId.trim().length > 0
}

export function getProtectedRouteRedirect(
  guard: SessionGuardState
): AuthRouteRedirect | null {
  if (!guard.authenticated) return "/login"
  if (!guard.hasFamilyId) return "/onboarding"
  return null
}

export function getOnboardingRouteRedirect(
  guard: SessionGuardState
): AuthRouteRedirect | null {
  if (!guard.authenticated) return "/login"
  if (guard.hasFamilyId) return "/dashboard"
  return null
}

export function getPublicAuthRouteRedirect(
  guard: SessionGuardState
): AuthRouteRedirect | null {
  if (!guard.authenticated) return null
  return guard.hasFamilyId ? "/dashboard" : "/onboarding"
}

export function getPostAuthRedirectPath(
  familyId: string | null | undefined
): "/onboarding" | "/dashboard" {
  return hasFamilyIdValue(familyId) ? "/dashboard" : "/onboarding"
}
