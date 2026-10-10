// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * F1 audit S1 — money entry must not lose the user's locale reading.
 *
 * The bug these tests exist for: the five money fields bound to
 * `<input type="number">` and ran `Number()` on every keystroke, so the
 * browser's number parser decided what the text meant. Typing "50.000"
 * (id-ID for fifty thousand rupiah) reached the submit path as `50` and was
 * stored as **Rp 50** — a silent 1000× understatement in the most-used money
 * field in the product.
 *
 * Every case below drives the REAL modal through the UI, and asserts the exact
 * minor units that reach the TanStack DB collection (which is where the
 * optimistic row — and therefore the ledger payload — is built). The
 * collection is the natural boundary to assert on: `src/lib/collections.ts`
 * re-encodes those `Money` values for the server-fn wire format, and the
 * server's own contract is covered by the real-Postgres integration test
 * (`tests/integration/transfer-cross-currency-requirement.integration.ts`).
 *
 * `parseMoneyInput`'s readings (verified against the real parser, not assumed):
 *   "50.000"    -> 5_000_000n      "50,000"  -> 5_000_000n
 *   "1.234,56"  ->   123_456n      "368912.71" -> 36_891_271n
 * The same readings hold for IDR and USD (both scale 100), so each money field
 * is exercised with all four formats regardless of its currency.
 */

const captured = vi.hoisted(() => {
  const account = (overrides: Record<string, unknown>) => ({
    accountSubtype: "checking",
    balanceSource: "transaction_flow",
    balance: 0n,
    version: 0,
    color: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    institutionName: null,
    externalProvider: null,
    externalAccountId: null,
    mask: null,
    isImportable: false,
    creditLimit: null,
    statementDay: null,
    dueDay: null,
    interestRateBps: null,
    reserveBalance: null,
    counterpartyMerchantId: null,
    zakatPayerId: null,
    zakatJointPayerId: null,
    zakatJointSharePercent: null,
    familyId: "family-1",
    hasHoldings: false,
    ...overrides,
  })

  return {
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    persistence: {
      error: null as Error | null,
      // Optional hold on `isPersisted.promise` so a test can keep a submit
      // "in flight" while it fires a second one (see the double-submit
      // describe block at the bottom).
      gate: null as null | { promise: Promise<void>; open: () => void },
    },
    formData: {
      accounts: [
        account({
          id: "acc-idr",
          name: "IDR Cash",
          accountClass: "ASSET",
          accountType: "DEPOSITORY",
          currency: "IDR",
          balance: 100_000_000n,
        }),
        account({
          id: "acc-usd-tracked",
          name: "USD Fund",
          accountClass: "ASSET",
          accountType: "TRACKED_ASSET",
          accountSubtype: "brokerage",
          balanceSource: "valuation",
          currency: "USD",
          balance: 500_000n,
        }),
      ],
      categories: [
        {
          id: "cat-groceries",
          name: "Groceries",
          type: "expense",
          color: "#6172F3",
          icon: "shapes",
          isSystem: false,
          familyId: "family-1",
          externalProvider: null,
          externalId: null,
          parentId: null,
        },
      ],
      merchants: [],
      tags: [],
    },
  }
})

vi.mock("@/lib/collections", () => ({
  transactionCollection: {
    insert: (row: Record<string, unknown>) => {
      captured.inserts.push(row)
      const gate = captured.persistence.gate
      return {
        isPersisted: {
          promise: (gate ? gate.promise : Promise.resolve()).then(() => {
            if (captured.persistence.error) throw captured.persistence.error
          }),
        },
      }
    },
    update: (
      _id: string,
      updater: (draft: Record<string, unknown>) => void
    ) => {
      const draft: Record<string, unknown> = {}
      updater(draft)
      captured.updates.push(draft)
      return {
        isPersisted: {
          promise: Promise.resolve(),
        },
      }
    },
    delete: () => undefined,
    utils: { refetch: async () => undefined },
  },
}))

vi.mock("@/lib/account-collections", () => ({
  accountCollection: { utils: { refetch: async () => undefined } },
}))

