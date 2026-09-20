// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { HoldingRecord } from "@/routes/_protected/-account-holdings"

// The dialog talks to the server only through these fns; mock the whole module
// so no server code (Prisma, secrets) is pulled into the jsdom test graph.
const { upsertHoldingFn } = vi.hoisted(() => ({
  upsertHoldingFn: vi.fn(async (_args: unknown) => undefined),
}))
vi.mock("@/server/holdings", () => ({
  upsertHoldingFn,
  ensureReksadanaInstrumentFn: vi.fn(),
  listMarketInstrumentsFn: vi.fn(async () => []),
}))

// Owner select data (ADR-0058 D2). A one-member family → no candidates → the
// select stays hidden, which is what the quantity tests below rely on.
const { listOwnerCandidatesFn } = vi.hoisted(() => ({
  listOwnerCandidatesFn: vi.fn(async () => ({
    activeMemberCount: 1,
    peopleCount: 0,
    candidates: [] as unknown[],
  })),
}))
vi.mock("@/server/ownership", () => ({ listOwnerCandidatesFn }))

import { HoldingFormDialog } from "./holding-form-dialog"

// The bug (verified on production data): an Indonesian user typed the Bibit
// unit count `1.354` (dot = thousands) into Quantity and the strict dot-decimal
// parser silently stored 1.354 units instead of 1,354 — a 1000x error. The
// quantity field now has to (a) never guess an ambiguous reading, (b) block
// Save until the user picks one, and (c) leave already-canonical input alone.

// Full-dialog render (Radix Dialog + Select + date field) on a cold jsdom is
// slow enough to brush the 5s default when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  upsertHoldingFn.mockClear()
})
afterEach(cleanup)

function renderCreateDialog() {
  const onSaved = vi.fn(async () => undefined)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <HoldingFormDialog
        state={{ mode: "create" }}
        accountId="acct-1"
        currency="IDR"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </QueryClientProvider>
  )
  // Everything except Quantity is valid, so Save's state isolates the quantity.
  fireEvent.change(screen.getByLabelText("Instrument name"), {
    target: { value: "Sucorinvest MMF" },
  })
  fireEvent.change(screen.getByLabelText(/Average unit cost/), {
    target: { value: "1500" },
  })
  return { onSaved }
}

const quantityField = () =>
  screen.getByLabelText("Quantity") as HTMLInputElement
const saveButton = () =>
  screen.getByRole("button", { name: "Add holding" }) as HTMLButtonElement

function typeQuantity(text: string) {
  fireEvent.change(quantityField(), { target: { value: text } })
}

