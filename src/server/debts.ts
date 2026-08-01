import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { createUuidV7 } from "@/lib/uuid-v7"
import { formatCurrency } from "@/lib/currency"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
} from "./middleware/with-family"
import { uuidV7Schema, type RunInTenantTransaction } from "./mutation-kit"
import { createAccountForFamily } from "./accounts"
import { createMerchantForFamily, type SerializedMerchant } from "./merchants"
import { createTransactionForFamily } from "./transactions"

// =============================================================================
// PER-212 / ADR-0049 — person-to-person debt (Utang-Piutang), Slice 1 of the
// PER-211 epic.
//
// A person-debt is NOT a new ledger concept. It is an ordinary
// RECEIVABLE(ASSET) or LOAN(LIABILITY) account flagged by a link to a "person"
// contact (`Account.counterpartyMerchantId` -> a `Merchant` with kind="person").
// Lend / borrow / repay are ORDINARY TRANSFERS routed through the SAME
// `createTransactionForFamily` the rest of the app uses, so double-entry,
// signed amounts, atomic balance updates, idempotency, tenant-reference
// validation, RLS scoping, and append-only audit all hold FOR FREE. This module
// only orchestrates: ensure the right person-debt account exists, then post the
// transfer in the correct direction. There is NO debt sub-ledger.
//
// Direction / kind derivation is delegated entirely to the ledger core
// (`deriveTransferKindForAccounts`):
//   - Lend  : cash -> RECEIVABLE  => funds_movement (their debt to you grows).
//   - Borrow: LOAN -> cash        => liability_draw (your debt to them grows).
//   - Repay receivable: RECEIVABLE -> cash => funds_movement.
//   - Repay loan       : cash -> LOAN      => loan_payment.
//
// Installment schedules, reminders, and interest accrual are LATER slices
// (PER-211); this slice is strictly ad-hoc amounts.
// =============================================================================

// Direction of a debt relative to the family: they owe you (receivable) or you
// owe them (loan). Maps 1:1 to the account type that holds the debt.
export type PersonDebtDirection = "receivable" | "loan"

const DIRECTION_ACCOUNT_TYPE: Record<
  PersonDebtDirection,
  "RECEIVABLE" | "LOAN"
> = {
  receivable: "RECEIVABLE",
  loan: "LOAN",
}

/** Raised when a debt flow references a person/account not owned by the family. */
export class PersonDebtNotFoundError extends Error {
  override readonly name = "PersonDebtNotFoundError"
  readonly statusCode = 404
}

/**
 * Raised when a repayment is not a valid ledger move: there is no outstanding
 * debt in that direction, or the amount would overshoot the outstanding balance
 * (which would drive a RECEIVABLE negative or a LOAN positive and trip the
 * `account_normal_balance_sign` CHECK). The human-readable reason lives in
 * `.message` because TanStack Start's ShallowErrorPlugin strips every Error
 * property but `.message` across the server-fn RPC boundary (memory: PER-187).
 */
export class PersonDebtValidationError extends Error {
  override readonly name = "PersonDebtValidationError"
  readonly statusCode = 422
}

const nameSchema = z.string().trim().min(1).max(120)
const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #RRGGBB hex value")
// Minor-unit magnitude as a positive digit-string (the wire form the account
// dialogs already use). `createTransactionForFamily` re-validates it as
// `positiveMoneyInputSchema`; this is the outer gate.
const amountSchema = z
  .string()
  .regex(/^\d+$/, "amount must be a string of minor-unit digits")
  .refine((value) => BigInt(value) > 0n, "amount must be positive")

interface ServerUser {
  id: string
}

// ============================================================================
// PERSON (Merchant kind="person")
// ============================================================================

export const createPersonInputSchema = z.object({
  name: nameSchema,
  color: hexColorSchema.nullable().optional(),
  idempotencyKey: uuidV7Schema,
})

