// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { BootUnreachableError } from "@/lib/boot-guard"
import { BootUnreachablePanel } from "./boot-unreachable-panel"

/**
 * F1 audit B5 — the state that replaces the blank page.
 *
 * The incident's other half was that there was nothing to look at and nothing
 * to press, so these tests pin the two states the panel must distinguish
 * (offline versus server-unreachable), the Reload action, the automatic
 * recovery when the network returns, and the fact that no transport detail
 * ever reaches the screen.
 */

afterEach(cleanup)

describe("BootUnreachablePanel", () => {
  it("explains a server that did not answer, and reloads on demand", () => {
    const onReload = vi.fn()
    render(
      <BootUnreachablePanel
        error={new BootUnreachableError("timeout", 3)}
        onReload={onReload}
      />
    )

    expect(screen.getByText("Can't reach Permoney")).toBeTruthy()
    expect(screen.getByText(/server didn't answer/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /Reload/i }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it("says the device is offline, not that the server is broken", () => {
    render(
      <BootUnreachablePanel
        error={new BootUnreachableError("offline", 1)}
        onReload={vi.fn()}
      />
    )

    expect(screen.getByText("You're offline")).toBeTruthy()
    expect(screen.queryByText("Can't reach Permoney")).toBeNull()
    // Reloading by hand is pointless while the network is down, so the copy
    // promises the automatic recovery instead of asking for a click.
    expect(screen.getByText(/reload by itself/i)).toBeTruthy()
  })

  it("recovers by itself when the connection comes back", () => {
    const onReload = vi.fn()
    render(
      <BootUnreachablePanel
        error={new BootUnreachableError("offline", 1)}
        onReload={onReload}
      />
    )

    window.dispatchEvent(new Event("online"))

    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it("does not listen for connectivity when the server was the problem", () => {
    const onReload = vi.fn()
    render(
      <BootUnreachablePanel
        error={new BootUnreachableError("unreachable", 3)}
        onReload={onReload}
      />
    )

    window.dispatchEvent(new Event("online"))

    expect(onReload).not.toHaveBeenCalled()
  })

  it("stops listening once it unmounts", () => {
    const onReload = vi.fn()
    const { unmount } = render(
      <BootUnreachablePanel
        error={new BootUnreachableError("offline", 1)}
        onReload={onReload}
      />
    )

    unmount()
    window.dispatchEvent(new Event("online"))

    expect(onReload).not.toHaveBeenCalled()
  })

  it("shows no raw error detail — not the message, not a connection string", () => {
    const leaks = new BootUnreachableError("unreachable", 3)
    leaks.cause = new Error(
      "postgres://permoney:secret@10.0.0.4/permoney — connection refused"
    )

    render(<BootUnreachablePanel error={leaks} onReload={vi.fn()} />)

    const text = document.body.textContent ?? ""
    expect(text).not.toContain("secret")
    expect(text).not.toContain("10.0.0.4")
    expect(text).not.toContain("postgres")
    expect(text).not.toContain("connection refused")
  })

  it("still renders a usable state for an unrelated error object", () => {
    const onReload = vi.fn()
    render(
      <BootUnreachablePanel error={new Error("boom")} onReload={onReload} />
    )

    // Falls back to the reachability copy rather than to a blank screen.
    expect(screen.getByText("Can't reach Permoney")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Reload/i }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
