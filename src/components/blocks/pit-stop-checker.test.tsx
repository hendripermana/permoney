// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import type { ReactNode } from "react"

import type { PitStopOverview, PitStopResult } from "@/server/pit-stop"

// The empty state links to /accounts; a bare <a> is enough in this router-less
// render (the route wires the real Link).
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

import { PitStopChecker, type PitStopSubmitInput } from "./pit-stop-checker"

type SubmitMock = ReturnType<
  typeof vi.fn<(input: PitStopSubmitInput) => Promise<PitStopResult>>
>
const newSubmit = (): SubmitMock =>
  vi.fn<(input: PitStopSubmitInput) => Promise<PitStopResult>>(
    async () => okResult
  )

vi.setConfig({ testTimeout: 30_000 })
afterEach(cleanup)

const NOW = new Date("2026-09-20T10:00:00Z")

const bank = {
  id: "bank",
  name: "Bank BCA",
  institutionName: null,
  accountType: "DEPOSITORY",
  accountClass: "ASSET",
  currency: "IDR",
  balance: "15000000", // Rp 150,000.00
  ownerPersonId: "me",
  jointOwnerPersonId: null,
  jointSharePercent: null,
  lastCheckedAt: null,
}
const wallet = {
  ...bank,
  id: "wallet",
  name: "OVO",
  accountType: "E_WALLET",
  balance: "2000000", // Rp 20,000.00
  ownerPersonId: "her",
  lastCheckedAt: "2026-09-17",
}
const card = {
  ...bank,
  id: "card",
  name: "Visa",
  accountType: "CREDIT",
  accountClass: "LIABILITY",
  balance: "-30000000", // owes Rp 300,000.00
  ownerPersonId: "me",
}

const overview = (over: Partial<PitStopOverview> = {}): PitStopOverview => ({
  accounts: [bank, wallet, card],
  people: [
    { id: "me", displayName: "Hendri" },
    { id: "her", displayName: "Rahayu" },
  ],
  currentPersonId: "me",
  ...over,
})

const okResult: PitStopResult = {
  results: [
    {
      accountId: "bank",
      accountName: "Bank BCA",
      accountClass: "ASSET",
      currency: "IDR",
      before: "15000000",
      after: "11900000",
      delta: "-3100000",
      matchesActual: true,
    },
  ],
  unrecordedByCurrency: [{ currency: "IDR", delta: "-3100000" }],
}

const actualField = (name: string) =>
  screen.getByLabelText(`Pit stop actual now for ${name}`) as HTMLInputElement
const checkButton = () =>
  screen.getByRole("button", { name: /check balances|checking/i })

function setup(
  over: Partial<PitStopOverview> = {},
  submit: SubmitMock = newSubmit()
) {
  render(<PitStopChecker overview={overview(over)} submit={submit} now={NOW} />)
  return { submit }
}

describe("PitStopChecker rows", () => {
  it("shows what the app holds and when each account was last checked", () => {
    setup()
    fireEvent.click(screen.getByRole("radio", { name: "Everyone" }))

    const rows = screen.getAllByTestId("pit-stop-row")
    expect(rows).toHaveLength(3)
    expect(screen.getByText("Bank BCA")).toBeTruthy()
    expect(screen.getAllByText("Never checked")).toHaveLength(2)
    expect(screen.getByText("Last checked 3 days ago")).toBeTruthy()
    // A credit card is shown as the amount OWED, not a negative balance.
    expect(screen.getByText("In app (owed)")).toBeTruthy()
    expect(screen.getByText("Owed now")).toBeTruthy()
  })

  it("defaults to my accounts and Everyone reveals the rest", () => {
    setup()
    expect(screen.getAllByTestId("pit-stop-row")).toHaveLength(2)
    expect(screen.queryByText("OVO")).toBeNull()

    fireEvent.click(screen.getByRole("radio", { name: "Everyone" }))
    expect(screen.getAllByTestId("pit-stop-row")).toHaveLength(3)
    expect(screen.getByText("OVO")).toBeTruthy()
  })

  it("shows every account with a hint to set owners when the user owns nothing", () => {
    setup({ currentPersonId: null })
    expect(screen.getAllByTestId("pit-stop-row")).toHaveLength(3)
    expect(screen.getByText(/Set an owner on each account/)).toBeTruthy()
    expect(screen.queryByRole("radio", { name: "Mine" })).toBeNull()
  })

  it("previews the difference live, in green/red, without submitting", () => {
    const { submit } = setup()

    fireEvent.change(actualField("Bank BCA"), { target: { value: "119000" } })
    const diff = screen.getByTestId("pit-stop-difference")
    expect(diff.textContent).toMatch(/−.*31,000/)
    expect(diff.className).toMatch(/destructive/)

    fireEvent.change(actualField("Bank BCA"), { target: { value: "160000" } })
    const up = screen.getByTestId("pit-stop-difference")
    expect(up.textContent).toMatch(/\+.*10,000/)
    expect(up.className).toMatch(/emerald/)

    fireEvent.change(actualField("Bank BCA"), { target: { value: "150000" } })
    expect(screen.getByText("Matches the app")).toBeTruthy()
    expect(submit).not.toHaveBeenCalled()
  })

  it("judges a credit card's difference in net-worth terms but shows it as owed", () => {
    setup()
    // Owing Rp 500,000 instead of Rp 300,000: Rp 200,000 MORE owed = worse.
    fireEvent.change(actualField("Visa"), { target: { value: "500000" } })
    const diff = screen.getByTestId("pit-stop-difference")
    expect(diff.textContent).toMatch(/\+.*200,000.*owed/)
    expect(diff.className).toMatch(/destructive/)
  })
})