export async function createPersonForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createPersonInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedMerchant> {
  const data = createPersonInputSchema.parse(rawData)
  // A person is just a Merchant with kind="person": one counterparty concept,
  // reusing the merchant create contract (idempotency + audit). PER-213 locked
  // "one contact = payee + debt-party": on a case-insensitive name collision we
  // REUSE the existing merchant (promoting a "business" payee to "person" if
  // needed) rather than hard-failing, so a payee you already transact with can
  // become a debt party without a duplicate-name error.
  return await createMerchantForFamily({
    data: {
      name: data.name,
      color: data.color ?? null,
      kind: "person",
      idempotencyKey: data.idempotencyKey,
    },
    familyId,
    user,
    runInTenantTransaction,
    reuseExisting: true,
  })
}

export const createPersonFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof createPersonInputSchema>) =>
    createPersonInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createPersonForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// ============================================================================
// ENSURE PERSON-DEBT ACCOUNT (create-if-absent, idempotent by lookup)
// ============================================================================

async function loadPersonOrThrow({
  familyId,
  user,
  personMerchantId,
  runInTenantTransaction,
}: {
  familyId: string
  user: ServerUser
  personMerchantId: string
  runInTenantTransaction: RunInTenantTransaction
}): Promise<{ id: string; name: string }> {
  const person = await runInTenantTransaction(familyId, user.id, (tx) =>
    tx.merchant.findFirst({
      where: { id: personMerchantId, familyId, kind: "person" },
      select: { id: true, name: true },
    })
  )
  if (!person) {
    throw new PersonDebtNotFoundError(
      `Person ${personMerchantId} not found for this family`
    )
  }
  return person
}

/**
 * Returns the id of THIS person's RECEIVABLE/LOAN account in `currency`,
 * creating it (opening balance 0, via the canonical account-create contract)
 * on first use. Idempotent by lookup: a replay finds the existing account and
 * never creates a second one, so a re-tried lend/borrow never forks the ledger.
 */
async function ensurePersonDebtAccountId({
  familyId,
  user,
  personName,
  personMerchantId,
  direction,
  currency,
  runInTenantTransaction,
}: {
  familyId: string
  user: ServerUser
  personName: string
  personMerchantId: string
  direction: PersonDebtDirection
  currency: string
  runInTenantTransaction: RunInTenantTransaction
}): Promise<string> {
  const accountType = DIRECTION_ACCOUNT_TYPE[direction]
  const existing = await runInTenantTransaction(familyId, user.id, (tx) =>
    tx.account.findFirst({
      where: {
        familyId,
        counterpartyMerchantId: personMerchantId,
        accountType,
        currency,
        deletedAt: null,
      },
      select: { id: true },
    })
  )
  if (existing) return existing.id

  const label =
    direction === "receivable"
      ? `Owed by ${personName}`
      : `Owed to ${personName}`
  const created = await createAccountForFamily({
    data: {
      accountType,
      counterpartyMerchantId: personMerchantId,
      currency,
      name: label,
      openingBalance: "0",
      idempotencyKey: createUuidV7(),
    },
    familyId,
    user,
    runInTenantTransaction,
  })
  return created.id
}

async function loadCashAccountCurrency({
  familyId,
  user,
  accountId,
  runInTenantTransaction,
}: {
  familyId: string
  user: ServerUser
  accountId: string
  runInTenantTransaction: RunInTenantTransaction
}): Promise<string> {
  const account = await runInTenantTransaction(familyId, user.id, (tx) =>
    tx.account.findFirst({
      where: { id: accountId, familyId, deletedAt: null },
      select: { currency: true },
    })
  )
  if (!account) {
    throw new PersonDebtNotFoundError(
      `Account ${accountId} not found for this family`
    )
  }
  return account.currency
}

// ============================================================================
// LEND / BORROW / REPAY (ordinary transfers via the ledger core)
// ============================================================================

