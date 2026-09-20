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

import type { AccountRecord } from "@/lib/account-collections"

// The dialog reaches the server only through these fns (and the accounts
// collection); mock them so no server code enters the jsdom test graph.
const {
  createAccountFn,
  updateAccountFn,
  setAccountZakatOwnershipFn,
  listOwnerCandidatesFn,
} = vi.hoisted(() => ({
  createAccountFn: vi.fn(async (_args: unknown) => ({ id: "new-account" })),
  updateAccountFn: vi.fn(async (_args: unknown) => undefined),
  setAccountZakatOwnershipFn: vi.fn(async (_args: unknown) => undefined),
  listOwnerCandidatesFn: vi.fn(async () => ({
    activeMemberCount: 1,
    peopleCount: 0,
    candidates: [] as unknown[],
  })),
}))
vi.mock("@/server/accounts", () => ({ createAccountFn, updateAccountFn }))
vi.mock("@/server/zakat", () => ({ setAccountZakatOwnershipFn }))
vi.mock("@/server/ownership", () => ({ listOwnerCandidatesFn }))
vi.mock("@/lib/account-collections", () => ({
  accountCollection: { utils: { refetch: vi.fn(async () => undefined) } },
}))

import { AccountFormDialog } from "./account-form-dialog"

// Radix Checkbox (the edit form's "Allow imports") measures itself with a
// ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver

// Full-dialog render on a cold jsdom is slow when the whole suite runs in
// parallel.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  createAccountFn.mockClear()
  updateAccountFn.mockClear()
  setAccountZakatOwnershipFn.mockClear()
})
afterEach(cleanup)

const candidate = (name: string, id: string) => ({
  ref: { personId: id },
  displayName: name,
  kind: "person",
  isMember: false,
})

function withCandidates(counts: {
  activeMemberCount: number
  peopleCount: number
}) {
  listOwnerCandidatesFn.mockImplementation(async () => ({
    ...counts,
    candidates: [candidate("Hendri", "p1"), candidate("Rahayu", "p2")],
  }))
}

const account: AccountRecord = {
  id: "acc-1",
  name: "Bank Jago",
  accountClass: "ASSET",
  accountType: "DEPOSITORY",
  accountSubtype: "checking",
  balanceSource: "transaction_flow",
  balance: "100000",
  currency: "IDR",
  color: null,
  status: "active",
  archivedAt: null,
  institutionName: null,
  externalProvider: null,
  externalAccountId: null,
  mask: null,
  isImportable: true,
  creditLimit: null,
  statementDay: null,
  dueDay: null,
  interestRateBps: null,
  counterpartyMerchantId: null,
  reserveBalance: null,
  zakatPayerId: "p1",
  zakatJointPayerId: null,
  zakatJointSharePercent: null,
}

function renderDialog(state: Parameters<typeof AccountFormDialog>[0]["state"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const onSaved = vi.fn(async () => undefined)
  render(
    <QueryClientProvider client={queryClient}>
      <AccountFormDialog state={state} onClose={vi.fn()} onSaved={onSaved} />
    </QueryClientProvider>
  )
  return { onSaved }
}

describe("AccountFormDialog owner controls (ADR-0058 D1)", () => {
  it("shows nothing for a one-member household, on create and on edit", async () => {
    renderDialog({ mode: "create" })
    await waitFor(() => expect(listOwnerCandidatesFn).toHaveBeenCalled())
    expect(screen.queryByText("Ownership")).toBeNull()
    cleanup()

    renderDialog({ mode: "edit", account })
    await waitFor(() => expect(listOwnerCandidatesFn).toHaveBeenCalled())
    expect(screen.queryByText("Ownership")).toBeNull()
  })

  it("shows on CREATE with two active members and no people at all", async () => {
    withCandidates({ activeMemberCount: 2, peopleCount: 0 })
    renderDialog({ mode: "create" })
    expect(await screen.findByText("Ownership")).toBeTruthy()
    expect(screen.getByLabelText("Owner")).toBeTruthy()
    expect(screen.getByLabelText("Shared with (optional)")).toBeTruthy()
    // Neutral copy: never the Zakat wording.
    expect(screen.queryByText(/Zakat/i)).toBeNull()
  })

  it("shows on EDIT with two people even when there is a single member", async () => {
    withCandidates({ activeMemberCount: 1, peopleCount: 2 })
    renderDialog({ mode: "edit", account })
    expect(await screen.findByText("Ownership")).toBeTruthy()
    // Seeded from the stored owner.
    expect(screen.getByLabelText("Owner").textContent).toContain("Hendri")
  })

  it("does not call the ownership fn when the owner was left alone", async () => {
    withCandidates({ activeMemberCount: 2, peopleCount: 2 })
    const { onSaved } = renderDialog({ mode: "edit", account })
    await screen.findByText("Ownership")

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(updateAccountFn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setAccountZakatOwnershipFn).not.toHaveBeenCalled()
  })

  it("creating without picking an owner never touches the ownership fn", async () => {
    withCandidates({ activeMemberCount: 2, peopleCount: 0 })
    const { onSaved } = renderDialog({ mode: "create" })
    await screen.findByText("Ownership")

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Wallet" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(createAccountFn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setAccountZakatOwnershipFn).not.toHaveBeenCalled()
  })
})
