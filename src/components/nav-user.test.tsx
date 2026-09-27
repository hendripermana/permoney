// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import { SidebarIdentitySkeleton } from "./nav-user"
import { SidebarProvider } from "@/components/ui/sidebar"

// jsdom has no matchMedia; the sidebar's provider reads it to pick the
// mobile/desktop behaviour.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
})

afterEach(cleanup)

describe("SidebarIdentitySkeleton", () => {
  // Regression for the axe `button-name` violation TesterArmy reported on
  // /dashboard: `<button class="…h-14…">` with no discernible text. The loading
  // placeholder must not be an interactive control at all.
  it("is decorative: no button role and hidden from assistive tech", () => {
    render(
      <SidebarProvider>
        <SidebarIdentitySkeleton />
      </SidebarProvider>
    )

    expect(screen.queryByRole("button")).toBeNull()
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