vi.mock("@/server/transactions", () => ({
  getTransactionFormData: async () => captured.formData,
}))
vi.mock("@/server/merchants", () => ({
  createMerchantFn: async () => ({ id: "m-1", name: "m", color: null }),
}))
vi.mock("@/server/categories", () => ({
  createCategoryFn: async () => ({ id: "c-1", name: "c", type: "expense" }),
}))
vi.mock("@/server/tags", () => ({
  createTagFn: async () => ({ id: "t-1", name: "t", color: null }),
  setTransactionTagsFn: async () => undefined,
}))
vi.mock("@/server/smart-rules", () => ({
  suggestSmartRuleFn: async () => null,
}))
vi.mock("@/server/holdings", () => ({ getAccountHoldingsFn: async () => [] }))
vi.mock("@/server/valuations", () => ({
  getLatestGroundTruthAnchorFn: async () => null,
}))
// The modal imports `toast` from sonner for the success/partial-failure
// confirmations; asserting on it proves the "close + confirm" half of the
// submit contract without rendering the real Toaster.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import { toast } from "sonner"
import { TransactionFormModal } from "./transaction-form-modal"

// Radix Switch/Tabs measure themselves with a ResizeObserver, which jsdom
// lacks — same stub the sibling account-form-dialog test uses.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver
// The category picker is the repo's EntityCombobox (Radix Popover + cmdk), and
// cmdk scrolls the active item into view as it mounts — jsdom implements no
// layout, so it has no scrollIntoView.
Element.prototype.scrollIntoView = () => undefined

// Full-dialog render (Radix Dialog + Tabs + date field) on a cold jsdom: same
// budget the sibling dialog tests use.
vi.setConfig({ testTimeout: 30_000 })

const CASES: ReadonlyArray<{ typed: string; minor: bigint }> = [
  { typed: "50.000", minor: 5_000_000n },
  { typed: "50,000", minor: 5_000_000n },
  { typed: "1.234,56", minor: 123_456n },
  { typed: "368912.71", minor: 36_891_271n },
]

beforeEach(() => {
  captured.inserts.length = 0
  captured.updates.length = 0
  captured.persistence.error = null
  captured.persistence.gate = null
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

afterEach(cleanup)

function renderModal(editData?: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <TransactionFormModal
        defaultAccountId="acc-idr"
        editData={editData as never}
      />
    </QueryClientProvider>
  )
}

/**
 * Render and open the dialog, then WAIT for the form-data query to resolve.
 * Until it does, every account/category control is rendered disabled
 * (`isLoading`), and a click on a disabled combobox is silently dropped —
 * which is exactly how the first draft of this file failed.
 */
async function openDialog() {
  renderModal()
  fireEvent.click(screen.getByRole("button", { name: /New Transaction/ }))
  await waitFor(() => {
    const trigger = screen.getByLabelText("Category *")
    if ((trigger as HTMLButtonElement).disabled) {
      throw new Error("form data still loading")
    }
  })
}

function moneyField(label: RegExp | string) {
  return screen.getByLabelText(label)
}

function typeInto(label: RegExp | string, text: string) {
  fireEvent.change(moneyField(label), { target: { value: text } })
}

/** Switch to the Transfer tab and pick the USD tracked destination account. */
async function openTransferWithDestination() {
  const transferTab = screen.getByRole("tab", { name: "Transfer" })
  fireEvent.mouseDown(transferTab, { button: 0 })
  fireEvent.click(transferTab)
  await waitFor(() => {
    const select = screen.getByLabelText("To Account *") as HTMLSelectElement
    if (select.disabled) {
      throw new Error("destination select still loading")
    }
  })
  fireEvent.change(screen.getByLabelText("To Account *"), {
    target: { value: "acc-usd-tracked" },
  })
}

/**
 * Expense/income rows require a category (field-level validator), so every
 * non-transfer test must pick one. The control is the repo's EntityCombobox:
 * a `role="combobox"` button (found via its label) that opens a cmdk list
 * whose items expose `role="option"`.
 */
function selectCategory(name = "Groceries") {
  fireEvent.click(screen.getByLabelText("Category *"))
  fireEvent.click(screen.getByRole("option", { name }))
}

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: /Save Transaction/ }))
}