export const recordLendInputSchema = z.object({
  personMerchantId: z.string().min(1),
  fromAccountId: z.string().min(1),
  amount: amountSchema,
  description: z.string().trim().min(1).max(200).optional(),
  date: z.coerce.date().optional(),
  idempotencyKey: uuidV7Schema,
})

export const recordBorrowInputSchema = z.object({
  personMerchantId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: amountSchema,
  description: z.string().trim().min(1).max(200).optional(),
  date: z.coerce.date().optional(),
  idempotencyKey: uuidV7Schema,
})

export const recordRepaymentInputSchema = z.object({
  personMerchantId: z.string().min(1),
  direction: z.enum(["receivable", "loan"]),
  cashAccountId: z.string().min(1),
  amount: amountSchema,
  description: z.string().trim().min(1).max(200).optional(),
  date: z.coerce.date().optional(),
  idempotencyKey: uuidV7Schema,
})

/**
 * The single flow behind lend / borrow / repay: resolve the person, pin the
 * currency to the chosen cash account, ensure that person's RECEIVABLE/LOAN
 * account exists (create-if-absent, idempotent by lookup), then post ONE
 * ordinary transfer between the cash account and the debt account. The transfer
 * `kind` (funds_movement / liability_draw / loan_payment) is DERIVED from the
 * two account types by the ledger core — never passed by this module. Every
 * public debt mutation is a thin wrapper that only picks `ensureDirection`,
 * whether cash is the source, and the default description.
 */
async function orchestrateDebtMovement({
  familyId,
  user,
  runInTenantTransaction,
  personMerchantId,
  cashAccountId,
  ensureDirection,
  cashIsSource,
  amount,
  date,
  description,
  describe,
  idempotencyKey,
}: {
  familyId: string
  user: ServerUser
  runInTenantTransaction: RunInTenantTransaction
  personMerchantId: string
  cashAccountId: string
  ensureDirection: PersonDebtDirection
  // true ⇒ cash → debt account (lend, repay-loan); false ⇒ debt account → cash
  // (borrow, repay-receivable).
  cashIsSource: boolean
  amount: string
  date: Date | undefined
  description: string | undefined
  describe: (personName: string) => string
  idempotencyKey: string
}) {
  const person = await loadPersonOrThrow({
    familyId,
    user,
    personMerchantId,
    runInTenantTransaction,
  })
  const currency = await loadCashAccountCurrency({
    familyId,
    user,
    accountId: cashAccountId,
    runInTenantTransaction,
  })
  const debtAccountId = await ensurePersonDebtAccountId({
    familyId,
    user,
    personName: person.name,
    personMerchantId: person.id,
    direction: ensureDirection,
    currency,
    runInTenantTransaction,
  })
  return await createTransactionForFamily({
    data: {
      type: "transfer",
      accountId: cashIsSource ? cashAccountId : debtAccountId,
      toAccountId: cashIsSource ? debtAccountId : cashAccountId,
      amount,
      description: description ?? describe(person.name),
      date: date ?? new Date(),
      idempotencyKey,
    },
    familyId,
    user,
    runInTenantTransaction,
  })
}

export async function recordLendForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordLendInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}) {
  const data = recordLendInputSchema.parse(rawData)
  // Lend: cash → RECEIVABLE (their debt to you grows).
  return await orchestrateDebtMovement({
    familyId,
    user,
    runInTenantTransaction,
    personMerchantId: data.personMerchantId,
    cashAccountId: data.fromAccountId,
    ensureDirection: "receivable",
    cashIsSource: true,
    amount: data.amount,
    date: data.date,
    description: data.description,
    describe: (name) => `Lent to ${name}`,
    idempotencyKey: data.idempotencyKey,
  })
}

