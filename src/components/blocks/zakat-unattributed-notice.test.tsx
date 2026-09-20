// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

// A router-less stand-in for <Link>: the notice only needs the destination.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string
    params?: Record<string, string>
    children?: ReactNode
    className?: string
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to
      )}
      className={className}
    >
      {children}
    </a>
  ),
}))

import { UnattributedAccountsNotice } from "./zakat-unattributed-notice"

afterEach(cleanup)

describe("UnattributedAccountsNotice (ADR-0058 Zakat interaction)", () => {
  it("names every account that is left out and links to it", () => {
    render(
      <UnattributedAccountsNotice
        accounts={[
          { id: "a1", name: "BCA Checking" },
          { id: "a2", name: "OVO" },
        ]}
      />
    )
    expect(
      screen.getByText("2 accounts have no owner and are not counted")
    ).toBeTruthy()
    expect(
      screen.getByText("BCA Checking").closest("a")?.getAttribute("href")
    ).toBe("/accounts/a1")
    expect(screen.getByText("OVO").closest("a")?.getAttribute("href")).toBe(
      "/accounts/a2"
    )
    expect(
      screen.getByRole("link", { name: "Go to accounts" }).getAttribute("href")
    ).toBe("/accounts")
  })

  it("uses the singular form for one account", () => {
    render(
      <UnattributedAccountsNotice accounts={[{ id: "a1", name: "Cash" }]} />
    )
    expect(
      screen.getByText("1 account has no owner and is not counted")
    ).toBeTruthy()
  })
})
