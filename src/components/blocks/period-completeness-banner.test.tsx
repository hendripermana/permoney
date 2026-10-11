// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { RouterLinkMock } from "@/test-support/blocks"

// A router-less stand-in for <Link>: the banner only needs the destination.
vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkMock,
}))

// The banner talks to the server only through this fn; mock it so no server
// code (Prisma, secrets) enters the jsdom test graph.
const { getPeriodCompletenessFn } = vi.hoisted(() => ({
  getPeriodCompletenessFn: vi.fn(),
}))
vi.mock("@/server/valuations", () => ({ getPeriodCompletenessFn }))

import { PeriodCompletenessBanner } from "./period-completeness-banner"
import type { PeriodCompleteness } from "@/server/valuations"

afterEach(() => {
  cleanup()
  getPeriodCompletenessFn.mockReset()
})

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <PeriodCompletenessBanner />
    </QueryClientProvider>
  )
}

const clean: PeriodCompleteness = {
  window: { from: "2026-04-01", to: "2026-10-11" },
  gaps: [],
}

const oneGap: PeriodCompleteness = {
  window: { from: "2026-04-01", to: "2026-10-11" },
  gaps: [
    {
      accountId: "acc-1",
      accountName: "Bank Jago",
      currency: "IDR",
      fromDate: "2026-07-04",
      toDate: "2026-09-28",
      amount: "6762000",
    },
  ],
}

describe("PeriodCompletenessBanner", () => {
  it("renders nothing for a fully recorded window", async () => {
    getPeriodCompletenessFn.mockResolvedValue(clean)
    renderBanner()
    await waitFor(() =>
      expect(getPeriodCompletenessFn).toHaveBeenCalledTimes(1)
    )
    expect(screen.queryByTestId("period-completeness-banner")).toBeNull()
  })

  it("names the account, the window and the unrecorded amount", async () => {
    getPeriodCompletenessFn.mockResolvedValue(oneGap)
    renderBanner()

    await waitFor(() =>
      expect(screen.getByTestId("period-completeness-banner")).toBeTruthy()
    )
    expect(screen.getByText(/partially recorded period/i)).toBeTruthy()
    expect(
      screen.getByText(/activity between 2026-07-04 and 2026-09-28 was never/i)
    ).toBeTruthy()
    // IDR 6,762,000 minor units = Rp 67,620 — tolerate locale grouping.
    expect(
      screen.getByTestId("period-completeness-banner").textContent
    ).toMatch(/67[.,]620/)
    // The account is the entry point to close the gap.
    const link = screen.getByRole("link", { name: "Bank Jago" })
    expect(link.getAttribute("href")).toBe("/accounts/acc-1")
  })

  it("caps the list at two accounts and counts the rest", async () => {
    getPeriodCompletenessFn.mockResolvedValue({
      window: clean.window,
      gaps: [
        oneGap.gaps[0],
        { ...oneGap.gaps[0], accountId: "acc-2", accountName: "BCA" },
        { ...oneGap.gaps[0], accountId: "acc-3", accountName: "OVO" },
      ],
    } satisfies PeriodCompleteness)
    renderBanner()

    await waitFor(() =>
      expect(screen.getByTestId("period-completeness-banner")).toBeTruthy()
    )
    expect(screen.getByRole("link", { name: "Bank Jago" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "BCA" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "OVO" })).toBeNull()
    expect(screen.getByText(/and 1 more account/i)).toBeTruthy()
  })
})