export async function recordBorrowForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordBorrowInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}) {
  const data = recordBorrowInputSchema.parse(rawData)
  // Borrow: LOAN → cash (your debt to them grows; liability_draw is derived).
  return await orchestrateDebtMovement({
    familyId,
    user,
    runInTenantTransaction,
    personMerchantId: data.personMerchantId,
    cashAccountId: data.toAccountId,
    ensureDirection: "loan",
    cashIsSource: false,
    amount: data.amount,
    date: data.date,
    description: data.description,
    describe: (name) => `Borrowed from ${name}`,
    idempotencyKey: data.idempotencyKey,
  })
}

/**
 * Repayment is DELIBERATELY not routed through the create-if-absent path
 * (`ensurePersonDebtAccountId`): a repayment can only ever REDUCE an existing
 * debt, never open a new one. Reusing the create path let "Repayment received"
 * for a person with no receivable (or an overshoot) drive a RECEIVABLE negative
 * / a LOAN positive and trip the `account_normal_balance_sign` CHECK (PER-213).
 *
 * Guards (in order): the person and cash account must belong to the family; an
 * EXISTING debt account of the matching direction+currency must exist with a
 * non-zero balance; and the amount must not exceed the outstanding magnitude.
 * Exact settle-to-zero is allowed. Only then is the reversing transfer posted
 * through the same ledger core as every other flow.
 */
export async function recordRepaymentForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordRepaymentInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}) {
  const data = recordRepaymentInputSchema.parse(rawData)
  // Repay is the transfer OPPOSITE to the original debt:
  //   receivable repaid: RECEIVABLE → cash (they pay you back)
  //   loan repaid       : cash → LOAN       (you pay them back)
  const isReceivable = data.direction === "receivable"
  const person = await loadPersonOrThrow({
    familyId,
    user,
    personMerchantId: data.personMerchantId,
    runInTenantTransaction,
  })
  const currency = await loadCashAccountCurrency({
    familyId,
    user,
    accountId: data.cashAccountId,
    runInTenantTransaction,
  })

  const postTransfer = async (debtAccountId: string) =>
    await createTransactionForFamily({
      data: {
        type: "transfer",
        accountId: isReceivable ? debtAccountId : data.cashAccountId,
        toAccountId: isReceivable ? data.cashAccountId : debtAccountId,
        amount: data.amount,
        description:
          data.description ??
          (isReceivable
            ? `Repayment from ${person.name}`
            : `Repayment to ${person.name}`),
        date: data.date ?? new Date(),
        idempotencyKey: data.idempotencyKey,
      },
      familyId,
      user,
      runInTenantTransaction,
    })

  const accountType = DIRECTION_ACCOUNT_TYPE[data.direction]
  const debtAccount = await runInTenantTransaction(familyId, user.id, (tx) =>
    tx.account.findFirst({
      where: {
        familyId,
        counterpartyMerchantId: person.id,
        accountType,
        currency,
        deletedAt: null,
      },
      select: { id: true, balance: true },
    })
  )

  // Idempotency: a genuine retry re-sends the same key AFTER the balance was
  // already reduced (possibly to zero), so the guards below would wrongly reject
  // it. Detect the replay by the transaction row that already carries this key
  // and delegate straight to the ledger core, which returns the stored result
  // without touching balances again.
  if (debtAccount) {
    const alreadyPosted = await runInTenantTransaction(
      familyId,
      user.id,
      (tx) =>
        tx.transaction.findFirst({
          where: { familyId, idempotencyKey: data.idempotencyKey },
          select: { id: true },
        })
    )
    if (alreadyPosted) return await postTransfer(debtAccount.id)
  }

  const outstanding =
    debtAccount === null
      ? 0n
      : debtAccount.balance < 0n
        ? -debtAccount.balance
        : debtAccount.balance
  if (debtAccount === null || outstanding === 0n) {
    throw new PersonDebtValidationError(
      `No outstanding ${data.direction} for ${person.name} to repay`
    )
  }
  if (BigInt(data.amount) > outstanding) {
    throw new PersonDebtValidationError(
      `Repayment exceeds the ${formatCurrency(outstanding, currency)} outstanding`
    )
  }

  return await postTransfer(debtAccount.id)
}

