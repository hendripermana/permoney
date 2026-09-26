// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"
import { LoadErrorCard } from "./load-error-card"

/**
 * F1 audit B2 — a first-run household must not be handed developer advice.
 *
 * Both the dashboard and the budgets page used to render "If you just pulled
 * this branch, make sure the database migrations have run (vp run db:migrate)"
 * plus the raw `error.message` in a monospace block. The only actionable thing
 * — try again — was buried underneath, and none of the rest is something a
 * household can act on.
 */
afterEach(cleanup)

describe("LoadErrorCard", () => {
  it("names what failed, in plain language", () => {
    render(
      <LoadErrorCard
        label="this budget"
        isRetrying={false}
        onRetry={() => {}}
      />
    )

    expect(screen.getByText("Couldn't load this budget")).toBeTruthy()
    expect(screen.getByText(/Nothing was changed/i)).toBeTruthy()
  })

  it("never tells the household to run a developer command", () => {
    render(
      <LoadErrorCard
        label="your dashboard"
        isRetrying={false}
        onRetry={() => {}}
      />
    )

    const text = document.body.textContent ?? ""
    expect(text).not.toContain("db:migrate")
    expect(text).not.toContain("migrations")
    expect(text).not.toContain("branch")
    expect(text).not.toContain("vp run")
  })

  it("keeps each surface's own label, so the state still says WHAT failed", () => {
    // The component replaced two near-identical local cards; each caller keeps
    // its own wording ("this budget" / "your dashboard" / ...).
    const { rerender } = render(
      <LoadErrorCard
        label="this budget"
        isRetrying={false}
        onRetry={() => {}}
      />
    )
    expect(screen.getByText("Couldn't load this budget")).toBeTruthy()

    rerender(
      <LoadErrorCard
        label="your dashboard"
        isRetrying={false}
        onRetry={() => {}}
      />
    )
    expect(screen.getByText("Couldn't load your dashboard")).toBeTruthy()
  })

  it("offers the one useful action, and shows it is working", () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <LoadErrorCard label="this budget" isRetrying={false} onRetry={onRetry} />
    )

    const button = screen.getByRole("button", { name: /Try again/i })
    button.click()
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<LoadErrorCard label="this budget" isRetrying onRetry={onRetry} />)
    const retrying = screen.getByRole("button", { name: /Retrying/i })
    expect((retrying as HTMLButtonElement).disabled).toBe(true)
  })
})