describe("amount field — locale readings reach the ledger exactly", () => {
  it.each(CASES)(
    'parses "$typed" as $minor minor units',
    async ({ typed, minor }) => {
      await openDialog()
      typeInto(/^Amount \*$/, typed)
      fireEvent.change(screen.getByLabelText("Description *"), {
        target: { value: "Locale reading" },
      })
      selectCategory()

      await submit()

      await waitFor(() => expect(captured.inserts).toHaveLength(1))
      expect(captured.inserts[0]?.amount).toBe(minor)
    }
  )

  it("blocks submit with a clear message when the amount is not parseable", async () => {
    await openDialog()
    typeInto(/^Amount \*$/, "not a number")
    fireEvent.change(screen.getByLabelText("Description *"), {
      target: { value: "Bad amount" },
    })
    selectCategory()

    await submit()

    expect(await screen.findByText(/is not a valid amount/)).toBeTruthy()
    expect(captured.inserts).toHaveLength(0)
  })

  it("blocks submit when the amount is blank", async () => {
    await openDialog()
    fireEvent.change(screen.getByLabelText("Description *"), {
      target: { value: "No amount" },
    })
    selectCategory()

    await submit()

    expect(captured.inserts).toHaveLength(0)
  })
})

describe("server persistence feedback", () => {
  it("keeps the modal open and shows the server error when an optimistic insert rolls back", async () => {
    captured.persistence.error = new Error(
      "This payment would take the credit card balance positive."
    )
    await openDialog()
    typeInto(/^Amount \*$/, "1000")
    fireEvent.change(screen.getByLabelText("Description *"), {
      target: { value: "Rejected payment" },
    })
    selectCategory()

    await submit()

    expect(
      await screen.findByText(
        /Could not save transaction: This payment would take the credit card balance positive\./
      )
    ).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
})

describe("split rows — exact parity, exact minor units", () => {
  it('parses "50.000" in a split row and requires exact bigint parity', async () => {
    await openDialog()
    fireEvent.change(screen.getByLabelText("Description *"), {
      target: { value: "Weekly shop" },
    })
    typeInto(/^Amount \*$/, "60.000")
    // Split last: enabling it hides the parent description, but the field is
    // still validated, so the real flow (and the e2e) fills it first.
    fireEvent.click(screen.getByRole("switch"))

    const rows = () => screen.getAllByLabelText("Amount for split entry")
    const descriptions = () =>
      screen.getAllByLabelText("Description for split entry")
    fireEvent.change(descriptions()[0], { target: { value: "Groceries" } })
    fireEvent.change(rows()[0], { target: { value: "50.000" } })
    fireEvent.change(descriptions()[1], { target: { value: "Household" } })
    fireEvent.change(rows()[1], { target: { value: "10.000" } })

    await submit()

    await waitFor(() => expect(captured.inserts).toHaveLength(1))
    const splitEntries = captured.inserts[0]?.splitEntries
    expect(Array.isArray(splitEntries)).toBe(true)
    expect(
      (splitEntries as Array<{ amount: bigint }>).map((entry) => entry.amount)
    ).toEqual([5_000_000n, 1_000_000n])
  })

  it("refuses a split whose rows do not sum to the parent, with both figures", async () => {
    await openDialog()
    fireEvent.click(screen.getByRole("switch"))

    const rows = () => screen.getAllByLabelText("Amount for split entry")
    const descriptions = () =>
      screen.getAllByLabelText("Description for split entry")

    typeInto(/^Amount \*$/, "60.000")
    fireEvent.change(descriptions()[0], { target: { value: "Groceries" } })
    fireEvent.change(rows()[0], { target: { value: "50.000" } })
    fireEvent.change(descriptions()[1], { target: { value: "Household" } })
    fireEvent.change(rows()[1], { target: { value: "9.999" } })

    // The exact-parity gate disables Save outright — the user sees the
    // shortfall before they can submit, and the defensive check inside the
    // submit handler only catches a race.
    expect(
      (
        screen.getByRole("button", {
          name: /Save Transaction/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(screen.getByText(/unallocated/)).toBeTruthy()
    // Typing an amount that closes the gap re-enables it — proof the gate is
    // the parity, not a blanket block.
    fireEvent.change(rows()[1], { target: { value: "10.000" } })
    expect(
      (
        screen.getByRole("button", {
          name: /Save Transaction/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    expect(captured.inserts).toHaveLength(0)
  })
})

describe("transfer fields — destination, fee and tracked value", () => {
  it.each(CASES)(
    'parses "$typed" in the destination-amount field as $minor minor units',
    async ({ typed, minor }) => {
      await openDialog()
      await openTransferWithDestination()
      typeInto(/^Amount \*$/, "1000000")
      fireEvent.change(screen.getByLabelText("Transfer Note *"), {
        target: { value: "Cross-currency" },
      })
      typeInto(/^Destination Amount/, typed)

      await submit()

      await waitFor(() => expect(captured.inserts).toHaveLength(1))
      expect(captured.inserts[0]?.destinationAmount).toBe(minor)
    }
  )

  it.each(CASES)(
    'parses "$typed" in the transfer-fee field as $minor minor units',
    async ({ typed, minor }) => {
      await openDialog()
      await openTransferWithDestination()
      typeInto(/^Amount \*$/, "1000000")
      fireEvent.change(screen.getByLabelText("Transfer Note *"), {
        target: { value: "Fee" },
      })
      // Cross-currency: the destination amount is required (S1's server +
      // client guard), so state it before touching the fee.
      typeInto(/^Destination Amount/, "100")
      typeInto(/transfer fee/i, typed)

      await submit()

      await waitFor(() => expect(captured.inserts).toHaveLength(1))
      expect(captured.inserts[0]?.feeAmount).toBe(minor)
    }
  )

  it.each(CASES)(
    'parses "$typed" in the tracked-value field as $minor minor units',
    async ({ typed, minor }) => {
      await openDialog()
      await openTransferWithDestination()
      typeInto(/^Amount \*$/, "1000000")
      fireEvent.change(screen.getByLabelText("Transfer Note *"), {
        target: { value: "Contribution" },
      })
      typeInto(/^Destination Amount/, "100")
      typeInto(/^New value of/, typed)

      await submit()

      await waitFor(() => expect(captured.inserts).toHaveLength(1))
      // The collection receives the WIRE string for this one (it is the
      // ephemeral field `collections.ts` forwards verbatim), so compare the
      // exact digits rather than a bigint.
      expect(String(captured.inserts[0]?.newValuationValue)).toBe(
        minor.toString()
      )
    }
  )
})

describe("edit-mode prefill — exact round-trip", () => {
  it("shows an exact, re-parseable string for an amount with cents", async () => {
    renderModal({
      id: "trx-1",
      type: "expense",
      amount: 36_891_271n,
      currency: "IDR",
      description: "Prefilled",
      accountId: "acc-idr",
      categoryId: null,
      toAccountId: null,
      merchantId: null,
      date: new Date("2026-09-20T00:00:00.000Z"),
      notes: null,
      status: "CLEARED",
      attachmentUrl: null,
    })
    // Edit mode opens the dialog itself (`useState(isEditMode)`), so there is
    // no trigger to click.
    const amountField = await waitFor(() => {
      const field = moneyField(/^Amount \*$/) as HTMLInputElement
      if (field.value === "") {
        throw new Error("prefill not applied yet")
      }
      return field
    })
    expect((amountField as HTMLInputElement).value).toBe("368912.71")
    // The live preview proves it re-parsed to the same minor units.
    expect(screen.getByText(/= Rp 368,912.71/)).toBeTruthy()
  })
})

/**
 * Slow-round-trip double-submit — the "form feels hung, user clicks again,
 * transaction saved twice" bug.
 *
 * The old flow minted a FRESH idempotency key on every submit and left the
 * submit button live for the whole round trip. A user who believed the save
 * had failed clicked again — a second, *different* mutation that legitimately
 * created a second row (prod corroboration: 13 duplicate-suspect groups).
 *
 * The fixed contract, asserted here at the collection boundary:
 *   1. A create-mode session owns ONE (row id, idempotency key) pair; a retry
 *      replays the exact same request instead of inserting a second row.
 *   2. While a submit is in flight the button is disabled with a "Saving…"
 *      label (TanStack Form's own isSubmitting), and a second submit that
 *      manages to start anyway is swallowed by the in-flight ref guard.
 *   3. Success closes the dialog immediately and confirms with a toast; a
 *      rejected attempt keeps the dialog open and shows the server message in
 *      the existing error banner.
 */
describe("double-submit and retry identity", () => {
  function createGate() {
    let open: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      open = resolve
    })
    return { promise, open }
  }

  async function fillExpense(description: string) {
    typeInto(/^Amount \*$/, "25000")
    fireEvent.change(screen.getByLabelText("Description *"), {
      target: { value: description },
    })
    selectCategory()
  }

  it("two submits in the same tick insert exactly once", async () => {
    await openDialog()
    await fillExpense("Double submit guard")

    const gate = createGate()
    captured.persistence.gate = gate

    const saveButton = screen.getByRole("button", { name: /Save Transaction/ })
    const form = saveButton.closest("form")
    if (!form) throw new Error("transaction form not found")
    fireEvent.click(saveButton)

    // Second submit in the SAME tick — this lands before React can re-render
    // the button as disabled, which is the exact fast-double-click window the
    // ref guard exists for. It must be swallowed: exactly one insert, and one
    // idempotency key reaches the collection.
    fireEvent.submit(form)

    // The in-flight affordance lands once the submit starts running; by then
    // an un-guarded second mutation would already have inserted (verified: the
    // test fails with two inserts when the guard is removed).
    await screen.findByRole("button", { name: /Saving/ })
    expect(captured.inserts).toHaveLength(1)

    gate.open()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("shows the in-flight state for the whole round trip, then closes with a toast", async () => {
    await openDialog()
    await fillExpense("Slow round trip")

    const gate = createGate()
    captured.persistence.gate = gate

    fireEvent.click(screen.getByRole("button", { name: /Save Transaction/ }))

    // While the round trip is pending the button is disabled and labelled —
    // the user gets "it is working" feedback instead of a form that looks
    // frozen (the belief that produced the second click in prod).
    const savingButton = await screen.findByRole("button", { name: /Saving/ })
    expect((savingButton as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole("dialog")).toBeTruthy()

    gate.open()
    // Success closes the dialog immediately (nothing past durability gates the
    // close) and confirms with a toast.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Transaction saved.")
  })

  it("retries a rejected submit with the SAME id and idempotency key (server replay, not a second row)", async () => {
    captured.persistence.error = new Error("Rejected once")
    await openDialog()
    await fillExpense("Retry replay")

    await submit()
    expect(
      await screen.findByText(/Could not save transaction: Rejected once/)
    ).toBeTruthy()
    // The error path keeps the dialog open so the user can retry.
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(captured.inserts).toHaveLength(1)

    captured.persistence.error = null
    await submit()

    await waitFor(() => expect(captured.inserts).toHaveLength(2))
    expect(captured.inserts[1]?.idempotencyKey).toBe(
      captured.inserts[0]?.idempotencyKey
    )
    expect(captured.inserts[1]?.id).toBe(captured.inserts[0]?.id)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("mints a FRESH id and key for the next session after a successful close", async () => {
    await openDialog()
    await fillExpense("First session")

    await submit()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(captured.inserts).toHaveLength(1)

    // Reopen the singleton modal and record a second, unrelated transaction.
    fireEvent.click(screen.getByRole("button", { name: /New Transaction/ }))
    await waitFor(() => {
      const trigger = screen.getByLabelText("Category *")
      if ((trigger as HTMLButtonElement).disabled) {
        throw new Error("form data still loading")
      }
    })
    await fillExpense("Second session")

    await submit()
    await waitFor(() => expect(captured.inserts).toHaveLength(2))
    expect(captured.inserts[1]?.idempotencyKey).not.toBe(
      captured.inserts[0]?.idempotencyKey
    )
    expect(captured.inserts[1]?.id).not.toBe(captured.inserts[0]?.id)
  })
})