export const recordLendFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordLendInputSchema>) =>
    recordLendInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordLendForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

export const recordBorrowFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordBorrowInputSchema>) =>
    recordBorrowInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordBorrowForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

export const recordRepaymentFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordRepaymentInputSchema>) =>
    recordRepaymentInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordRepaymentForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// ============================================================================
// READ — People & Debts view (ALL person contacts + net position; PER-213)
// ============================================================================

export interface PersonDebtAccountView {
  id: string
  name: string
  accountType: string
  currency: string
  // Signed minor units as a digit-string (RECEIVABLE >= 0, LOAN <= 0).
  balance: string
}

export interface PersonDebtCurrencyPosition {
  currency: string
  // Signed net across this person's accounts in `currency`. > 0 they owe you;
  // < 0 you owe them; 0 settled.
  net: string
}

export interface PersonDebtView {
  personId: string
  name: string
  color: string | null
  accounts: PersonDebtAccountView[]
  positions: PersonDebtCurrencyPosition[]
  // True iff EVERY currency position nets to zero (fully "Lunas").
  settled: boolean
}

export async function getPersonDebtsForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<PersonDebtView[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const [persons, accounts] = await Promise.all([
      tx.merchant.findMany({
        where: { familyId, kind: "person" },
        select: { id: true, name: true, color: true },
        orderBy: { name: "asc" },
      }),
      tx.account.findMany({
        where: {
          familyId,
          deletedAt: null,
          counterpartyMerchantId: { not: null },
        },
        select: {
          id: true,
          name: true,
          accountType: true,
          currency: true,
          balance: true,
          counterpartyMerchantId: true,
        },
        orderBy: { name: "asc" },
      }),
    ])

    const accountsByPerson = new Map<string, typeof accounts>()
    for (const account of accounts) {
      const key = account.counterpartyMerchantId
      if (key === null) continue
      const bucket = accountsByPerson.get(key) ?? []
      bucket.push(account)
      accountsByPerson.set(key, bucket)
    }

    const views: PersonDebtView[] = []
    for (const person of persons) {
      const linked = accountsByPerson.get(person.id) ?? []
      // PER-213: list EVERY person contact, including those with no debt yet
      // (empty accounts/positions), so a freshly-added person never vanishes.
      // The view renders "No debts yet" for them; `settled` stays false so they
      // are not styled as "Settled" (that badge is reserved for people who HAD
      // a debt that netted back to zero).

      const netByCurrency = new Map<string, bigint>()
      for (const account of linked) {
        netByCurrency.set(
          account.currency,
          (netByCurrency.get(account.currency) ?? 0n) + account.balance
        )
      }
      const positions: PersonDebtCurrencyPosition[] = [
        ...netByCurrency.entries(),
      ]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, net]) => ({ currency, net: net.toString() }))

      views.push({
        personId: person.id,
        name: person.name,
        color: person.color,
        accounts: linked.map((account) => ({
          id: account.id,
          name: account.name,
          accountType: account.accountType,
          currency: account.currency,
          balance: account.balance.toString(),
        })),
        positions,
        // Settled (Lunas) only when there IS a debt history that nets to zero;
        // a person with no positions is "No debts yet", not settled.
        settled:
          positions.length > 0 &&
          positions.every((position) => BigInt(position.net) === 0n),
      })
    }
    return views
  })
}

export const getPersonDebtsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getPersonDebtsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ============================================================================
// READ — all persons (for the "record debt" picker, incl. those with no debt
// account yet). `getPersonDebtsFn` intentionally lists only persons WITH
// linked accounts; this one lists every person contact.
// ============================================================================

export interface PersonView {
  id: string
  name: string
  color: string | null
}

export async function getPersonsForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<PersonView[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const persons = await tx.merchant.findMany({
      where: { familyId, kind: "person" },
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
    })
    return persons
  })
}

export const getPersonsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getPersonsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
