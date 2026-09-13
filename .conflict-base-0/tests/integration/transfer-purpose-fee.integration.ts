import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import {
  createAccountForFamily,
  enableHoldingsTrackingForFamily,
} from "@/server/accounts"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
  findLedgerTransactionsForFamily,
  IdempotencyConflictError,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-247 — contextual money movement: transfer purpose + transfer fee.
// Real-Postgres proof of the §5A ledger invariants for the new transfer_fee
// leg (conservation, dual-leg, idempotent replay/conflict, delete reversal,
// audit) and the additive Transfer.purpose dimension (taxonomy derivation +
// client override + DB guard). The purpose lives on the canonical Transfer
// row (one shared value), never on the leg Transactions — so every assertion
// reads it off `tx.transfer`.
describe("transfer purpose + fee (PER-247)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  const makeAccount = (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      accountSubtype?: string
      currency?: string
      openingBalance?: string
    } = {}
  ) =>
    createAccountForFamily({
      data: {
        name: overrides.name ?? "Account",
        accountType: overrides.accountType ?? "DEPOSITORY",
        accountSubtype: overrides.accountSubtype,
        currency: overrides.currency ?? "IDR",
        openingBalance: overrides.openingBalance ?? "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const accountBalance = (owner: AuthenticatedOnboardedUser, id: string) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const acc = await tx.account.findUniqueOrThrow({ where: { id } })
      return acc.balance
    })

  // Family net worth = signed sum of every (non-deleted) account balance.
  const netWorth = (owner: AuthenticatedOnboardedUser) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const accounts = await tx.account.findMany({
        where: { familyId: owner.family.id, deletedAt: null },
      })
      return accounts.reduce((sum, a) => sum + a.balance, 0n)
    })

  const readTx = (owner: AuthenticatedOnboardedUser, id: string | null) => {
    if (!id) throw new Error("readTx: expected a non-null transaction id")
    return harness.withFamily(owner.family.id, async (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id } })
    )
  }

  // The purpose + fee link live on the canonical Transfer row.
  const readTransferByOutflow = (
    owner: AuthenticatedOnboardedUser,
    outflowId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.transfer.findFirstOrThrow({
        where: { outflowTransactionId: outflowId },
      })
    )

  // ---- fee conservation -----------------------------------------------------

  test("same-currency transfer with a fee: origin −(amount+fee), dest +amount, net worth −fee", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const ewallet = await makeAccount(owner, {
      name: "GoPay",
      accountType: "E_WALLET",
      openingBalance: "0",
    })

    const before = await netWorth(owner)

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 100_000n,
        accountId: bank.id,
        toAccountId: ewallet.id,
        feeAmount: 1_000n,
        description: "Top up GoPay",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Ledger effect: origin loses amount + fee, destination gains amount.
    expect(await accountBalance(owner, bank.id)).toBe(899_000n)
    expect(await accountBalance(owner, ewallet.id)).toBe(100_000n)

    // The fee is a real, signed expense of kind transfer_fee on the origin,
    // linked to the Transfer (not a transfer leg — no toAccountId).
    const transfer = await readTransferByOutflow(owner, created.id)
    expect(transfer.feeTransactionId).not.toBeNull()
    expect(transfer.purpose).toBe("top_up") // dest E_WALLET
    const fee = await readTx(owner, transfer.feeTransactionId)
    expect(fee.kind).toBe("transfer_fee")
    expect(fee.type).toBe("expense")
    expect(fee.amount).toBe(-1_000n)
    expect(fee.accountId).toBe(bank.id)
    expect(fee.toAccountId).toBeNull()

    // Conservation to the sen: net worth is down by exactly the fee.
    expect(await netWorth(owner)).toBe(before - 1_000n)

    // Every written row is audited in the same transaction.
    const feeAudit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findFirst({
        where: {
          entityType: "Transaction",
          entityId: fee.id,
          action: "create",
        },
      })
    )
    expect(feeAudit).not.toBeNull()
  })

  test("the fee may be borne by the destination account (editable bearer)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const ewallet = await makeAccount(owner, {
      name: "OVO",
      accountType: "E_WALLET",
      openingBalance: "0",
    })

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 100_000n,
        accountId: bank.id,
        toAccountId: ewallet.id,
        feeAmount: 500n,
        feeAccountId: ewallet.id, // destination bears the fee
        description: "Top up OVO (dest-borne fee)",
        date: new Date("2026-06-02"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Origin loses only the moved amount; destination gains amount then pays
    // the fee out of its own balance.
    expect(await accountBalance(owner, bank.id)).toBe(900_000n)
    expect(await accountBalance(owner, ewallet.id)).toBe(99_500n)

    const transfer = await readTransferByOutflow(owner, created.id)
    const fee = await readTx(owner, transfer.feeTransactionId)
    expect(fee.accountId).toBe(ewallet.id)
    expect(fee.amount).toBe(-500n)
  })

  test("zero/absent fee writes NO fee row and conserves net worth exactly", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "500000",
    })
    const savings = await makeAccount(owner, {
      name: "Savings",
      openingBalance: "0",
    })

    const before = await netWorth(owner)
    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 50_000n,
        accountId: bank.id,
        toAccountId: savings.id,
        description: "Move to savings",
        date: new Date("2026-06-03"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const transfer = await readTransferByOutflow(owner, created.id)
    expect(transfer.feeTransactionId).toBeNull()
    // A pure funds movement conserves net worth exactly.
    expect(await netWorth(owner)).toBe(before)
  })

  // ---- purpose derivation + override ----------------------------------------

  test("derives the purpose from the account taxonomy (kimi semantics)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "10000000",
    })
    const invest = await makeAccount(owner, {
      name: "Reksadana",
      accountType: "INVESTMENT",
      openingBalance: "0",
    })
    const invest2 = await makeAccount(owner, {
      name: "Reksadana 2",
      accountType: "INVESTMENT",
      openingBalance: "0",
    })
    const cash = await makeAccount(owner, {
      name: "Cash",
      accountType: "CASH",
      openingBalance: "0",
    })

    const derive = async (
      from: string,
      to: string,
      amount: bigint,
      date: string
    ) => {
      const created = await createTransactionForFamily({
        data: {
          type: "transfer",
          amount,
          accountId: from,
          toAccountId: to,
          description: "derive",
          date: new Date(date),
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      return (await readTransferByOutflow(owner, created.id)).purpose
    }

    // dest INVESTMENT → contribution
    expect(await derive(bank.id, invest.id, 200_000n, "2026-06-04")).toBe(
      "investment_contribution"
    )
    // source INVESTMENT (to a plain bank) → withdrawal
    expect(await derive(invest.id, bank.id, 50_000n, "2026-06-05")).toBe(
      "investment_withdrawal"
    )
    // dest CASH → cash_withdrawal
    expect(await derive(bank.id, cash.id, 10_000n, "2026-06-06")).toBe(
      "cash_withdrawal"
    )
    // INVESTMENT → INVESTMENT is ambiguous → no derived purpose (null)
    expect(await derive(invest.id, invest2.id, 5_000n, "2026-06-07")).toBeNull()
  })

  test("a savings-subtype destination derives the savings purpose", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const savings = await makeAccount(owner, {
      name: "Tabungan",
      accountType: "DEPOSITORY",
      accountSubtype: "savings",
      openingBalance: "0",
    })

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 100_000n,
        accountId: bank.id,
        toAccountId: savings.id,
        description: "Nabung",
        date: new Date("2026-06-08"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect((await readTransferByOutflow(owner, created.id)).purpose).toBe(
      "savings"
    )
  })

  test("a client purpose override wins over the derived default", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const ewallet = await makeAccount(owner, {
      name: "GoPay",
      accountType: "E_WALLET",
      openingBalance: "0",
    })

    // Derived default would be top_up; the user calls it savings instead.
    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 100_000n,
        accountId: bank.id,
        toAccountId: ewallet.id,
        transferPurpose: "savings",
        description: "Set aside on GoPay",
        date: new Date("2026-06-09"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect((await readTransferByOutflow(owner, created.id)).purpose).toBe(
      "savings"
    )
  })

  test("valuation-linked contribution carries the derived purpose on its Transfer", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "5000000",
    })
    const invest = await makeAccount(owner, {
      name: "Bibit",
      accountType: "INVESTMENT",
      openingBalance: "0",
    })
    // Flip the INVESTMENT account to valuation-tracked so the transfer routes
    // through the valuation-linked path (ADR-0048).
    await enableHoldingsTrackingForFamily({
      data: {
        accountId: invest.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 300_000n,
        accountId: bank.id,
        toAccountId: invest.id,
        feeAmount: 2_000n,
        description: "Nabung Bibit",
        date: new Date("2026-06-10"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const transfer = await readTransferByOutflow(owner, created.id)
    expect(transfer.purpose).toBe("investment_contribution")
    // The fee on a valuation-linked contribution posts on the cash source.
    const fee = await readTx(owner, transfer.feeTransactionId)
    expect(fee.kind).toBe("transfer_fee")
    expect(fee.accountId).toBe(bank.id)
    expect(await accountBalance(owner, bank.id)).toBe(4_698_000n)
  })

  // ---- redemption direction (prod bug: reversed arrow) ----------------------

  test("a valuation-linked redemption exposes transferIncoming so the arrow reads tracked → cash", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank Jago",
      openingBalance: "5000000",
    })
    const invest = await makeAccount(owner, {
      name: "Hasil Jualan",
      accountType: "INVESTMENT",
      openingBalance: "0",
    })
    await enableHoldingsTrackingForFamily({
      data: {
        accountId: invest.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Fund the position first (contribution: Bank Jago → Hasil Jualan). Pass
    // the new valuation explicitly so the test does not depend on the
    // anchor/backdating prefill heuristic.
    const contribution = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 1_000_000n,
        accountId: bank.id,
        toAccountId: invest.id,
        newValuationValue: "1000000",
        description: "Nabung",
        date: new Date("2026-06-15"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // ...then redeem part of it (Hasil Jualan → Bank Jago). The cash leg lands
    // on Bank Jago (accountId) with toAccountId = Hasil Jualan — correct data,
    // but naively rendered "account → toAccount" it reads reversed.
    const redemption = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 400_000n,
        accountId: invest.id,
        toAccountId: bank.id,
        newValuationValue: "600000",
        description: "Tarik hasil jualan",
        date: new Date("2026-06-16"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const ledger = await harness.withFamily(owner.family.id, (tx) =>
      findLedgerTransactionsForFamily(tx, owner.family.id)
    )
    const redemptionRow = ledger.find((r) => r.id === redemption.id)
    const contributionRow = ledger.find((r) => r.id === contribution.id)

    // The redemption cash leg is stored on Bank Jago pointing at Hasil Jualan,
    // and is flagged incoming so the renderer flips the arrow to
    // "Hasil Jualan → Bank Jago".
    expect(redemptionRow?.accountId).toBe(bank.id)
    expect(redemptionRow?.toAccountId).toBe(invest.id)
    expect(redemptionRow?.transferIncoming).toBe(true)
    expect(redemptionRow?.transferPurpose).toBe("investment_withdrawal")

    // A contribution is outgoing from its cash account — arrow stays
    // "Bank Jago → Hasil Jualan".
    expect(contributionRow?.transferIncoming).toBe(false)
  })

  // ---- idempotent replay + conflict -----------------------------------------

  test("replaying the same idempotency key does not duplicate legs or the fee", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const ewallet = await makeAccount(owner, {
      name: "OVO",
      accountType: "E_WALLET",
      openingBalance: "0",
    })
    const key = factories.createIdempotencyKey()
    const payload = {
      type: "transfer" as const,
      amount: 100_000n,
      accountId: bank.id,
      toAccountId: ewallet.id,
      feeAmount: 1_500n,
      description: "Top up OVO",
      date: new Date("2026-06-11"),
      idempotencyKey: key,
    }

    const first = await createTransactionForFamily({
      data: payload,
      familyId: owner.family.id,
      user: owner.user,
    })
    const second = await createTransactionForFamily({
      data: payload,
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(second.id).toBe(first.id)

    // Balances reflect exactly ONE application (amount + fee).
    expect(await accountBalance(owner, bank.id)).toBe(898_500n)
    expect(await accountBalance(owner, ewallet.id)).toBe(100_000n)

    const counts = await harness.withFamily(owner.family.id, async (tx) => ({
      transfers: await tx.transfer.count({ where: { deletedAt: null } }),
      feeRows: await tx.transaction.count({
        where: { kind: "transfer_fee", deletedAt: null },
      }),
    }))
    expect(counts.transfers).toBe(1)
    expect(counts.feeRows).toBe(1)
  })

  test("the same key with a different fee is a conflict (not a silent replay)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const ewallet = await makeAccount(owner, {
      name: "Dana",
      accountType: "E_WALLET",
      openingBalance: "0",
    })
    const key = factories.createIdempotencyKey()
    const base = {
      type: "transfer" as const,
      amount: 100_000n,
      accountId: bank.id,
      toAccountId: ewallet.id,
      description: "Top up Dana",
      date: new Date("2026-06-12"),
      idempotencyKey: key,
    }

    await createTransactionForFamily({
      data: { ...base, feeAmount: 1_000n },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      createTransactionForFamily({
        data: { ...base, feeAmount: 2_000n },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  // ---- delete reversal ------------------------------------------------------

  test("delete reverses the fee exactly once and restores net worth", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const ewallet = await makeAccount(owner, {
      name: "ShopeePay",
      accountType: "E_WALLET",
      openingBalance: "0",
    })
    const before = await netWorth(owner)
    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 100_000n,
        accountId: bank.id,
        toAccountId: ewallet.id,
        feeAmount: 2_000n,
        description: "Top up ShopeePay",
        date: new Date("2026-06-13"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const transfer = await readTransferByOutflow(owner, created.id)
    const feeId = transfer.feeTransactionId

    const deleteKey = factories.createIdempotencyKey()
    await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: deleteKey,
      familyId: owner.family.id,
      user: owner.user,
    })

    // Net worth is fully restored (amount move + fee both reversed).
    expect(await netWorth(owner)).toBe(before)
    expect(await accountBalance(owner, bank.id)).toBe(1_000_000n)
    expect(await accountBalance(owner, ewallet.id)).toBe(0n)

    // The fee row is soft-deleted, not erased (ledger history preserved).
    const fee = await readTx(owner, feeId)
    expect(fee.deletedAt).not.toBeNull()

    // A replayed delete does not reverse balances a second time.
    await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: deleteKey,
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(await netWorth(owner)).toBe(before)
    expect(await accountBalance(owner, bank.id)).toBe(1_000_000n)
  })

  // ---- DB guard: purpose only on funds_movement -----------------------------

  test("a purpose override on a non-funds_movement (cc_payment) transfer is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const bank = await makeAccount(owner, {
      name: "Bank",
      openingBalance: "1000000",
    })
    const card = await makeAccount(owner, {
      name: "Credit Card",
      accountType: "CREDIT",
      openingBalance: "0",
    })

    // bank (ASSET) → CREDIT card = cc_payment; a purpose is meaningless there.
    await expect(
      createTransactionForFamily({
        data: {
          type: "transfer",
          amount: 100_000n,
          accountId: bank.id,
          toAccountId: card.id,
          transferPurpose: "savings",
          description: "Pay card",
          date: new Date("2026-06-14"),
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow()
  })
})