describe("HoldingFormDialog quantity field", () => {
  it("canonical input needs no interaction: previews and submits as typed", async () => {
    const { onSaved } = renderCreateDialog()
    typeQuantity("1354.5")

    expect(screen.queryByRole("group")).toBeNull()
    expect(screen.getByText(/Read as: 1,354\.5 units/)).toBeTruthy()
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    await waitFor(() => expect(upsertHoldingFn).toHaveBeenCalledTimes(1))
    expect(upsertHoldingFn.mock.calls[0]?.[0]).toMatchObject({
      data: { accountId: "acct-1", quantity: "1354.5" },
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("an ambiguous 1.354 shows both readings and blocks Save until one is chosen", async () => {
    renderCreateDialog()
    typeQuantity("1.354")

    // Both readings are offered, in words a non-technical user can tell apart.
    const choices = screen.getByRole("group", {
      name: "Which reading did you mean",
    })
    expect(choices.textContent).toMatch(/one point three five four/)
    expect(choices.textContent).toMatch(/one thousand three hundred fifty-four/)
    // No "Read as" claim while it is unresolved, and Save is blocked.
    expect(screen.queryByText(/Read as:/)).toBeNull()
    expect(saveButton().disabled).toBe(true)

    // Pick the thousands reading (the Indonesian meaning of "1.354").
    fireEvent.click(
      screen.getByRole("button", {
        name: /one thousand three hundred fifty-four/,
      })
    )
    expect(quantityField().value).toBe("1354")
    expect(screen.queryByRole("group")).toBeNull()
    expect(screen.getByText(/Read as: 1,354 units/)).toBeTruthy()
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    await waitFor(() => expect(upsertHoldingFn).toHaveBeenCalledTimes(1))
    expect(upsertHoldingFn.mock.calls[0]?.[0]).toMatchObject({
      data: { quantity: "1354" },
    })
  })

  it("choosing the decimal reading submits 1.354 (as an unambiguous spelling)", async () => {
    renderCreateDialog()
    typeQuantity("1,354")
    expect(saveButton().disabled).toBe(true)

    fireEvent.click(
      screen.getByRole("button", { name: /one point three five four/ })
    )
    // Rewritten so it cannot re-trigger the prompt; same value.
    expect(quantityField().value).toBe("1.3540")
    expect(screen.queryByRole("group")).toBeNull()
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    await waitFor(() => expect(upsertHoldingFn).toHaveBeenCalledTimes(1))
    expect(upsertHoldingFn.mock.calls[0]?.[0]).toMatchObject({
      data: { quantity: "1.3540" },
    })
  })

  it("an unambiguous id-ID number is read locale-correctly (1.354,5 -> 1354.5)", async () => {
    renderCreateDialog()
    typeQuantity("1.354,5")

    expect(screen.queryByRole("group")).toBeNull()
    expect(screen.getByText(/Read as: 1,354\.5 units/)).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(upsertHoldingFn).toHaveBeenCalledTimes(1))
    expect(upsertHoldingFn.mock.calls[0]?.[0]).toMatchObject({
      data: { quantity: "1354.5" },
    })
  })

  it("invalid input shows the reason inline and keeps Save disabled", () => {
    renderCreateDialog()
    typeQuantity("1.35.4")

    expect(screen.getByText(/exactly 3 digits/)).toBeTruthy()
    expect(quantityField().getAttribute("aria-invalid")).toBe("true")
    expect(saveButton().disabled).toBe(true)
    expect(screen.queryByText(/Read as:/)).toBeNull()
  })

  it("editing a holding whose units read like 1.354 opens without a prompt", () => {
    const holding: HoldingRecord = {
      id: "holding-1",
      accountId: "acct-1",
      instrumentId: "instrument-1",
      familyId: "family-1",
      instrument: {
        id: "instrument-1",
        kind: "mutual_fund",
        name: "Sucorinvest MMF",
        symbol: null,
        quoteCurrency: "IDR",
        priceModel: "market",
        marketInstrumentId: null,
      },
      // Server-stored fixed-scale value; trimmed for the field ("1.354") it
      // would re-read as ambiguous, so the prefill must be made unambiguous.
      quantity: "1.35400000",
      avgUnitCostMinor: "150000",
      lastPriceMinor: null,
      currency: "IDR",
      valueMinor: "203100",
      costMinor: "203100",
      gainMinor: "0",
      returnPct: 0,
      lastMutationIdempotencyKey: null,
      ownerPersonId: null,
      latestMarketQuoteAsOf: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <HoldingFormDialog
          state={{ mode: "edit", holding }}
          accountId="acct-1"
          currency="IDR"
          onClose={vi.fn()}
          onSaved={vi.fn(async () => undefined)}
        />
      </QueryClientProvider>
    )
    expect(screen.queryByRole("group")).toBeNull()
    expect(quantityField().value).toBe("1.3540")
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })
})

// ADR-0058 D2 — the per-holding Owner select follows the same visibility rule
// as the account owner control: 2+ active members OR 2+ people.
describe("HoldingFormDialog owner select", () => {
  const twoMembers = {
    activeMemberCount: 2,
    peopleCount: 0,
    candidates: [
      {
        ref: { memberUserId: "user-1" },
        displayName: "Hendri",
        kind: "member",
        isMember: true,
      },
      {
        ref: { memberUserId: "user-2" },
        displayName: "Rahayu",
        kind: "member",
        isMember: true,
      },
    ] as unknown[],
  }

  afterEach(() => {
    listOwnerCandidatesFn.mockImplementation(async () => ({
      activeMemberCount: 1,
      peopleCount: 0,
      candidates: [] as unknown[],
    }))
  })

  it("is hidden for a one-member family and leaves `owner` out of the payload", async () => {
    renderCreateDialog()
    typeQuantity("10")
    await waitFor(() => expect(listOwnerCandidatesFn).toHaveBeenCalled())
    expect(screen.queryByLabelText("Owner")).toBeNull()

    fireEvent.click(saveButton())
    await waitFor(() => expect(upsertHoldingFn).toHaveBeenCalledTimes(1))
    const payload = upsertHoldingFn.mock.calls[0]?.[0] as {
      data: Record<string, unknown>
    }
    expect("owner" in payload.data).toBe(false)
  })

  it("shows for a two-member family, defaults to 'Same as account', and sends owner: null", async () => {
    listOwnerCandidatesFn.mockImplementation(async () => twoMembers)
    renderCreateDialog()
    typeQuantity("10")

    const trigger = await screen.findByLabelText("Owner")
    expect(trigger.textContent).toContain("Same as account")

    fireEvent.click(saveButton())
    await waitFor(() => expect(upsertHoldingFn).toHaveBeenCalledTimes(1))
    expect(upsertHoldingFn.mock.calls[0]?.[0]).toMatchObject({
      data: { owner: null },
    })
  })
})
