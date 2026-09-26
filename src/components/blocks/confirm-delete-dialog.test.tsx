// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ConfirmDeleteDialog } from "./confirm-delete-dialog"

/**
 * F1 audit B2 — destructive actions get a real confirmation.
 *
 * Smart-Rule and Zakat-payer deletes fired on one click of a trash icon with
 * no confirmation at all; the transaction deletes used the browser's
 * `confirm()`. This dialog is what replaced both, so the contract worth pinning
 * is that confirming is what deletes, cancelling is what does not, and a
 * pending/failed delete stays on screen.
 */

// Radix Dialog measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver

afterEach(cleanup)

function renderDialog(
  overrides: Partial<Parameters<typeof ConfirmDeleteDialog>[0]> = {}
) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    title: "Delete the rule for “netflix”?",
    description: "Future imports stop matching this keyword.",
    onConfirm: vi.fn(),
    ...overrides,
  }
  render(<ConfirmDeleteDialog {...props} />)
  return props
}

describe("ConfirmDeleteDialog", () => {
  it("says what is about to be deleted", () => {
    renderDialog()

    expect(screen.getByText("Delete the rule for “netflix”?")).toBeTruthy()
    expect(screen.getByText(/stop matching this keyword/)).toBeTruthy()
  })

  it("deletes only on the confirm action", () => {
    const props = renderDialog()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it("cancelling closes without deleting", () => {
    const props = renderDialog()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows a delete in flight instead of closing", () => {
    renderDialog({ isPending: true })

    const action = screen.getByRole("button", { name: /Deleting/ })
    expect((action as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it("can relabel the action for a non-delete removal", () => {
    renderDialog({ confirmLabel: "Remove", pendingLabel: "Removing…" })

    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
  })

  it("keeps a failure visible inside the dialog", () => {
    renderDialog({ error: "Could not delete. Please try again." })

    expect(screen.getByText("Could not delete. Please try again.")).toBeTruthy()
  })
})
