import { describe, expect, it } from "vite-plus/test"
import {
  getOnboardingRouteRedirect,
  getPostAuthRedirectPath,
  getPublicAuthRouteRedirect,
  getProtectedRouteRedirect,
} from "./onboarding-contract"

describe("onboarding route contract", () => {
  it("routes anonymous users to login before protected app pages", () => {
    expect(
      getProtectedRouteRedirect({
        authenticated: false,
        hasFamilyId: false,
      })
    ).toBe("/login")
  })

  it("routes authenticated users without family to onboarding before app pages", () => {
    expect(
      getProtectedRouteRedirect({
        authenticated: true,
        hasFamilyId: false,
      })
    ).toBe("/onboarding")
  })

  it("allows authenticated onboarded users to enter protected app pages", () => {
    expect(
      getProtectedRouteRedirect({
        authenticated: true,
        hasFamilyId: true,
      })
    ).toBeNull()
  })

  it("keeps onboarding exclusive to authenticated users without family", () => {
    expect(
      getOnboardingRouteRedirect({
        authenticated: false,
        hasFamilyId: false,
      })
    ).toBe("/login")
    expect(
      getOnboardingRouteRedirect({
        authenticated: true,
        hasFamilyId: false,
      })
    ).toBeNull()
    expect(
      getOnboardingRouteRedirect({
        authenticated: true,
        hasFamilyId: true,
      })
    ).toBe("/dashboard")
  })

  it("sends newly authenticated users to the only valid next step", () => {
    expect(getPostAuthRedirectPath(null)).toBe("/onboarding")
    expect(getPostAuthRedirectPath(undefined)).toBe("/onboarding")
    expect(getPostAuthRedirectPath("family-1")).toBe("/dashboard")
  })

  it("redirects authenticated users away from public auth pages", () => {
    expect(
      getPublicAuthRouteRedirect({
        authenticated: false,
        hasFamilyId: false,
      })
    ).toBeNull()
    expect(
      getPublicAuthRouteRedirect({
        authenticated: true,
        hasFamilyId: false,
      })
    ).toBe("/onboarding")
    expect(
      getPublicAuthRouteRedirect({
        authenticated: true,
        hasFamilyId: true,
      })
    ).toBe("/dashboard")
  })
})
