// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * F1 audit B2 — the base reporting currency is a one-way door, so it must not
 * be decided by an unexamined default.
 *
 * Before: the page defaulted to USD (in an IDR-first product) and the submit
 * button was live immediately. The household could create a family whose
 * reports would be measured in a currency they never chose, with no undo.
 */

// Hoisted so the `vi.mock` factories below (which run before any top-level
// const) can close over the same spies. The factories must reach them as
// PROPERTIES of the hoisted object — a destructured local is not initialized
// yet when a hoisted factory runs.
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
  onboardFn: vi.fn(
    async (_input: { data: { currency: string; idempotencyKey: string } }) => ({
      familyId: "family-1",
    })
  ),
}))

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: mocks.navigate, invalidate: mocks.invalidate }),
}))

// The page wraps `onboardFn` with `useServerFn`; returning the fn itself keeps
// the call path (`submitOnboarding({ data })`) intact in jsdom.
vi.mock("@/server/auth-fns", () => ({ onboardFn: mocks.onboardFn }))
vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}))

import { OnboardingPage } from "./onboarding-page"

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver

beforeEach(() => {
  mocks.onboardFn.mockClear()
  mocks.navigate.mockClear()
  mocks.invalidate.mockClear()
})

afterEach(cleanup)

function currencySelect() {
  return screen.getByLabelText("Base reporting currency") as HTMLSelectElement
}

function confirmCheckbox() {
  return screen.getByLabelText(/reports will always be in/i)
}

function submitButton() {
  return screen.getByRole("button", {
    name: /Get Started/,
  }) as HTMLButtonElement
}

describe("onboarding — base currency", () => {
  it("defaults to IDR, not USD", () => {
    render(<OnboardingPage />)

    expect(currencySelect().value).toBe("IDR")
    expect(screen.getByText(/reports will always be in IDR/i)).toBeTruthy()
  })

  it("will not let the household continue until the currency is confirmed", () => {
    render(<OnboardingPage />)

    expect(submitButton().disabled).toBe(true)

    fireEvent.click(confirmCheckbox())

    expect(submitButton().disabled).toBe(false)
  })

  it("invalidates the confirmation when the currency changes", () => {
    render(<OnboardingPage />)
    fireEvent.click(confirmCheckbox())
    expect(submitButton().disabled).toBe(false)

    fireEvent.change(currencySelect(), { target: { value: "USD" } })

    // A confirmation for IDR says nothing about USD.
    expect(submitButton().disabled).toBe(true)
    expect(screen.getByText(/reports will always be in USD/i)).toBeTruthy()
  })

  it("sends the confirmed currency to the server", async () => {
    render(<OnboardingPage />)
    fireEvent.change(currencySelect(), { target: { value: "USD" } })
    fireEvent.click(confirmCheckbox())

    fireEvent.click(submitButton())

    await waitFor(() => expect(mocks.onboardFn).toHaveBeenCalledTimes(1))
    const call = mocks.onboardFn.mock.calls[0]?.[0]
    expect(call?.data.currency).toBe("USD")
    expect(call?.data.idempotencyKey).toBeTruthy()
  })
})