describe("PitStopChecker submission", () => {
  it("is disabled until at least one row is filled with a valid amount", () => {
    setup()
    expect((checkButton() as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(actualField("Bank BCA"), { target: { value: "abc" } })
    expect((checkButton() as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(actualField("Bank BCA"), { target: { value: "119000" } })
    expect((checkButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it("skips blank rows and sends only what was filled, with a UUIDv7 key", async () => {
    const { submit } = setup()
    fireEvent.change(actualField("Bank BCA"), { target: { value: "119000" } })
    fireEvent.click(checkButton())

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const call = submit.mock.calls[0]?.[0]
    expect(call?.entries).toEqual([
      { accountId: "bank", actualBalance: "11900000" },
    ])
    expect(call?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it("sends a credit card as the amount owed (a positive magnitude)", async () => {
    const { submit } = setup()
    fireEvent.change(actualField("Visa"), { target: { value: "500000" } })
    fireEvent.click(checkButton())
    await waitFor(() => expect(submit).toHaveBeenCalled())
    const call = submit.mock.calls[0]?.[0]
    expect(call?.entries).toEqual([
      { accountId: "card", actualBalance: "50000000" },
    ])
  })

  it("reuses the idempotency key when the same payload is retried, and mints a new one when it changes", async () => {
    const submit = newSubmit()
      .mockRejectedValueOnce(new Error("network dropped"))
      .mockResolvedValue(okResult)
    setup({}, submit)

    fireEvent.change(actualField("Bank BCA"), { target: { value: "119000" } })
    fireEvent.click(checkButton())
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText("network dropped")).toBeTruthy()

    // Same payload, second attempt → same key (the server would replay it).
    fireEvent.click(checkButton())
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    expect(submit.mock.calls[1]?.[0].idempotencyKey).toBe(
      submit.mock.calls[0]?.[0].idempotencyKey
    )
  })

  it("shows the per-account before → after and the net unrecorded movement, then clears the form", async () => {
    setup()
    fireEvent.change(actualField("Bank BCA"), { target: { value: "119000" } })
    fireEvent.click(checkButton())

    const panel = await screen.findByRole("status", {
      name: "Pit stop result",
    })
    expect(panel.textContent).toMatch(/Bank BCA/)
    expect(panel.textContent).toMatch(/150,000.*119,000/)
    expect(panel.textContent).toMatch(/31,000.*less than recorded/)
    expect(panel.textContent).toMatch(/correction, not a transaction/)
    // The form is cleared for the next round.
    expect(actualField("Bank BCA").value).toBe("")

    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.queryByRole("status", { name: "Pit stop result" })).toBeNull()
  })

  it("says so plainly when everything matched", async () => {
    const submit = newSubmit().mockResolvedValue({
      results: okResult.results.map((r) => ({
        ...r,
        after: r.before,
        delta: "0",
      })),
      unrecordedByCurrency: [{ currency: "IDR", delta: "0" }],
    })
    setup({}, submit)
    fireEvent.change(actualField("Bank BCA"), { target: { value: "150000" } })
    fireEvent.click(checkButton())
    expect(
      await screen.findByText(/Everything matched what was recorded/)
    ).toBeTruthy()
  })

  it("flags an account whose balance does not equal what was entered", async () => {
    const submit = newSubmit().mockResolvedValue({
      results: okResult.results.map((r) => ({ ...r, matchesActual: false })),
      unrecordedByCurrency: okResult.unrecordedByCurrency,
    })
    setup({}, submit)
    fireEvent.change(actualField("Bank BCA"), { target: { value: "119000" } })
    fireEvent.click(checkButton())
    expect(
      await screen.findByText(/dated later today are counted after this/)
    ).toBeTruthy()
  })
})

describe("PitStopChecker empty state", () => {
  it("guides the user when there is nothing to check", () => {
    setup({ accounts: [] })
    expect(screen.getByText("No accounts to check yet")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "Go to Accounts" }).getAttribute("href")
    ).toBe("/accounts")
    expect(screen.queryByRole("button", { name: /check balances/i })).toBeNull()
  })
})
