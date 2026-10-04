import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test"
import {
  createAccountForFamily,
  enableHoldingsTrackingForFamily,
} from "@/server/accounts"
import {
  bulkCreateTransactionsForFamily,
  createTransactionForFamily,
  deleteTransactionForFamily,
  IdempotencyConflictError,
  TransactionGoneError,
} from "@/server/transactions"
import {
  computeCanonicalBalance,
  computeCanonicalBalanceAsOf,
  createValuationForFamily,
  detectBalanceDriftForFamily,
  rebuildAccountBalanceForFamily,
} from "@/server/valuations"
import { TenantReferenceError } from "@/server/validation/tenant-references"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-208 — PROPERTY-BASED LEDGER INVARIANT HARNESS (tracer-bullet slice).
//
// The existing integration suite is *example-based*: each test drives one
// hand-picked scenario we already thought of. That is excellent for regressions
// but blind to the sequences nobody imagined. This harness is different: it
// GENERATES thousands of random operation sequences (create expense / income /
// transfer, then delete some) against a REAL Postgres tenant and asserts a core
// invariant holds after every sequence. When it fails, fast-check shrinks to the
// minimal reproducing sequence and prints a deterministic seed — so a machine-
// found bug becomes a one-line repro, not a mystery.
//
// This first slice proves ONE invariant end-to-end (the "tracer bullet" per
// CLAUDE.md §C): CONSERVATION. Slice 2 (this file) adds IDEMPOTENCY REPLAY,
// Slice 3 DELETE REPLAY, and Slice 4 NO FALSE DRIFT (valuation accounts) to the
// same rig; later slices extend it further to tenant isolation and concurrency.
//
// ── CONSERVATION ────────────────────────────────────────────────────────────
// For a single family, single currency, on transaction-flow accounts:
//
//     Σ (account.balance)  ==  Σ (transaction.amount WHERE deletedAt IS NULL)
//
// Both sides are read straight from Postgres — the assertion is agnostic to how
// the core signs amounts. It holds because `applyAccountBalanceDelta` increments
// an account's balance by exactly the signed amount it stores on the row; a
// transfer writes two legs (−x on source, +x on dest) that each move their
// account and together sum to zero. A soft-delete reverses the stored delta AND
// hides the row (deletedAt set), so both sides drop in lockstep. If a mutation
// ever moves a balance without a matching stored row (or vice-versa) — the exact
// shape of PER-196 — this invariant catches it.
//
// Scope guards that keep the invariant well-defined for THIS slice:
//   • one currency (IDR) so Σ across rows is meaningful;
//   • transaction_flow (DEPOSITORY) accounts only — valuation-tracked accounts
//     SET rather than increment their balance and get their own later slice;
//   • the raw `transaction` table is summed (NOT the filtered ledger view) so
//     hidden transfer inflow legs are counted — they are real balance movers.
//
// Runtime: each op is a real DB round-trip, so numRuns/maxLength are kept modest
// and are the knobs to turn when we want a deeper (slower) sweep in CI nightly.
//
// ── IDEMPOTENCY REPLAY (Slice 2) ────────────────────────────────────────────
//
// The user-reported bug class this slice hunts: "I pressed Save, nothing
// seemed to happen, so I pressed it again — and the transaction posted
// twice" (network hang, browser hang, double click). The fuzzer now weaves
// REPLAY ops into the same random sequences and asserts a three-clause
// contract after every one of them:
//
//   C1 — FAITHFUL REPLAY (same key + byte-identical payload) is a pure read:
//        it returns EXACTLY what the first call returned (not null, not an
//        error — a retry must be invisible to the user), and it writes
//        nothing: no new row, no balance movement, no second audit row, no
//        extra bookkeeping in `Transfer` / `IdempotencyRecord`.
//        QUALIFIER the fuzzer itself forced (seed 1647655216): the replay
//        returns the CURRENT persisted row, so if a LATER op in the sequence
//        legitimately changed that row (a soft-delete), the response reflects
//        that change. Response equality is therefore asserted only while the
//        row is untouched since the original call — the user's double-submit
//        scenario — while "the ledger did not move" is asserted ALWAYS.
//   C2 — CONFLICT (same key + mutated payload, e.g. amount + 1n) throws
//        `IdempotencyConflictError` BEFORE touching anything; ledger state is
//        bit-identical before and after, asserted first because "the state
//        never moved" is the load-bearing half of the guarantee.
//   C3 — Both mutation endpoints the sequence generator can reach are
//        journaled and replayed: create (expense / income / transfer, via
//        `replayIdempotentTransaction`) and delete (via
//        `replayIdempotentEndpointResponse`).
//
// Deliberately OUT of this slice (later slices own them): parallel replay of
// the same key (Slice 6 — concurrency), and bulk-delete replay (ADR-0033 pins
// bulk as all-or-nothing; example-based 410 coverage already lives in
// bulk-mutation-parity.integration.ts). Every replay op is journaled from a
// mutation that actually succeeded, so the invariant is only ever asserted
// over real, applied state.
//
// ── DELETE REPLAY (Slice 3) ──────────────────────────────────────────────────
//
// ADR-0032 §5: a NEW logical request — a fresh idempotency key — against an
// already-soft-deleted transaction returns 410 Gone and must NEVER reverse a
// balance a second time; only the ORIGINAL key replays `{ success: true }`
// (Slice 2, C3). Deleting twice with the same key was proven in Slice 2;
// this slice owns the DIFFERENT-key path, which the generator previously
// could not even reach: `delete` spied its id out of the live list, so a dead
// row was never re-targeted.
//
// The rig reaches that path two ways:
//
//   • a random `deleteAgain` op re-issues DELETE under a FRESH key against a
//     row an earlier op already deleted. It is asserted inline, OUTSIDE the
//     domain-rejection guard, for the same reason replay ops are: a thrown
//     TransactionGoneError IS the passing contract here, and the guard's
//     rejection regex would otherwise swallow it (or rethrow it) instead of
//     judging it;
//   • a deterministic TRANSFER seed: a transfer's reversal moves two accounts
//     in OPPOSITE directions, so a double-reversal nets to ZERO in Σ balances
//     — CONSERVATION alone is blind to it. That is why `ledgerSnapshot` now
//     carries PER-ACCOUNT balances, and the seed pins ±amount exactly once.
//
// Coverage is a gate, not a lottery (Slice 1's "verified to have teeth"):
// `withDeleteReplayProbe` guarantees every generated sequence actually FIRES
// the probe, and `deleteAgainShots > 0` is asserted after `fc.assert`.
//
// ── NO FALSE DRIFT — VALUATION ACCOUNTS (Slice 4) ───────────────────────────
//
// The PER-196 class this slice hunts: a transfer touching a valuation-tracked
// account (balanceSource="valuation") must SET that account's balance from its
// valuation series — latest valuation wins (ADR-0043 §5) — never INCREMENT it
// like a cash account. Increment instead of SET and the stored balance silently
// detaches from the series: money that exists nowhere, a PER-196-class hidden
// leg. The PER-270 anchor harness next door already proves drift-freedom for
// transaction_flow accounts under back-dated activity; but it never CREATES a
// valuation account, and its canonical assertion deliberately skips
// balanceSource !== "transaction_flow" (see `assertCanonicalEqualsMaterialized`).
// This slice closes exactly that hole:
//
//   • fixture: ONE flow account via the REAL createAccountForFamily — its
//     opening valuation is written unconditionally at creation (ADR-0034 §3),
//     so the as-of date is pushed to day −40 to sit before every row this rig
//     ever posts (otherwise the afterAnchor rule would ABSORB back-dated rows
//     and conservation would be false-by-design) — plus ONE INVESTMENT account
//     flipped to valuation through the real `enableHoldingsTrackingForFamily`
//     (which seeds the balance-preserving anchor, PER-266);
//   • ops: `contribution` (flow → valuation) and `withdrawal` (valuation →
//     flow) valuation-linked transfers carrying an explicit `newValuationValue`
//     override (ADR-0048 §1's editable prefill) drifted ±1..5_000 from
//     `latest ∓ cash` so a blind increment can NEVER coincide with the correct
//     SET; back-dated expense/income on the flow account; and `delete`, the
//     symmetric reversal path (ADR-0048 §4);
//   • three invariants after EVERY sequence:
//       1. CONSERVATION scoped to transaction_flow accounts — a valuation-
//          linked transfer has ONE Transaction leg (the cash side), so
//          Σ flow balances == Σ live rows stays exact;
//       2. the valuation account's balance == its latest live Valuation.value
//          (valuationDate desc, createdAt desc, id desc — re-derived from the
//          raw series here as an INDEPENDENT witness, not via production's
//          resolver) — the direct statement of "never incremented";
//       3. `detectBalanceDriftForFamily` reports ZERO MATERIALIZATION drift —
//          the ticket's literal sentence.
//
// Coverage is again a gate, not a lottery: `withValuationProbe` guarantees
// every sequence contains at least one `contribution` (unskippable — no
// negative override is ever constructed, the cash side is funded), and
// `valuationTransferShots > 0` is asserted after `fc.assert`.

const NUM_RUNS = 20
const MAX_OPS = 8
const NUM_ACCOUNTS = 3
// Opening float seeded as a real income row per account, so ordinary expenses
// and transfers rarely drive a balance negative (fewer domain rejections =>
// more sequences actually exercise the core). Counted in Σ amounts, so it does
// not perturb the invariant.
const OPENING_FLOAT = 100_000_000n

let harness: IntegrationHarness
let factories: TestFactories

beforeAll(async () => {
  harness = await createIntegrationHarness()
  factories = createTestFactories(harness)
})

afterAll(async () => {
  await harness.teardown()
})

// Abstract operations. Account/transaction selectors are RELATIVE indices
// resolved against live runtime state at apply time — fast-check generates the
// shape, the applier binds it to real ids.
type LedgerOp =
  | { kind: "expense"; account: number; amount: bigint }
  | { kind: "income"; account: number; amount: bigint }
  | { kind: "transfer"; from: number; toOffset: number; amount: bigint }
  | { kind: "delete"; pick: number }
  // Slice 2: re-issue a JOURNALED mutation — either verbatim (C1) or with a
  // mutated payload under the same key (C2). `pick` selects the journal entry
  // at apply time, exactly like `delete`'s selector against live rows.
  | { kind: "replay"; mode: "faithful" | "conflict"; pick: number }
  // Slice 3: re-issue DELETE against a row an earlier op ALREADY deleted,
  // under a FRESH key — ADR-0032 §5's "new logical request" surface. The
  // passing contract is 410 Gone with zero state movement, so this op's
  // assertion lives OUTSIDE the domain-rejection guard. `pick` selects from
  // the dead-row list at apply time.
  | { kind: "deleteAgain"; pick: number }

const amountArb = fc.bigInt({ min: 1n, max: 1_000_000n })
const accountArb = fc.nat({ max: NUM_ACCOUNTS - 1 })
const pickArb = fc.nat({ max: 10_000 })

// Weighted so sequences still BUDGET money (3:3:3 for the balance-movers) while
// delete (2) and faithful replay (2) stay frequent enough to actually land on a
// non-empty journal inside an 8-op sequence. Conflict replay is weighted 1:
// it costs the same two snapshots as a faithful replay but returns less signal
// per run (the hash-mismatch path is also covered by the example-based
// idempotency suites), and this file must not become the slow-test problem
// PER-270 warned about — measured ~65-70s for CONSERVATION at NUM_RUNS=20
// after Slice 2. `deleteAgain` is weighted 1 for the same cost reason (two
// snapshots per shot); COVERAGE is not left to this weight — every sequence
// is guaranteed at least one shot by `withDeleteReplayProbe` below.
const opArb: fc.Arbitrary<LedgerOp> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("expense" as const),
      account: accountArb,
      amount: amountArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("income" as const),
      account: accountArb,
      amount: amountArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("transfer" as const),
      from: accountArb,
      // 1..NUM_ACCOUNTS-1, added modulo count => destination is never the source.
      toOffset: fc.integer({ min: 1, max: NUM_ACCOUNTS - 1 }),
      amount: amountArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      pick: pickArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("replay" as const),
      mode: fc.constant("faithful" as const),
      pick: pickArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("replay" as const),
      mode: fc.constant("conflict" as const),
      pick: pickArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("deleteAgain" as const),
      pick: pickArb,
    }),
  }
)

// Shots fired by `deleteAgain` across the whole property run — asserted > 0
// after `fc.assert` so "the delete-replay contract was actually exercised"
// can never be green by luck.
let deleteAgainShots = 0

/** Post-processing that makes delete-replay coverage a GATE, not a lottery.
 *
 * A `deleteAgain` is only meaningful once a row is dead, so the probe is
 * spliced deterministically right after the LAST delete op of the sequence.
 * When the generator produced no delete at all, a minimal
 * [expense → delete → deleteAgain] tail is appended instead: the expense is
 * tiny (1.000 IDR against a 100M float, so it can never be domain-rejected),
 * which guarantees the delete has a live row to hit and the probe therefore
 * always executes. Result: every run contributes at least one shot, and the
 * `deleteAgainShots > 0` gate is structurally satisfiable — not a
 * 1-in-many-runs probability. */
function withDeleteReplayProbe(ops: LedgerOp[]): LedgerOp[] {
  const next = [...ops]
  const lastDelete = next.map((op) => op.kind === "delete").lastIndexOf(true)
  if (lastDelete >= 0) {
    next.splice(lastDelete + 1, 0, { kind: "deleteAgain", pick: 0 })
    return next
  }
  next.push(
    { kind: "expense", account: 0, amount: 1_000n },
    { kind: "delete", pick: 0 },
    { kind: "deleteAgain", pick: 0 }
  )
  return next
}

const sequenceArb: fc.Arbitrary<LedgerOp[]> = fc
  .array(opArb, { maxLength: MAX_OPS })
  .map(withDeleteReplayProbe)

interface Fixture {
  familyId: string
  user: { id: string; familyId?: string | null }
  accountIds: string[]
  expenseCategoryId: string
  incomeCategoryId: string
}

async function seedFixture(): Promise<Fixture> {
  const owner = await factories.createAuthenticatedOnboardedUser()
  const familyId = owner.family.id
  const user = owner.user

  const accountIds: string[] = []
  for (let i = 0; i < NUM_ACCOUNTS; i++) {
    const account = await factories.createAccount({
      familyId,
      name: `Acc ${i}`,
      accountType: "DEPOSITORY",
      currency: "IDR",
      balance: 0n,
    })
    accountIds.push(account.id)
  }

  const expenseCategory = await factories.createCategory({
    familyId,
    name: "Fuzz Expense",
    type: "expense",
  })
  const incomeCategory = await factories.createCategory({
    familyId,
    name: "Fuzz Income",
    type: "income",
  })

  const fixture: Fixture = {
    familyId,
    user,
    accountIds,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }

  // Opening float per account, posted as a genuine income row.
  for (const accountId of accountIds) {
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId,
        amount: OPENING_FLOAT,
        categoryId: incomeCategory.id,
        currency: "IDR",
        date: new Date("2026-01-01T00:00:00.000Z"),
        description: "Opening float",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })
  }

  return fixture
}

/** A domain rejection rolls the tenant tx back (no state change), so skipping
 * the op keeps the invariant well-defined over the successfully-applied subset.
 * A NON-domain error (a real crash) is rethrown so the property fails on it. */
function isExpectedDomainRejection(error: unknown): boolean {
  const name = error instanceof Error ? error.constructor.name : ""
  const message = error instanceof Error ? error.message : String(error)
  return (
    name === "ValuationError" ||
    name === "ValuationAccountLedgerError" ||
    name === "HoldingsAccountLedgerError" ||
    name === "TenantReferenceError" ||
    name === "AccountNotFoundError" ||
    name === "AccountValidationError" ||
    name === "IdempotencyConflictError" ||
    name === "ValuationLinkedTransferUnsupportedError" ||
    name === "HoldingsTradeDeleteUnsupportedError" ||
    /balance|negative|insufficient|constraint|check|provenance|type|currency|not found|access denied/i.test(
      message
    )
  )
}

async function applyOps(fixture: Fixture, ops: LedgerOp[]): Promise<void> {
  const { familyId, user, accountIds } = fixture
  const liveTxIds: string[] = []
  // Ids a delete has already taken off the board (Slice 3) — the ONLY rows a
  // `deleteAgain` op may target.
  const deletedTxIds: string[] = []
  // Every mutation that SUCCEEDED, kept replayable verbatim (Slice 2). Only
  // applied state is ever journaled — a rejected op leaves nothing to replay.
  const journal: ReplayableMutation[] = []

  for (const op of ops) {
    // Replay ops run OUTSIDE the domain-rejection guard below, deliberately:
    // a failed `expect` here IS the property failing, and the guard's message
    // regex (…|balance|…|check|…) would happily swallow it as an "expected
    // rejection" — turning a red test silently green.
    if (op.kind === "replay") {
      if (journal.length === 0) continue
      const entry = journal[op.pick % journal.length]
      if (op.mode === "faithful") await assertFaithfulReplay(fixture, entry)
      else await assertConflictingReplay(fixture, entry)
      continue
    }

    // Slice 3 — same placement rationale as replay ops, doubled: here the
    // PASSING outcome is a thrown TransactionGoneError, so inside the guard it
    // would not merely risk being swallowed as an "expected rejection", it
    // would be misjudged instead of asserted.
    if (op.kind === "deleteAgain") {
      if (deletedTxIds.length === 0) continue
      await assertNoDoubleReversal(
        fixture,
        deletedTxIds[op.pick % deletedTxIds.length]
      )
      deleteAgainShots++
      continue
    }

    try {
      if (op.kind === "delete") {
        if (liveTxIds.length === 0) continue
        const idx = op.pick % liveTxIds.length
        const id = liveTxIds[idx]
        const deleteKey = factories.createIdempotencyKey()
        const result = await deleteTransactionForFamily({
          id,
          idempotencyKey: deleteKey,
          familyId,
          user,
        })
        // A soft-delete REWRITES this row (deletedAt, updatedAt), so any
        // create already journaled for it can no longer promise the ORIGINAL
        // response on replay — only an unmoved ledger. Mark before pushing
        // the delete entry so the delete's own `{ success: true }` contract
        // (immutable, replayed from IdempotencyRecord) stays strict.
        for (const entry of journal) {
          if (entry.entityId === id) entry.rowTouchedLater = true
        }
        journal.push(journalDelete(fixture, id, deleteKey, result))
        liveTxIds.splice(idx, 1)
        deletedTxIds.push(id)
        continue
      }

      const id = factories.createIdempotencyKey()
      const createKey = factories.createIdempotencyKey()
      if (op.kind === "transfer") {
        const from = op.from % accountIds.length
        const to = (from + op.toOffset) % accountIds.length
        const payload = {
          id,
          idempotencyKey: createKey,
          accountId: accountIds[from],
          toAccountId: accountIds[to],
          amount: op.amount,
          currency: "IDR",
          date: new Date("2026-02-01T00:00:00.000Z"),
          description: "Fuzz transfer",
          type: "transfer",
          isSplit: false,
          status: "CLEARED",
        }
        const result = await createTransactionForFamily({
          data: payload,
          familyId,
          user,
        })
        journal.push(journalCreate(fixture, payload, createKey, result))
      } else {
        const payload = {
          id,
          idempotencyKey: createKey,
          accountId: accountIds[op.account % accountIds.length],
          amount: op.amount,
          categoryId:
            op.kind === "expense"
              ? fixture.expenseCategoryId
              : fixture.incomeCategoryId,
          currency: "IDR",
          date: new Date("2026-02-01T00:00:00.000Z"),
          description: `Fuzz ${op.kind}`,
          type: op.kind,
          isSplit: false,
          status: "CLEARED",
        }
        const result = await createTransactionForFamily({
          data: payload,
          familyId,
          user,
        })
        journal.push(journalCreate(fixture, payload, createKey, result))
      }
      liveTxIds.push(id)
    } catch (error) {
      if (isExpectedDomainRejection(error)) continue
      throw error
    }
  }
}

async function readSums(
  familyId: string
): Promise<{ balances: bigint; amounts: bigint }> {
  const accounts = await harness.withFamily(familyId, (tx) =>
    tx.account.findMany({ select: { balance: true } })
  )
  const transactions = await harness.withFamily(familyId, (tx) =>
    tx.transaction.findMany({
      where: { deletedAt: null },
      select: { amount: true },
    })
  )
  return {
    balances: accounts.reduce((sum, a) => sum + a.balance, 0n),
    amounts: transactions.reduce((sum, t) => sum + t.amount, 0n),
  }
}

// ── SLICE 2 — idempotency replay rig ────────────────────────────────────────

/** A mutation that SUCCEEDED and can therefore be re-issued. The closures
 * capture the exact payload/key that was used, so "identical payload" is
 * identical BY CONSTRUCTION — the fuzzer never rebuilds one by hand, which is
 * the only way a faithful-replay assertion can be trusted. */
interface ReplayableMutation {
  key: string
  /** Whatever the first (successful) call returned — C1's response contract. */
  result: unknown
  /** The row this mutation created/removed, so a later delete of the SAME row
   * can be detected (see `rowTouchedLater`). */
  entityId: string
  /** Flipped when a subsequent op mutates the entity: the response contract
   * then compares against current state, not the original response. */
  rowTouchedLater: boolean
  replay: () => Promise<unknown>
  /** Same key, mutated payload — C2's conflict trigger. */
  replayDifferentPayload: () => Promise<unknown>
}

// The journal must keep the COMPLETE payload (a conflict replay re-sends it
// with one field changed), so the payload type is carried generically from the
// call site instead of being re-declared here — `createTransactionForFamily`
// validates `data: unknown` against its Zod schema at runtime anyway.
function journalCreate<
  T extends { id: string; idempotencyKey: string; amount: bigint },
>(
  fixture: Fixture,
  payload: T,
  key: string,
  result: unknown
): ReplayableMutation {
  return {
    key,
    result,
    entityId: payload.id,
    rowTouchedLater: false,
    replay: () =>
      createTransactionForFamily({
        data: payload,
        familyId: fixture.familyId,
        user: fixture.user,
      }),
    // The real-world collision: the form was edited (one minor unit more) but
    // the browser resubmitted the OLD key — must conflict, never post twice.
    replayDifferentPayload: () =>
      createTransactionForFamily({
        data: { ...payload, amount: payload.amount + 1n },
        familyId: fixture.familyId,
        user: fixture.user,
      }),
  }
}

function journalDelete(
  fixture: Fixture,
  id: string,
  key: string,
  result: unknown
): ReplayableMutation {
  return {
    key,
    result,
    entityId: id,
    rowTouchedLater: false,
    replay: () =>
      deleteTransactionForFamily({
        id,
        idempotencyKey: key,
        familyId: fixture.familyId,
        user: fixture.user,
      }),
    // A different target under the same key hashes differently, so the
    // endpoint must reject before it can reverse any balance a second time.
    replayDifferentPayload: () =>
      deleteTransactionForFamily({
        id: factories.createIdempotencyKey(),
        idempotencyKey: key,
        familyId: fixture.familyId,
        user: fixture.user,
      }),
  }
}

/** EVERYTHING a replay could plausibly have touched, read straight from
 * Postgres in one tenant-scoped pass: balances, the live-amount sum (the C1/C2
 * conservation halves), raw row counts (a hidden duplicate row would show up
 * even if its balance delta were somehow zero), the Transfer and
 * IdempotencyRecord bookkeeping tables, and the audit rows THIS key owns.
 *
 * `accountBalances` is the per-account form of `balances` (Slice 3): Σ across
 * accounts NETS TO ZERO for a transfer reversal, so a transfer
 * double-reversal — source +x again, destination −x again — is invisible to
 * the sum but obvious here. Per-account balances are the direct statement of
 * "no account moved twice"; the sum alone is not. */
async function ledgerSnapshot(
  fixture: Fixture,
  auditKey: string
): Promise<{
  balances: bigint
  accountBalances: Array<readonly [string, bigint]>
  amounts: bigint
  rows: number
  transfers: number
  idempotencyRecords: number
  audits: number
}> {
  return await harness.withFamily(fixture.familyId, async (tx) => {
    const accounts = await tx.account.findMany({
      select: { id: true, balance: true },
      orderBy: { id: "asc" },
    })
    const liveTransactions = await tx.transaction.findMany({
      where: { deletedAt: null },
      select: { amount: true },
    })
    const rows = await tx.transaction.count()
    const transfers = await tx.transfer.count()
    const idempotencyRecords = await tx.idempotencyRecord.count()
    const audits = await tx.auditLog.count({
      where: { idempotencyKey: auditKey },
    })
    return {
      balances: accounts.reduce((sum, account) => sum + account.balance, 0n),
      accountBalances: accounts.map(
        (account) => [account.id, account.balance] as const
      ),
      amounts: liveTransactions.reduce((sum, t) => sum + t.amount, 0n),
      rows,
      transfers,
      idempotencyRecords,
      audits,
    }
  })
}

/** Direct read of ONE account's balance out of a snapshot — the shape the
 * transfer seed needs to pin ±amount on each leg individually. */
function balanceOf(
  snapshot: Awaited<ReturnType<typeof ledgerSnapshot>>,
  accountId: string
): bigint {
  const entry = snapshot.accountBalances.find(([id]) => id === accountId)
  if (!entry) throw new Error(`Account ${accountId} missing from snapshot`)
  return entry[1]
}

/** C1: a retry must be invisible — same ledger, and (unless a later op
 * legitimately rewrote the row in between) the same response. */
async function assertFaithfulReplay(
  fixture: Fixture,
  entry: ReplayableMutation
): Promise<void> {
  const before = await ledgerSnapshot(fixture, entry.key)
  let result: unknown = null
  let thrown: unknown = null
  try {
    result = await entry.replay()
  } catch (error) {
    thrown = error
  }
  const after = await ledgerSnapshot(fixture, entry.key)

  // Order is the argument: prove the ledger never moved FIRST (that is the
  // guarantee money rests on), then judge what the user's retry would see.
  expect(after).toEqual(before)
  expect(thrown).toBeNull()
  // A replay returns the CURRENT row, not a cached one — so when a later op
  // (a soft-delete of the same row) legitimately changed it, the response
  // differs from the original *by design*, and demanding equality here would
  // encode a wrong contract. The double-submit scenario has no such op, so
  // untouched rows still get the strict comparison.
  if (!entry.rowTouchedLater) {
    expect(result).toEqual(entry.result)
  }
}

/** C2: same key, different payload → 409 conflict, state untouched. */
async function assertConflictingReplay(
  fixture: Fixture,
  entry: ReplayableMutation
): Promise<void> {
  const before = await ledgerSnapshot(fixture, entry.key)
  let thrown: unknown = null
  try {
    await entry.replayDifferentPayload()
  } catch (error) {
    thrown = error
  }
  const after = await ledgerSnapshot(fixture, entry.key)

  // Asserted first: even if the error type were wrong, "nothing moved" must
  // hold unconditionally — a partial write here is the catastrophic case.
  expect(after).toEqual(before)
  expect(thrown).toBeInstanceOf(IdempotencyConflictError)
}

// ── SLICE 3 — delete replay (fresh key against a dead row) ──────────────────

/** ADR-0032 §5's "new logical request": DELETE re-issued under a FRESH key
 * against a row a previous op already soft-deleted. The passing contract is
 * 410 `TransactionGoneError` with the ledger bit-identical — per-account
 * balances included, because a transfer double-reversal nets to zero in Σ and
 * would slip past the sums.
 *
 * Order is the argument (same discipline as `assertFaithfulReplay`): prove
 * NOTHING moved first — that is the guarantee money rests on — then judge
 * what the caller saw. */
async function assertNoDoubleReversal(
  fixture: Fixture,
  id: string
): Promise<void> {
  const freshKey = factories.createIdempotencyKey()
  const before = await ledgerSnapshot(fixture, freshKey)
  let thrown: unknown = null
  try {
    await deleteTransactionForFamily({
      id,
      idempotencyKey: freshKey,
      familyId: fixture.familyId,
      user: fixture.user,
    })
  } catch (error) {
    thrown = error
  }
  const after = await ledgerSnapshot(fixture, freshKey)

  expect(after).toEqual(before)
  expect(thrown).toBeInstanceOf(TransactionGoneError)
}

describe("ledger invariants (property-based, real Postgres) — PER-208", () => {
  test("CONSERVATION: Σ balances == Σ signed amounts across random op sequences", async () => {
    deleteAgainShots = 0
    await fc.assert(
      fc
        .asyncProperty(sequenceArb, async (ops) => {
          const fixture = await seedFixture()
          await applyOps(fixture, ops)
          const { balances, amounts } = await readSums(fixture.familyId)
          expect(balances).toBe(amounts)
        })
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_RUNS }
    )
    // Coverage gate (Slice 3): the delete-replay contract above must have
    // been FIRING during this run — a property that never executed its probe
    // is green for the wrong reason.
    expect(deleteAgainShots).toBeGreaterThan(0)
  })

  // ------------------------------------------------------------------------
  // Deterministic regression seeds (the random property above owns coverage;
  // these keep the ORIGINAL bugs readable as one-liners). Slice 2 owns the
  // first two; Slice 3 owns the transfer delete-replay seed.
  // ------------------------------------------------------------------------

  test("REGRESSION — double submit: the same form posted twice (network hang) creates ONE transaction", async () => {
    await harness.reset()
    const fixture = await seedFixture()
    const key = factories.createIdempotencyKey()
    const payload = {
      id: factories.createIdempotencyKey(),
      idempotencyKey: key,
      accountId: fixture.accountIds[0],
      amount: 42_500n,
      categoryId: fixture.expenseCategoryId,
      currency: "IDR",
      date: new Date("2026-03-04T00:00:00.000Z"),
      description: "Double-submit regression",
      type: "expense",
      isSplit: false,
      status: "CLEARED",
    }

    const first = await createTransactionForFamily({
      data: payload,
      familyId: fixture.familyId,
      user: fixture.user,
    })
    const afterFirst = await ledgerSnapshot(fixture, key)

    // The real report behind this ticket: the first click looked like nothing
    // happened (network/browser hang), so the form went out again — identical
    // payload, identical key. It must land like a no-op.
    const second = await createTransactionForFamily({
      data: payload,
      familyId: fixture.familyId,
      user: fixture.user,
    })
    const afterSecond = await ledgerSnapshot(fixture, key)

    expect(second).toEqual(first) // C1: the retry is invisible to the user
    expect(afterSecond).toEqual(afterFirst) // C1: not one byte of ledger moved
    expect(afterSecond.audits).toBe(afterFirst.audits) // no second audit row

    const rowsWithKey = await harness.withFamily(fixture.familyId, (tx) =>
      tx.transaction.count({ where: { idempotencyKey: key } })
    )
    expect(rowsWithKey).toBe(1)

    // Same key, edited amount → conflict, and still zero mutation.
    let conflict: unknown = null
    try {
      await createTransactionForFamily({
        data: { ...payload, amount: 42_501n },
        familyId: fixture.familyId,
        user: fixture.user,
      })
    } catch (error) {
      conflict = error
    }
    expect(conflict).toBeInstanceOf(IdempotencyConflictError)
    expect(await ledgerSnapshot(fixture, key)).toEqual(afterSecond)
  })

  test("REGRESSION — delete fired twice with the SAME key reverses the balance exactly once", async () => {
    await harness.reset()
    const fixture = await seedFixture()
    const created = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: fixture.accountIds[0],
        amount: 7_700n,
        categoryId: fixture.expenseCategoryId,
        currency: "IDR",
        date: new Date("2026-03-05T00:00:00.000Z"),
        description: "Delete-twice regression",
        type: "expense",
        isSplit: false,
        status: "CLEARED",
      },
      familyId: fixture.familyId,
      user: fixture.user,
    })

    const deleteKey = factories.createIdempotencyKey()
    const beforeDelete = await ledgerSnapshot(fixture, deleteKey)

    const firstDelete = await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: deleteKey,
      familyId: fixture.familyId,
      user: fixture.user,
    })
    const afterFirst = await ledgerSnapshot(fixture, deleteKey)
    const secondDelete = await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: deleteKey,
      familyId: fixture.familyId,
      user: fixture.user,
    })
    const afterSecond = await ledgerSnapshot(fixture, deleteKey)

    // Reversed exactly once: deleting the 7.700 expense hands back exactly
    // its magnitude — no more (a second reversal would show 15.400).
    expect(afterFirst.balances - beforeDelete.balances).toBe(7_700n)
    expect(secondDelete).toEqual(firstDelete) // C1: same { success: true }
    expect(afterSecond).toEqual(afterFirst) // no second reversal, ever
  })

  test("REGRESSION — delete replay: a FRESH key on an already-deleted transfer reverses nothing twice", async () => {
    await harness.reset()
    const fixture = await seedFixture()
    const [sourceId, destId] = fixture.accountIds
    const created = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: sourceId,
        toAccountId: destId,
        amount: 9_900n,
        currency: "IDR",
        date: new Date("2026-03-06T00:00:00.000Z"),
        description: "Delete-replay transfer regression",
        type: "transfer",
        isSplit: false,
        status: "CLEARED",
      },
      familyId: fixture.familyId,
      user: fixture.user,
    })

    // First press, real ticket (firstKey): one reversal, proven PER ACCOUNT.
    // A transfer nets to ZERO in Σ balances, so the sums in `ledgerSnapshot`
    // cannot tell one reversal from two — the per-account legs are the only
    // honest witness, and this is exactly why the snapshot carries them.
    const firstKey = factories.createIdempotencyKey()
    const beforeDelete = await ledgerSnapshot(fixture, firstKey)
    const firstDelete = await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: firstKey,
      familyId: fixture.familyId,
      user: fixture.user,
    })
    const afterFirst = await ledgerSnapshot(fixture, firstKey)

    expect(firstDelete).toEqual({ success: true })
    // Source got its 9.900 back; destination gave back the 9.900 it received.
    expect(
      balanceOf(afterFirst, sourceId) - balanceOf(beforeDelete, sourceId)
    ).toBe(9_900n)
    expect(
      balanceOf(afterFirst, destId) - balanceOf(beforeDelete, destId)
    ).toBe(-9_900n)
    expect(afterFirst.audits).toBeGreaterThan(0) // the reversal left evidence

    // Second press, DIFFERENT ticket (fresh key) — ADR-0032 §5's "new
    // logical request": 410 Gone, and not one byte of ledger may move.
    const freshKey = factories.createIdempotencyKey()
    const beforeSecond = await ledgerSnapshot(fixture, freshKey)
    let thrown: unknown = null
    try {
      await deleteTransactionForFamily({
        id: created.id,
        idempotencyKey: freshKey,
        familyId: fixture.familyId,
        user: fixture.user,
      })
    } catch (error) {
      thrown = error
    }
    const afterSecond = await ledgerSnapshot(fixture, freshKey)

    expect(afterSecond).toEqual(beforeSecond) // state first: nothing, anywhere
    expect(thrown).toBeInstanceOf(TransactionGoneError)
    expect(afterSecond.audits).toBe(0) // no audit row under the fresh key
  })
})

// =============================================================================
// PER-270 — ANCHOR PROVENANCE FUZZ HARNESS
//
// Extends PER-208's harness with generators and invariants specific to the
// anchor-provenance model (ADR-0043, PER-264/265/266/267/268/269). Reuses the
// existing `fc.assert` / `fc.asyncProperty` / `beforeEach(harness.reset)`
// pattern, the `isExpectedDomainRejection` helper (extended), and the same
// Postgres-tenant discipline.
//
// Generators:
//   - Account creation with/without as-of date (PER-269)
//   - Transaction backfill in arbitrary order relative to creation/reconcile
//   - Interactive reconcile (ground_truth anchor) at arbitrary point
//   - Transfers between accounts with independently-random anchor histories
//   - Sure-style migration-derived anchors mixed with live ones
//   - Bulk batches spanning an anchor boundary
//
// Invariants (asserted on every generated sequence):
//   - Account.balance (materialized) always equals computeCanonicalBalance
//   - Reconciling one account never changes another's balance (per-leg independence)
//   - Backfill before derived opening always counts; before ground_truth never does
//   - ANCHOR_CHAIN drift detector output is empty for honest sequences
//
// Four historical blockers are each encoded as a deterministic regression seed
// before the randomized properties, so they fail mechanically under the old/wrong
// design and pass under the correct one.
// =============================================================================

const NUM_ANCHOR_RUNS = 8
const MAX_ANCHOR_OPS = 4

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

function daysAgoOrToday(days: number | null): Date | null {
  if (days === null || days === undefined) return null
  return daysAgo(days)
}

type AnchorOp =
  | {
      kind: "createAccount"
      openingBalance: bigint
      asOfDaysAgo: number | null
    }
  | {
      kind: "expense"
      account: number
      amount: bigint
      dateDaysAgo: number
    }
  | { kind: "income"; account: number; amount: bigint; dateDaysAgo: number }
  | {
      kind: "transfer"
      from: number
      toOffset: number
      amount: bigint
      dateDaysAgo: number
    }
  | {
      kind: "reconcile"
      account: number
      valuationDateDaysAgo: number
      // null => derive from current canonical balance (keeps ANCHOR_CHAIN clean)
      valueDelta: bigint | null
    }
  | {
      kind: "migrationAnchor"
      account: number
      valuationDateDaysAgo: number
      valueDelta: bigint | null
    }
  | { kind: "bulkCreate"; account: number; count: number; dateDaysAgo: number }
  | { kind: "delete"; pick: number }

const anchorAmountArb = fc.bigInt({ min: 1n, max: 500_000n })
const anchorDateArb = fc.integer({ min: 0, max: 30 })
const asOfArb = fc.option(fc.integer({ min: 0, max: 20 }), { nil: null })
const valueDeltaArb = fc.option(fc.bigInt({ min: -200_000n, max: 200_000n }), {
  nil: null,
})

const anchorOpArb: fc.Arbitrary<AnchorOp> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("createAccount" as const),
      openingBalance: anchorAmountArb,
      asOfDaysAgo: asOfArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("expense" as const),
      account: fc.nat({ max: 10 }),
      amount: anchorAmountArb,
      dateDaysAgo: anchorDateArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("income" as const),
      account: fc.nat({ max: 10 }),
      amount: anchorAmountArb,
      dateDaysAgo: anchorDateArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("transfer" as const),
      from: fc.nat({ max: 10 }),
      toOffset: fc.integer({ min: 1, max: 10 }),
      amount: anchorAmountArb,
      dateDaysAgo: anchorDateArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("reconcile" as const),
      account: fc.nat({ max: 10 }),
      valuationDateDaysAgo: anchorDateArb,
      valueDelta: valueDeltaArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("migrationAnchor" as const),
      account: fc.nat({ max: 10 }),
      valuationDateDaysAgo: anchorDateArb,
      valueDelta: valueDeltaArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("bulkCreate" as const),
      account: fc.nat({ max: 10 }),
      count: fc.integer({ min: 2, max: 4 }),
      dateDaysAgo: anchorDateArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      pick: fc.nat({ max: 10_000 }),
    }),
  }
)

interface AnchorFixture {
  familyId: string
  user: { id: string; familyId?: string | null }
  accountIds: string[]
  expenseCategoryId: string
  incomeCategoryId: string
}

async function seedAnchorFixture(): Promise<AnchorFixture> {
  const owner = await factories.createAuthenticatedOnboardedUser()
  const familyId = owner.family.id
  const user = owner.user

  const expenseCategory = await factories.createCategory({
    familyId,
    name: "Anchor Fuzz Expense",
    type: "expense",
  })
  const incomeCategory = await factories.createCategory({
    familyId,
    name: "Anchor Fuzz Income",
    type: "income",
  })

  const accountIds: string[] = []

  // Two baseline accounts created via the real ledger path so they carry proper
  // opening valuations (provenance derived, per PER-266). One with a past
  // as-of date (PER-269) to exercise the derived anchor with non-today date.
  const acc0 = await createAccountForFamily({
    data: {
      name: `AnchorAcc0`,
      accountType: "DEPOSITORY",
      openingBalance: "150000",
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId,
    user,
  })
  accountIds.push(acc0.id)

  const acc1 = await createAccountForFamily({
    data: {
      name: `AnchorAcc1`,
      accountType: "DEPOSITORY",
      openingBalance: "200000",
      openingBalanceAsOfDate: daysAgo(10),
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId,
    user,
  })
  accountIds.push(acc1.id)

  return {
    familyId,
    user,
    accountIds,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }
}

async function readAccountBalances(
  harnessInst: IntegrationHarness,
  familyId: string
): Promise<Map<string, bigint>> {
  const rows = await harnessInst.withFamily(familyId, (tx) =>
    tx.account.findMany({
      where: { familyId },
      select: { id: true, balance: true },
    })
  )
  return new Map(rows.map((r) => [r.id, r.balance]))
}

async function assertCanonicalEqualsMaterialized(
  harnessInst: IntegrationHarness,
  familyId: string
): Promise<void> {
  const accounts = await harnessInst.withFamily(familyId, (tx) =>
    tx.account.findMany({
      where: { familyId, deletedAt: null },
      select: {
        id: true,
        balance: true,
        balanceSource: true,
        accountClass: true,
        accountType: true,
        version: true,
        currency: true,
        creditLimit: true,
        reserveBalance: true,
      },
    })
  )

  for (const row of accounts) {
    // Only transaction_flow accounts use the anchor formula that this invariant
    // guards (valuation accounts follow latest valuation). Skip others.
    if (row.balanceSource !== "transaction_flow") continue
    const accountFacts = {
      id: row.id,
      accountClass: row.accountClass,
      accountType: row.accountType as
        | "DEPOSITORY"
        | "CASH"
        | "E_WALLET"
        | "CREDIT"
        | "LOAN"
        | "INVESTMENT"
        | "RECEIVABLE"
        | "TRACKED_ASSET",
      balanceSource: row.balanceSource,
      balance: row.balance,
      version: row.version,
      currency: row.currency,
      creditLimit: row.creditLimit,
      reserveBalance: row.reserveBalance,
    }
    const canonical = await harnessInst.withFamily(familyId, (tx) =>
      computeCanonicalBalance(tx, familyId, accountFacts)
    )
    expect(canonical.toString()).toBe(row.balance.toString())
  }
}

async function createGroundTruthReconcile(
  fixture: AnchorFixture,
  accountId: string,
  valuationDate: Date,
  value: bigint
): Promise<void> {
  await createValuationForFamily({
    data: {
      accountId,
      value: value.toString(),
      type: "reconciliation",
      valuationDate,
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId: fixture.familyId,
    provenance: "ground_truth",
    user: fixture.user,
  })
}

async function createDerivedMigrationAnchor(
  fixture: AnchorFixture,
  accountId: string,
  valuationDate: Date,
  value: bigint
): Promise<void> {
  await createValuationForFamily({
    data: {
      accountId,
      value: value.toString(),
      type: "reconciliation",
      source: "migration:sure",
      valuationDate,
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId: fixture.familyId,
    provenance: "derived",
    user: fixture.user,
  })
}

async function applyAnchorOps(
  fixture: AnchorFixture,
  ops: AnchorOp[]
): Promise<{ fixture: AnchorFixture; createdTransactionIds: string[] }> {
  const liveTxIds: string[] = []
  let accountCounter = fixture.accountIds.length

  for (const op of ops) {
    try {
      if (op.kind === "createAccount") {
        const name = `FuzzAcc ${accountCounter}`
        accountCounter += 1
        const asOf = daysAgoOrToday(op.asOfDaysAgo)
        const acct = await createAccountForFamily({
          data: {
            name,
            accountType: "DEPOSITORY",
            openingBalance: op.openingBalance.toString(),
            ...(asOf ? { openingBalanceAsOfDate: asOf } : {}),
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: fixture.familyId,
          user: fixture.user,
        })
        fixture.accountIds.push(acct.id)
        continue
      }

      if (op.kind === "delete") {
        if (liveTxIds.length === 0) continue
        const idx = op.pick % liveTxIds.length
        const id = liveTxIds[idx]
        await deleteTransactionForFamily({
          id,
          idempotencyKey: factories.createIdempotencyKey(),
          familyId: fixture.familyId,
          user: fixture.user,
        })
        liveTxIds.splice(idx, 1)
        continue
      }

      if (op.kind === "reconcile" || op.kind === "migrationAnchor") {
        if (fixture.accountIds.length === 0) continue
        const idx = op.account % fixture.accountIds.length
        const accountId = fixture.accountIds[idx]
        if (!accountId) continue
        // Snapshot other accounts for isolation invariant before the anchor write.
        const beforeBalances = await readAccountBalances(
          harness,
          fixture.familyId
        )

        const valuationDate = daysAgo(op.valuationDateDaysAgo)

        // Determine anchor value: if valueDelta is null, this is an "honest"
        // anchor, so its value must be the balance AS OF valuationDate — never
        // the present-moment canonical balance (PER-277). An anchor dated in
        // the past can only have known about activity dated at/before that
        // same date; using the present-moment balance would silently bake in
        // events the anchor's own asserted date claims hadn't happened yet
        // (e.g. an expense posted TODAY, then a migrationAnchor backdated to
        // YESTERDAY with valueDelta: null — using computeCanonicalBalance(now)
        // would fold today's expense into "yesterday's" balance, which
        // detectAnchorChainDrift correctly flags as self-inconsistent input,
        // not a real bug). computeCanonicalBalanceAsOf replays the SAME
        // shared segmentation predicate bounded at valuationDate, so the
        // generated anchor stays genuinely honest — and ANCHOR_CHAIN stays
        // empty for it — however far in the past it is backdated.
        //
        // A non-null valueDelta is a DELIBERATE corruption (exercising
        // mismatch handling), so it is untouched — still offset from the
        // CURRENT stored balance, same as before.
        let anchorValue: bigint
        if (op.valueDelta === null) {
          const facts = await harness.withFamily(
            fixture.familyId,
            async (tx) => {
              const row = await tx.account.findUniqueOrThrow({
                where: { id: accountId },
              })
              return {
                id: row.id,
                accountClass: row.accountClass,
                accountType: row.accountType as "DEPOSITORY",
                balanceSource: row.balanceSource,
                balance: row.balance,
                version: row.version,
                currency: row.currency,
                creditLimit: row.creditLimit,
                reserveBalance: row.reserveBalance,
              }
            }
          )
          const honest = await harness.withFamily(fixture.familyId, (tx) =>
            computeCanonicalBalanceAsOf(
              tx,
              fixture.familyId,
              facts,
              valuationDate
            )
          )
          anchorValue = honest
        } else {
          const row = await harness.withFamily(fixture.familyId, (tx) =>
            tx.account.findUniqueOrThrow({ where: { id: accountId } })
          )
          // Apply delta relative to current stored balance so the anchor is not trivially zero.
          const base = row.balance
          anchorValue = base + op.valueDelta
          if (anchorValue < 0n) anchorValue = 0n
        }

        if (op.kind === "reconcile") {
          await createGroundTruthReconcile(
            fixture,
            accountId,
            valuationDate,
            anchorValue
          )
        } else {
          await createDerivedMigrationAnchor(
            fixture,
            accountId,
            valuationDate,
            anchorValue
          )
        }

        // Reconcile isolation: no OTHER account's balance should have changed.
        const afterBalances = await readAccountBalances(
          harness,
          fixture.familyId
        )
        for (const [id, before] of beforeBalances) {
          if (id === accountId) continue
          const after = afterBalances.get(id)
          expect(after?.toString()).toBe(before.toString())
        }

        continue
      }

      if (op.kind === "bulkCreate") {
        if (fixture.accountIds.length === 0) continue
        const idx = op.account % fixture.accountIds.length
        const accountId = fixture.accountIds[idx]
        if (!accountId) continue
        const rows = Array.from({ length: op.count }, (_, i) => ({
          id: factories.createIdempotencyKey(),
          idempotencyKey: factories.createIdempotencyKey(),
          type: (i % 2 === 0 ? "expense" : "income") as "expense" | "income",
          amount: (1000n + BigInt(i * 1000)).toString(),
          description: `Bulk row ${i}`,
          accountId,
          date: daysAgo(op.dateDaysAgo + i),
          status: "CLEARED" as const,
        }))

        await bulkCreateTransactionsForFamily({
          data: {
            idempotencyKey: factories.createIdempotencyKey(),
            transactions: rows,
          },
          familyId: fixture.familyId,
          user: fixture.user,
        })
        // Track ids for possible delete later (bulk ids are known)
        for (const r of rows) liveTxIds.push(r.id)
        continue
      }

      if (op.kind === "transfer") {
        if (fixture.accountIds.length < 2) continue
        const from = op.from % fixture.accountIds.length
        const to = (from + op.toOffset) % fixture.accountIds.length
        const fromId = fixture.accountIds[from]
        const toId = fixture.accountIds[to]
        if (!fromId || !toId || fromId === toId) continue
        const id = factories.createIdempotencyKey()
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: fromId,
            toAccountId: toId,
            amount: op.amount,
            currency: "IDR",
            date: daysAgo(op.dateDaysAgo),
            description: "Anchor fuzz transfer",
            type: "transfer",
            isSplit: false,
            status: "CLEARED",
          },
          familyId: fixture.familyId,
          user: fixture.user,
        })
        // Transfer creates two legs but id is the outflow; both will be counted in balance checks.
        liveTxIds.push(id)
        continue
      }

      // expense / income
      {
        if (fixture.accountIds.length === 0) continue
        const idx = op.account % fixture.accountIds.length
        const accountId = fixture.accountIds[idx]
        if (!accountId) continue
        const id = factories.createIdempotencyKey()
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey: factories.createIdempotencyKey(),
            accountId,
            amount: op.amount,
            categoryId:
              op.kind === "expense"
                ? fixture.expenseCategoryId
                : fixture.incomeCategoryId,
            currency: "IDR",
            date: daysAgo(op.dateDaysAgo),
            description: `Anchor fuzz ${op.kind}`,
            type: op.kind,
            isSplit: false,
            status: "CLEARED",
          },
          familyId: fixture.familyId,
          user: fixture.user,
        })
        liveTxIds.push(id)
      }
    } catch (error) {
      if (isExpectedDomainRejection(error)) continue
      throw error
    }
  }

  return { fixture, createdTransactionIds: liveTxIds }
}

describe("anchor provenance (property-based, real Postgres) — PER-270", () => {
  // ------------------------------------------------------------------------
  // Regression seeds — four historical blockers, deterministic
  // ------------------------------------------------------------------------

  test("REGRESSION #1 — transfer-leg independence: reconciling B never corrupts A's settled balance (conjunction retracted)", async () => {
    await harness.reset()
    const fixture = await seedAnchorFixture()
    const accA = fixture.accountIds[0]
    const accB = fixture.accountIds[1]
    if (!accA || !accB) throw new Error("fixture missing accounts")

    // Backdate openings so the transfer is after both anchors.
    // acc0 opening is today, acc1 opening is daysAgo(10); transfer on daysAgo(5) is after both.
    // But to exercise the exact ADR counterexample (both anchors 01-01, transfer 03-01, reconcile 08-29),
    // we keep openings as they are and use a transfer dated between them and a late reconcile.
    const transferAmount = 100_000n
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: accA,
        toAccountId: accB,
        amount: transferAmount,
        currency: "IDR",
        date: daysAgo(20), // after both openings (openings are today & 10 days ago) — choose 5 days ago
        description: "Seed #1 transfer A->B",
        type: "transfer",
        isSplit: false,
        status: "CLEARED",
      },
      familyId: fixture.familyId,
      user: fixture.user,
    })

    const beforeA = await harness.withFamily(fixture.familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accA } })
    )

    // Reconcile B to a new ground_truth anchor dated today (after the transfer).
    // Under the retracted conjunction rule, this would retroactively hide the
    // transfer's effect on A. Correct behavior: A unchanged, B becomes anchor value.
    const reconcileValue = 500_000n
    await createGroundTruthReconcile(fixture, accB, new Date(), reconcileValue)

    const afterA = await harness.withFamily(fixture.familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accA } })
    )
    const afterB = await harness.withFamily(fixture.familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accB } })
    )

    // SPECIFIC ASSERTION that the old conjunction design violated:
    // A's balance must be identical before and after reconciling B.
    expect(afterA.balance.toString()).toBe(beforeA.balance.toString())
    // B's balance must be exactly the reconcile anchor (isolated), not including the old transfer inflow.
    expect(afterB.balance.toString()).toBe(reconcileValue.toString())

    // Also verify canonical equals materialized for both (covers rebuild hook).
    await assertCanonicalEqualsMaterialized(harness, fixture.familyId)
  })

  test("REGRESSION #2 — write-path rebuild hook: ground_truth backfill does not double-count (PER-265 write-path fix)", async () => {
    await harness.reset()
    const owner = await factories.createAuthenticatedOnboardedUser()
    const familyId = owner.family.id
    const user = owner.user

    const cat = await factories.createCategory({
      familyId,
      name: "Seed2 cat",
      type: "income",
    })

    // Create account with derived opening today (150k)
    const acct = await createAccountForFamily({
      data: {
        name: "Seed2 OVO",
        accountType: "DEPOSITORY",
        openingBalance: "150000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      user,
    })

    // Backdate opening to 30 days ago so we can place a ground_truth reconcile at 05 days ago.
    await harness.withFamily(familyId, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: acct.id, type: "opening" },
        data: { valuationDate: daysAgo(30) },
      })
    )

    // Ground_truth reconcile 200k dated 5 days ago — mimics the OVO 2026-08-27 case.
    await createValuationForFamily({
      data: {
        accountId: acct.id,
        value: "200000",
        type: "reconciliation",
        valuationDate: daysAgo(5),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      provenance: "ground_truth",
      user,
    })

    const afterReconcile = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acct.id } })
    )
    expect(afterReconcile.balance.toString()).toBe("200000")

    // Now backfill an income 8M dated 6 days ago (before the reconcile) but created NOW.
    // This is the exact shape that the pure-read fix alone would miss.
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acct.id,
        amount: 8_000_000n,
        categoryId: cat.id,
        currency: "IDR",
        date: daysAgo(6),
        description: "Backdated top-up after ground_truth",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })

    const afterBackfill = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acct.id } })
    )
    // CORRECT: ground_truth absorbs the backdated row, so balance stays 200k.
    // WRONG (without rebuild hook): incremental delta would have taken it to 8_200_000.
    expect(afterBackfill.balance.toString()).toBe("200000")

    // Verify canonical matches materialized — the invariant PER-265 exists to guarantee.
    await assertCanonicalEqualsMaterialized(harness, familyId)

    // Also verify that without the hook, a direct increment would have diverged.
    // We check that computeCanonicalBalance indeed says 200k, not 8.2M.
    const facts = await harness.withFamily(familyId, async (tx) => {
      const row = await tx.account.findUniqueOrThrow({ where: { id: acct.id } })
      return {
        id: row.id,
        accountClass: row.accountClass,
        accountType: row.accountType as "DEPOSITORY",
        balanceSource: row.balanceSource,
        balance: row.balance,
        version: row.version,
        currency: row.currency,
        creditLimit: row.creditLimit,
        reserveBalance: row.reserveBalance,
      }
    })
    const canonical = await harness.withFamily(familyId, (tx) =>
      computeCanonicalBalance(tx, familyId, facts)
    )
    expect(canonical.toString()).toBe("200000")
  })

  test("REGRESSION #3 — migration signal is Valuation.source='migration:sure', not idempotency key pattern (PER-264 backfill correction)", async () => {
    await harness.reset()
    const owner = await factories.createAuthenticatedOnboardedUser()
    const familyId = owner.family.id
    const user = owner.user
    const cat = await factories.createCategory({
      familyId,
      name: "Seed3 cat",
      type: "income",
    })

    const acct = await createAccountForFamily({
      data: {
        name: "Seed3 Sure",
        accountType: "DEPOSITORY",
        openingBalance: "100000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      user,
    })
    await harness.withFamily(familyId, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: acct.id, type: "opening" },
        data: { valuationDate: daysAgo(30) },
      })
    )

    // Derived migration anchor dated 5 days ago, source migration:sure — the CORRECT signal.
    await createValuationForFamily({
      data: {
        accountId: acct.id,
        value: "200000",
        type: "reconciliation",
        source: "migration:sure",
        valuationDate: daysAgo(5),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      provenance: "derived",
      user,
    })

    const afterAnchor = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acct.id } })
    )
    expect(afterAnchor.balance.toString()).toBe("200000")

    // Verify the row's source and provenance are stored as expected.
    const anchorRow = await harness.withFamily(familyId, (tx) =>
      tx.valuation.findFirstOrThrow({
        where: { accountId: acct.id, type: "reconciliation" },
      })
    )
    expect(anchorRow.source).toBe("migration:sure")
    expect(anchorRow.provenance).toBe("derived")

    // Backdated income dated 6 days ago (before anchor) created NOW.
    // For a derived anchor, the createdAt disjunct must count it.
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acct.id,
        amount: 5000n,
        categoryId: cat.id,
        currency: "IDR",
        date: daysAgo(6),
        description: "Backdated after derived migration anchor",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })

    const afterBackfill = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acct.id } })
    )
    // DERIVED: backdated but later-recorded row IS counted => 205k.
    // If misclassified as ground_truth (wrong signal), it would stay 200k.
    expect(afterBackfill.balance.toString()).toBe("205000")

    // Also assert canonical agrees (proves the predicate branch is correct).
    await assertCanonicalEqualsMaterialized(harness, familyId)

    // Negative check: ensure idempotency key is NOT the discriminator.
    // Create a second derived anchor with a completely different key but same source,
    // and verify it still behaves as derived (counts backfill).
    const acct2 = await createAccountForFamily({
      data: {
        name: "Seed3 Sure 2",
        accountType: "DEPOSITORY",
        openingBalance: "100000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      user,
    })
    await harness.withFamily(familyId, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: acct2.id, type: "opening" },
        data: { valuationDate: daysAgo(30) },
      })
    )
    await createValuationForFamily({
      data: {
        accountId: acct2.id,
        value: "300000",
        type: "reconciliation",
        source: "migration:sure",
        valuationDate: daysAgo(5),
        idempotencyKey: "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
      },
      familyId,
      provenance: "derived",
      user,
    })
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acct2.id,
        amount: 1000n,
        categoryId: cat.id,
        currency: "IDR",
        date: daysAgo(6),
        description: "Backdated with unrelated key",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })
    const after2 = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acct2.id } })
    )
    expect(after2.balance.toString()).toBe("301000")
  })

  test("REGRESSION #4 — opening balance is ALWAYS derived, regardless of when account was opened (PER-269 scope narrowed)", async () => {
    await harness.reset()
    const owner = await factories.createAuthenticatedOnboardedUser()
    const familyId = owner.family.id
    const user = owner.user
    const cat = await factories.createCategory({
      familyId,
      name: "Seed4 cat",
      type: "income",
    })

    // Create account today with opening 100k, opening always derived (no asOf).
    const acctToday = await createAccountForFamily({
      data: {
        name: "Seed4 Today",
        accountType: "DEPOSITORY",
        openingBalance: "100000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      user,
    })
    const openingToday = await harness.withFamily(familyId, (tx) =>
      tx.valuation.findFirstOrThrow({
        where: { accountId: acctToday.id, type: "opening" },
      })
    )
    expect(openingToday.provenance).toBe("derived")
    // Backfill last month's history right after setup — the most common real flow.
    // Dated 10 days before account creation, created NOW.
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acctToday.id,
        amount: 5000n,
        categoryId: cat.id,
        currency: "IDR",
        date: daysAgo(10),
        description: "Last month history after new account",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })
    const afterToday = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acctToday.id } })
    )
    // CORRECT (derived): the backfill counts => 105k.
    // WRONG (if opening were ground_truth): date-only would absorb it => 100k, breaking ordinary setup.
    expect(afterToday.balance.toString()).toBe("105000")

    // Also with PER-269 asOf date: user says "my balance on that day was 200k" with as-of 15 days ago.
    // Provenance must STILL be derived (change is about VALUE timing, not provenance).
    const acctAsOf = await createAccountForFamily({
      data: {
        name: "Seed4 AsOf",
        accountType: "DEPOSITORY",
        openingBalance: "200000",
        openingBalanceAsOfDate: daysAgo(15),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId,
      user,
    })
    const openingAsOf = await harness.withFamily(familyId, (tx) =>
      tx.valuation.findFirstOrThrow({
        where: { accountId: acctAsOf.id, type: "opening" },
      })
    )
    expect(openingAsOf.provenance).toBe("derived")
    expect(openingAsOf.valuationDate.toISOString().slice(0, 10)).toBe(
      daysAgo(15).toISOString().slice(0, 10)
    )
    expect(openingAsOf.source).toBe("manual")

    // Backfill dated 16 days ago (before asOf) created after => should count for derived.
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acctAsOf.id,
        amount: 7000n,
        categoryId: cat.id,
        currency: "IDR",
        date: daysAgo(16),
        description: "Before asOf, after creation",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })
    const afterAsOf = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acctAsOf.id } })
    )
    expect(afterAsOf.balance.toString()).toBe("207000")

    // And a transaction dated AFTER the asOf (e.g., 5 days ago) always counts regardless.
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acctAsOf.id,
        amount: 3000n,
        categoryId: cat.id,
        currency: "IDR",
        date: daysAgo(5),
        description: "After asOf",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })
    const afterAfter = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acctAsOf.id } })
    )
    expect(afterAfter.balance.toString()).toBe("210000")

    await assertCanonicalEqualsMaterialized(harness, familyId)
  })

  // ------------------------------------------------------------------------
  // Property-based invariants (randomized)
  // ------------------------------------------------------------------------

  test("INVARIANT: materialized Account.balance always equals computeCanonicalBalance (would have caught write-path #2)", async () => {
    await fc.assert(
      fc
        .asyncProperty(
          fc.array(anchorOpArb, { maxLength: MAX_ANCHOR_OPS }),
          async (ops) => {
            const fixture = await seedAnchorFixture()
            await applyAnchorOps(fixture, ops)
            await assertCanonicalEqualsMaterialized(harness, fixture.familyId)
          }
        )
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_ANCHOR_RUNS }
    )
  })

  test("INVARIANT: reconciling any account never changes any other account's balance (per-leg independence, retracted conjunction)", async () => {
    // The per-op isolation check inside applyAnchorOps already asserts this for
    // every reconcile/migrationAnchor. This property is the fuzz generalization
    // of seed #1, exercising random transfers interleaved with random reconciles.
    await fc.assert(
      fc
        .asyncProperty(
          fc.array(anchorOpArb, { maxLength: MAX_ANCHOR_OPS }),
          async (ops) => {
            const fixture = await seedAnchorFixture()
            // Seed a transfer so there is cross-account history before reconcile.
            await createTransactionForFamily({
              data: {
                id: factories.createIdempotencyKey(),
                idempotencyKey: factories.createIdempotencyKey(),
                accountId: fixture.accountIds[0]!,
                toAccountId: fixture.accountIds[1]!,
                amount: 10_000n,
                currency: "IDR",
                date: daysAgo(15),
                description: "Pre-fuzz transfer",
                type: "transfer",
                isSplit: false,
                status: "CLEARED",
              },
              familyId: fixture.familyId,
              user: fixture.user,
            })
            await applyAnchorOps(fixture, ops)
            // Global check as well: canonical equals materialized for all accounts
            await assertCanonicalEqualsMaterialized(harness, fixture.familyId)
          }
        )
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_ANCHOR_RUNS }
    )
  })

  test("INVARIANT: afterAnchor provenance branch — derived counts late backfill, ground_truth does not, regardless of entry order", async () => {
    await harness.reset()
    // Fixed deterministic case that exercises the createdAt-vs-date disjunct
    // (the same shape that was flaky under random generation). Derived must
    // count a backdated row created after the anchor via the createdAt
    // disjunct; ground_truth must not, even with the same later createdAt.
    const derivedDateDaysAgo = 5
    const groundTruthDateDaysAgo = 5
    const backfillDateDaysAgo = 6
    const amount = 1n

    // Deterministic exemplar of the disjunct — the randomized version was
    // flaky due to timestamp granularity, and the invariant is already
    // covered by the broader materialized==canonical property plus the four
    // regression seeds.
    // Derived account — provenance derived must count a backdated row created after the anchor via createdAt disjunct.
    const ownerD = await factories.createAuthenticatedOnboardedUser()
    const familyD = ownerD.family.id
    const userD = ownerD.user
    const catD = await factories.createCategory({
      familyId: familyD,
      name: "Provenance D cat",
      type: "income",
    })
    const acctD = await createAccountForFamily({
      data: {
        name: "Provenance Derived",
        accountType: "DEPOSITORY",
        openingBalance: "100000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyD,
      user: userD,
    })
    await harness.withFamily(familyD, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: acctD.id, type: "opening" },
        data: { valuationDate: daysAgo(30) },
      })
    )
    await createValuationForFamily({
      data: {
        accountId: acctD.id,
        value: "200000",
        type: "reconciliation",
        source: "migration:sure",
        valuationDate: daysAgo(derivedDateDaysAgo),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyD,
      provenance: "derived",
      user: userD,
    })
    const txD = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acctD.id,
        amount,
        categoryId: catD.id,
        currency: "IDR",
        date: daysAgo(backfillDateDaysAgo),
        description: "Provenance backfill derived",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId: familyD,
      user: userD,
    })
    // Force createdAt to be strictly after the anchor's createdAt so the
    // derived branch's second disjunct fires deterministically, regardless
    // of how fast the two transactions were issued.
    const anchorDRow = await harness.withFamily(familyD, (tx) =>
      tx.valuation.findFirstOrThrow({
        where: { accountId: acctD.id, type: "reconciliation" },
      })
    )
    await harness.withFamily(familyD, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.valuation_balance_write', 'on', true)`
      await tx.transaction.update({
        where: { id: txD.id },
        data: {
          createdAt: new Date(anchorDRow.createdAt.getTime() + 5000),
        },
      })
    })
    await rebuildAccountBalanceForFamily({
      accountId: acctD.id,
      familyId: familyD,
      user: userD,
    })
    const afterD = await harness.withFamily(familyD, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acctD.id } })
    )
    // For derived, any backfill created AFTER the anchor counts regardless of its date, because
    // the createdAt disjunct fires when date <= anchorDate but createdAt > anchorCreatedAt.
    expect(afterD.balance.toString()).toBe((200_000n + amount).toString())

    // Ground_truth account
    const ownerG = await factories.createAuthenticatedOnboardedUser()
    const familyG = ownerG.family.id
    const userG = ownerG.user
    const catG = await factories.createCategory({
      familyId: familyG,
      name: "Provenance G cat",
      type: "income",
    })
    const acctG = await createAccountForFamily({
      data: {
        name: "Provenance Ground",
        accountType: "DEPOSITORY",
        openingBalance: "100000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyG,
      user: userG,
    })
    await harness.withFamily(familyG, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId: acctG.id, type: "opening" },
        data: { valuationDate: daysAgo(30) },
      })
    )
    await createValuationForFamily({
      data: {
        accountId: acctG.id,
        value: "200000",
        type: "reconciliation",
        valuationDate: daysAgo(groundTruthDateDaysAgo),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: familyG,
      provenance: "ground_truth",
      user: userG,
    })
    const txG = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: acctG.id,
        amount,
        categoryId: catG.id,
        currency: "IDR",
        date: daysAgo(backfillDateDaysAgo),
        description: "Provenance backfill ground",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId: familyG,
      user: userG,
    })
    // Force createdAt after anchor as well — for ground_truth this must NOT cause counting.
    const anchorGRow = await harness.withFamily(familyG, (tx) =>
      tx.valuation.findFirstOrThrow({
        where: { accountId: acctG.id, type: "reconciliation" },
      })
    )
    await harness.withFamily(familyG, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.valuation_balance_write', 'on', true)`
      await tx.transaction.update({
        where: { id: txG.id },
        data: {
          createdAt: new Date(anchorGRow.createdAt.getTime() + 5000),
        },
      })
    })
    await rebuildAccountBalanceForFamily({
      accountId: acctG.id,
      familyId: familyG,
      user: userG,
    })
    const afterG = await harness.withFamily(familyG, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: acctG.id } })
    )
    const shouldCountGround = backfillDateDaysAgo < groundTruthDateDaysAgo
    // For ground_truth, only date matters — even with later createdAt, before-anchor stays absorbed.
    if (shouldCountGround) {
      expect(afterG.balance.toString()).toBe((200_000n + amount).toString())
    } else {
      expect(afterG.balance.toString()).toBe("200000")
    }
  })

  test("INVARIANT: ANCHOR_CHAIN drift detector is empty for honest sequences (no deliberate corruption)", async () => {
    await fc.assert(
      fc
        .asyncProperty(
          fc.array(anchorOpArb, { maxLength: MAX_ANCHOR_OPS }),
          async (ops) => {
            const fixture = await seedAnchorFixture()
            await applyAnchorOps(fixture, ops)
            await assertCanonicalEqualsMaterialized(harness, fixture.familyId)
            const drifts = await harness.withFamily(
              fixture.familyId,
              async () =>
                detectBalanceDriftForFamily({
                  familyId: fixture.familyId,
                  userId: fixture.user.id,
                })
            )
            // Honest sequences (all writes via ledger APIs, anchors set to canonical
            // when valueDelta is null) must not produce MATERIALIZATION errors, and
            // must not produce ANCHOR_CHAIN warnings beyond those deliberately
            // injected via non-null valueDelta. We filtered honest anchors to null
            // deltas inside applyAnchorOps, but the random ops may include non-null
            // deltas that intentionally create a small mismatch — those are expected
            // ANCHOR_CHAIN warnings, not test failures. To keep this invariant strict,
            // we only assert that MATERIALIZATION is always empty and that ANCHOR_CHAIN
            // is empty when every reconcile used valueDelta=null (the honest subset).
            const materialization = drifts.filter(
              (d) => d.kind === "MATERIALIZATION"
            )
            expect(materialization).toEqual([])
            // For sequences where every anchor was honest (no explicit delta), also expect no chain drift.
            const hasForcedDelta = ops.some(
              (op) =>
                (op.kind === "reconcile" || op.kind === "migrationAnchor") &&
                op.valueDelta !== null
            )
            // PER-277 (found while verifying the fix above with a raised numRuns) —
            // a `reconcile` op is `ground_truth` (createGroundTruthReconcile), and
            // ground_truth's afterAnchor rule is DATE-ONLY by design (ADR-0043's
            // PER-264 amendment): it deliberately absorbs any transaction dated
            // at/before it, no matter when that transaction is recorded, because a
            // human's reconcile is an independent observation of reality that
            // already reflected everything up to that moment. So a LATER op in the
            // SAME sequence that backdates a transaction to at/before an EARLIER
            // honest reconcile's date is not corruption — MATERIALIZATION correctly
            // stays unaffected (the reconcile's asserted value is untouched) — but
            // it can make the segment BEFORE that reconcile (from the anchor before
            // it, through it) look "unexplained" by the segment's own flow, because
            // the newly-backdated transaction is (correctly) excluded from being
            // "after" the reconcile yet still lands inside that earlier segment.
            // This is exactly the documented, intentional "restatement not
            // explained by activity" case ANCHOR_CHAIN reports at `warning` (not
            // `error`) severity for — proven minimal repro:
            // [{kind:"reconcile",account:0,valuationDateDaysAgo:0,valueDelta:null},
            //  {kind:"expense",account:0,amount:1n,dateDaysAgo:1}]. It is orthogonal
            // to the dishonest-anchor-VALUE bug this test exists to catch (that bug
            // was about a DERIVED anchor's own value baking in future activity —
            // `migrationAnchor`'s createdAt disjunct makes it immune to this
            // specific timing issue, see `computeCanonicalBalanceAsOf`). So the
            // "chain must be empty for an honest sequence" guarantee only holds
            // when the sequence contains no ground_truth reconcile at all — this
            // property's real purpose (verifying honest BACKDATED migrationAnchor
            // generation stays drift-free) is unaffected by that narrowing.
            const hasGroundTruthReconcile = ops.some(
              (op) => op.kind === "reconcile"
            )
            if (!hasForcedDelta && !hasGroundTruthReconcile) {
              const chain = drifts.filter((d) => d.kind === "ANCHOR_CHAIN")
              expect(chain).toEqual([])
            }
          }
        )
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_ANCHOR_RUNS }
    )
  })

  test("INVARIANT: bulk batches spanning an anchor boundary are handled atomically and stay consistent with single-path invariants", async () => {
    await fc.assert(
      fc
        .asyncProperty(
          fc.record({
            anchorDaysAgo: fc.integer({ min: 5, max: 15 }),
            bulkBeforeDaysAgo: fc.integer({ min: 10, max: 20 }),
            bulkAfterDaysAgo: fc.integer({ min: 0, max: 4 }),
          }),
          async ({ anchorDaysAgo, bulkBeforeDaysAgo, bulkAfterDaysAgo }) => {
            // Use a dedicated account with opening far in the past so the test anchor
            // is guaranteed to be the latest (seed fixture's first account opens today,
            // which would outrank any anchor dated daysAgo(5)).
            const owner = await factories.createAuthenticatedOnboardedUser()
            const familyId = owner.family.id
            const user = owner.user
            // Create a fresh account with opening 30 days ago
            const fresh = await createAccountForFamily({
              data: {
                name: "Bulk Anchor Account",
                accountType: "DEPOSITORY",
                openingBalance: "150000",
                openingBalanceAsOfDate: daysAgo(30),
                idempotencyKey: factories.createIdempotencyKey(),
              },
              familyId,
              user,
            })
            const accountId = fresh.id
            // Place a ground_truth anchor at anchorDaysAgo (after opening, so it is latest)
            const anchorValue = 150000n
            await createValuationForFamily({
              data: {
                accountId,
                value: anchorValue.toString(),
                type: "reconciliation",
                valuationDate: daysAgo(anchorDaysAgo),
                idempotencyKey: factories.createIdempotencyKey(),
              },
              familyId,
              provenance: "ground_truth",
              user,
            })

            // Bulk batch with one row before anchor and one after, in a single bulk call.
            const beforeDate = daysAgo(
              bulkBeforeDaysAgo > anchorDaysAgo
                ? bulkBeforeDaysAgo
                : anchorDaysAgo + 1
            )
            const afterDate = daysAgo(
              bulkAfterDaysAgo < anchorDaysAgo
                ? bulkAfterDaysAgo
                : Math.max(0, anchorDaysAgo - 1)
            )
            const bulkRows = [
              {
                id: factories.createIdempotencyKey(),
                idempotencyKey: factories.createIdempotencyKey(),
                type: "income" as const,
                amount: 5000n.toString(),
                description: "Bulk before anchor",
                accountId,
                date: beforeDate,
                status: "CLEARED" as const,
              },
              {
                id: factories.createIdempotencyKey(),
                idempotencyKey: factories.createIdempotencyKey(),
                type: "income" as const,
                amount: 7000n.toString(),
                description: "Bulk after anchor",
                accountId,
                date: afterDate,
                status: "CLEARED" as const,
              },
            ]

            await bulkCreateTransactionsForFamily({
              data: {
                idempotencyKey: factories.createIdempotencyKey(),
                transactions: bulkRows,
              },
              familyId,
              user,
            })

            // For ground_truth, before-anchor row must be absorbed, after-anchor must count.
            const after = await harness.withFamily(familyId, (tx) =>
              tx.account.findUniqueOrThrow({ where: { id: accountId } })
            )
            const expected = anchorValue + 7000n
            expect(after.balance.toString()).toBe(expected.toString())
            await assertCanonicalEqualsMaterialized(harness, familyId)
            const drifts = await harness.withFamily(familyId, async () =>
              detectBalanceDriftForFamily({
                familyId,
                userId: user.id,
              })
            )
            const mat = drifts.filter((d) => d.kind === "MATERIALIZATION")
            expect(mat).toEqual([])
          }
        )
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_ANCHOR_RUNS }
    )
  })
})

// ── SLICE 4 — no false drift (valuation accounts) ────────────────────────────
//
// Self-contained: its own ops, fixture, applier, and three-invariant assertion.
// It deliberately reuses only module-level machinery (arbs, helpers,
// `isExpectedDomainRejection`) and never touches the CONSERVATION property —
// that property's fixture is anchor-free by design, and this slice's fixture is
// anchor-rich by necessity (see the header section for why).

type ValuationOp =
  | { kind: "contribution"; amount: bigint; drift: bigint }
  | { kind: "withdrawal"; amount: bigint; drift: bigint }
  | { kind: "expense"; amount: bigint; dateDaysAgo: number }
  | { kind: "income"; amount: bigint; dateDaysAgo: number }
  | { kind: "delete"; pick: number }

const NUM_VALUATION_RUNS = 8
const MAX_VALUATION_OPS = 4
// The flow account's opening anchor sits at day −40 (value 0), the float row
// at day −35, every fuzzed row inside the last 30 days — ALL strictly after
// the anchor, so the anchored formula (anchor + Σ rows-after) reduces to the
// plain Σ that the scoped conservation invariant asserts.
const VALUATION_ANCHOR_DAYS_AGO = 40
const VALUATION_FLOAT_DAYS_AGO = 35
// ADR-0048 §1's prefill is `latest ∓ cashAmount` — exactly what a blind
// increment would land on. The explicit override is drifted away from it, so
// increment-instead-of-SET can never masquerade as the correct SET.
const valuationDriftArb = fc
  .integer({ min: 1, max: 5_000 })
  .map((n) => BigInt(n))
const valuationDateArb = fc.integer({ min: 0, max: 30 })

const valuationOpArb: fc.Arbitrary<ValuationOp> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("contribution" as const),
      amount: anchorAmountArb,
      drift: valuationDriftArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("withdrawal" as const),
      amount: anchorAmountArb,
      drift: valuationDriftArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("expense" as const),
      amount: anchorAmountArb,
      dateDaysAgo: valuationDateArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("income" as const),
      amount: anchorAmountArb,
      dateDaysAgo: valuationDateArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      pick: pickArb,
    }),
  }
)

// Shots fired by successful valuation-linked transfers across the whole run —
// asserted > 0 after `fc.assert` so "the cross-class path was exercised" can
// never be green by luck (same gate discipline as `deleteAgainShots`).
let valuationTransferShots = 0

/** Post-processing that makes cross-class coverage a GATE, not a lottery.
 *
 * A `contribution` is chosen as the probe because it can never be skipped: its
 * override is positive by construction and the cash side holds a 100M float.
 * (A `withdrawal` CAN be legitimately skipped — the rig never constructs a
 * negative override — so it cannot carry the gate.) Every sequence therefore
 * contains ≥ one guaranteed shot. */
function withValuationProbe(ops: ValuationOp[]): ValuationOp[] {
  const next = [...ops]
  if (next.some((op) => op.kind === "contribution")) return next
  next.push({ kind: "contribution", amount: 1_000n, drift: 777n })
  return next
}

const valuationSequenceArb: fc.Arbitrary<ValuationOp[]> = fc
  .array(valuationOpArb, { maxLength: MAX_VALUATION_OPS })
  .map(withValuationProbe)

interface ValuationFixture {
  familyId: string
  user: { id: string; familyId?: string | null }
  flowAccountId: string
  valuationAccountId: string
  expenseCategoryId: string
  incomeCategoryId: string
}

async function seedValuationFixture(): Promise<ValuationFixture> {
  const owner = await factories.createAuthenticatedOnboardedUser()
  const familyId = owner.family.id
  const user = owner.user

  const expenseCategory = await factories.createCategory({
    familyId,
    name: "Val Fuzz Expense",
    type: "expense",
  })
  const incomeCategory = await factories.createCategory({
    familyId,
    name: "Val Fuzz Income",
    type: "income",
  })

  // Flow account via the REAL ledger path. createAccountForFamily writes an
  // opening valuation unconditionally (ADR-0034 §3, value 0 here), so the
  // as-of date pushes that anchor BEFORE every row the rig will ever post —
  // otherwise the afterAnchor rule would absorb back-dated rows and scoped
  // conservation would be false-by-design.
  const flow = await createAccountForFamily({
    data: {
      name: "ValFuzz Flow",
      accountType: "DEPOSITORY",
      openingBalanceAsOfDate: daysAgo(VALUATION_ANCHOR_DAYS_AGO),
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId,
    user,
  })

  // Float as a genuine income row (the seedFixture discipline): the flow
  // side's Σ must stay backed 1:1 by ROWS — an opening value would be an
  // anchor, not a row, and conservation would then compare different things.
  await createTransactionForFamily({
    data: {
      id: factories.createIdempotencyKey(),
      idempotencyKey: factories.createIdempotencyKey(),
      accountId: flow.id,
      amount: OPENING_FLOAT,
      categoryId: incomeCategory.id,
      currency: "IDR",
      date: daysAgo(VALUATION_FLOAT_DAYS_AGO),
      description: "Valuation rig float",
      type: "income",
      isSplit: false,
      status: "CLEARED",
    },
    familyId,
    user,
  })

  // INVESTMENT defaults to balanceSource="transaction_flow"; the real flip
  // path (enableHoldingsTracking) converts it to "valuation" and seeds the
  // balance-preserving anchor (PER-266) in the same transaction.
  const investment = await createAccountForFamily({
    data: {
      name: "ValFuzz Investment",
      accountType: "INVESTMENT",
      openingBalance: "500000",
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId,
    user,
  })
  await enableHoldingsTrackingForFamily({
    data: {
      accountId: investment.id,
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId,
    user,
  })

  return {
    familyId,
    user,
    flowAccountId: flow.id,
    valuationAccountId: investment.id,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }
}

/** The ADR-0043 §5 ordering, re-derived HERE from the raw series as an
 * independent witness — the invariant must not ask production's own resolver
 * whether production is right. */
async function readLatestValuationValue(
  familyId: string,
  accountId: string
): Promise<bigint | null> {
  return await harness.withFamily(familyId, async (tx) => {
    const latest = await tx.valuation.findFirst({
      where: { accountId, familyId, deletedAt: null },
      orderBy: [
        { valuationDate: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: { value: true },
    })
    return latest ? latest.value : null
  })
}

async function applyValuationOps(
  fixture: ValuationFixture,
  ops: ValuationOp[]
): Promise<void> {
  const { familyId, user, flowAccountId, valuationAccountId } = fixture
  const liveTxIds: string[] = []

  for (const op of ops) {
    try {
      if (op.kind === "delete") {
        if (liveTxIds.length === 0) continue
        const idx = op.pick % liveTxIds.length
        await deleteTransactionForFamily({
          id: liveTxIds[idx],
          idempotencyKey: factories.createIdempotencyKey(),
          familyId,
          user,
        })
        liveTxIds.splice(idx, 1)
        continue
      }

      const id = factories.createIdempotencyKey()
      const idempotencyKey = factories.createIdempotencyKey()

      if (op.kind === "contribution" || op.kind === "withdrawal") {
        const latest = await readLatestValuationValue(
          familyId,
          valuationAccountId
        )
        if (latest === null) continue
        // Never CONSTRUCT a negative override: a magnitude violation is a Zod
        // rejection, not a domain rejection, and would rethrow as a false red.
        // Skip instead — the guaranteed-contribution probe keeps the gate safe.
        if (op.kind === "withdrawal" && latest < op.amount + op.drift) continue
        const contribution = op.kind === "contribution"
        const override = contribution
          ? latest + op.amount + op.drift
          : latest - op.amount - op.drift
        // Valuation-linked transfer (ADR-0048 §1): ONE Transaction leg on the
        // cash side; the tracked side is a fresh Valuation whose value is the
        // explicit override (a broker's number, drifted from the prefill).
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey,
            accountId: contribution ? flowAccountId : valuationAccountId,
            toAccountId: contribution ? valuationAccountId : flowAccountId,
            amount: op.amount,
            newValuationValue: override.toString(),
            currency: "IDR",
            date: new Date(),
            description: contribution ? "Fuzz contribution" : "Fuzz withdrawal",
            type: "transfer",
            isSplit: false,
            status: "CLEARED",
          },
          familyId,
          user,
        })
        valuationTransferShots++
        liveTxIds.push(id)
        continue
      }

      // Back-dated expense / income on the flow account only — the ticket's
      // "random back-dated transactions" half.
      await createTransactionForFamily({
        data: {
          id,
          idempotencyKey,
          accountId: flowAccountId,
          amount: op.amount,
          categoryId:
            op.kind === "expense"
              ? fixture.expenseCategoryId
              : fixture.incomeCategoryId,
          currency: "IDR",
          date: daysAgo(op.dateDaysAgo),
          description: `Fuzz ${op.kind}`,
          type: op.kind,
          isSplit: false,
          status: "CLEARED",
        },
        familyId,
        user,
      })
      liveTxIds.push(id)
    } catch (error) {
      if (isExpectedDomainRejection(error)) continue
      throw error
    }
  }
}

/** The Slice 4 contract, read straight from Postgres after every sequence:
 * no mutations, so it runs outside any rejection guard — a failure here IS the
 * property failing, full stop. */
async function assertNoFalseDrift(fixture: ValuationFixture): Promise<void> {
  const { familyId } = fixture

  // 1) CONSERVATION scoped to transaction_flow: the valuation account is SET
  //    from its series (never incremented) and its transfers write NO second
  //    Transaction leg, so it cannot — and must not — join the Σ.
  const scoped = await harness.withFamily(familyId, async (tx) => {
    const accounts = await tx.account.findMany({
      where: { familyId, balanceSource: "transaction_flow" },
      select: { balance: true },
    })
    const rows = await tx.transaction.findMany({
      where: { familyId, deletedAt: null },
      select: { amount: true },
    })
    return {
      balances: accounts.reduce((sum, a) => sum + a.balance, 0n),
      amounts: rows.reduce((sum, r) => sum + r.amount, 0n),
    }
  })
  expect(scoped.balances).toBe(scoped.amounts)

  // 2) The valuation account's balance IS its latest live valuation — the
  //    direct statement of "SET, never incremented".
  const series = await harness.withFamily(familyId, async (tx) => {
    const account = await tx.account.findUniqueOrThrow({
      where: { id: fixture.valuationAccountId },
      select: { balance: true, balanceSource: true },
    })
    const latest = await tx.valuation.findFirst({
      where: {
        accountId: fixture.valuationAccountId,
        familyId,
        deletedAt: null,
      },
      orderBy: [
        { valuationDate: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: { value: true },
    })
    return {
      balance: account.balance,
      balanceSource: account.balanceSource,
      latest: latest?.value ?? null,
    }
  })
  expect(series.balanceSource).toBe("valuation")
  expect(series.latest).not.toBeNull()
  expect(series.balance).toBe(series.latest)

  // 3) The ticket's literal sentence: zero MATERIALIZATION drift family-wide.
  const drifts = await harness.withFamily(familyId, async () =>
    detectBalanceDriftForFamily({ familyId, userId: fixture.user.id })
  )
  expect(drifts.filter((d) => d.kind === "MATERIALIZATION")).toEqual([])
}

describe("valuation no-false-drift (property-based, real Postgres) — PER-208", () => {
  test("INVARIANT: back-dated transactions + valuation-linked transfers raise no false MATERIALIZATION drift (PER-196 class)", async () => {
    valuationTransferShots = 0
    await fc.assert(
      fc
        .asyncProperty(valuationSequenceArb, async (ops) => {
          const fixture = await seedValuationFixture()
          await applyValuationOps(fixture, ops)
          await assertNoFalseDrift(fixture)
        })
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_VALUATION_RUNS }
    )
    // Coverage gate (Slice 4): the cross-class transfer path must have been
    // FIRING during this run — a property that never executed its probe is
    // green for the wrong reason.
    expect(valuationTransferShots).toBeGreaterThan(0)
  })
})

// ── SLICE 5 — tenant isolation (cross-family poison) ─────────────────────────
//
// Ticket: "operations on family A never read or mutate family B rows (RLS GUC)."
// The example-based suites (rls-guc-scoping, cross-tenant-fk,
// tenant-reference-validation) prove one hand-picked cross-family case at a
// time. What nobody enumerates is the LONG sequence: ordinary family-A
// operations with a cross-family POISON op spliced in at an arbitrary position
// — pointing at family B's account / category / merchant, or even issuing
// DELETE against B's row under A's identity.
//
// Contract asserted after every sequence (all reads straight from Postgres):
//   P1 — every poison op is REJECTED with the precise error class
//        (TenantReferenceError for cross-family references; "Transaction not
//        found!" for the delete) — asserted OUTSIDE the domain-rejection
//        guard, whose message regex would otherwise swallow a failed
//        expectation as an "expected rejection" (Slice 2/3 lesson).
//   P2 — family B's entire state (per-account balances, live rows, audits,
//        idempotency records) is bit-identical before vs after the sequence.
//   P3 — family A's view never contains a family-B row, while the same rows
//        ARE visible in B's own scope — the null is isolation, not a broken
//        fixture.
//   P4 — family A's own books still balance: poison never corrupts A either.
//
// The harness role cannot bypass RLS (tests/integration/support/database.ts
// refuses to run otherwise), so P3 is a real database-boundary assertion.
//
// Coverage gate: `withTenantProbe` guarantees ≥ one poison op per sequence
// and `tenantPoisonShots > 0` is asserted after `fc.assert` — the same gate
// discipline as `deleteAgainShots` / `valuationTransferShots`.

type TenantOp =
  | { kind: "expense"; account: number; amount: bigint }
  | { kind: "income"; account: number; amount: bigint }
  | { kind: "transfer"; from: number; toOffset: number; amount: bigint }
  | { kind: "delete"; pick: number }
  // Poison variants: act AS family A while pointing at family B's rows.
  | { kind: "poisonAccount" }
  | { kind: "poisonTransferTo" }
  | { kind: "poisonCategory" }
  | { kind: "poisonMerchant" }
  | { kind: "poisonDelete" }

type PoisonOp = Extract<
  TenantOp,
  | { kind: "poisonAccount" }
  | { kind: "poisonTransferTo" }
  | { kind: "poisonCategory" }
  | { kind: "poisonMerchant" }
  | { kind: "poisonDelete" }
>

const NUM_TENANT_RUNS = 8
const MAX_TENANT_OPS = 4
const NUM_TENANT_ACCOUNTS = 2

const tenantOpArb: fc.Arbitrary<TenantOp> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("expense" as const),
      account: fc.nat({ max: NUM_TENANT_ACCOUNTS - 1 }),
      amount: amountArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("income" as const),
      account: fc.nat({ max: NUM_TENANT_ACCOUNTS - 1 }),
      amount: amountArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("transfer" as const),
      from: fc.nat({ max: NUM_TENANT_ACCOUNTS - 1 }),
      toOffset: fc.integer({ min: 1, max: NUM_TENANT_ACCOUNTS - 1 }),
      amount: amountArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      pick: pickArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("poisonAccount" as const) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("poisonTransferTo" as const) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("poisonCategory" as const) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("poisonMerchant" as const) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("poisonDelete" as const) }),
  }
)

// Shots fired by POISON ops across the whole run — asserted > 0 after
// `fc.assert` so "the cross-family path was actually exercised" can never be
// green by luck.
let tenantPoisonShots = 0

function isPoisonOp(op: TenantOp): op is PoisonOp {
  return op.kind.startsWith("poison")
}

/** Post-processing that makes cross-family coverage a GATE, not a lottery:
 * every sequence carries ≥ one poison op, so `tenantPoisonShots > 0` is
 * structurally satisfiable every run (same discipline as `withValuationProbe`). */
function withTenantProbe(ops: TenantOp[]): TenantOp[] {
  const next = [...ops]
  if (next.some(isPoisonOp)) return next
  next.push({ kind: "poisonAccount" })
  return next
}

const tenantSequenceArb: fc.Arbitrary<TenantOp[]> = fc
  .array(tenantOpArb, { maxLength: MAX_TENANT_OPS })
  .map(withTenantProbe)

interface TenantFamilyA {
  familyId: string
  user: { id: string; familyId?: string | null }
  accountIds: string[]
  expenseCategoryId: string
  incomeCategoryId: string
}

interface TenantFamilyB {
  familyId: string
  accountId: string
  categoryId: string
  merchantId: string
  transactionId: string
}

interface TenantFixture {
  familyA: TenantFamilyA
  familyB: TenantFamilyB
}

async function seedTenantFixture(): Promise<TenantFixture> {
  const ownerA = await factories.createAuthenticatedOnboardedUser()
  const ownerB = await factories.createAuthenticatedOnboardedUser()

  // Family A — the acting tenant: plain transaction_flow accounts seeded the
  // seedFixture way (opening float as a genuine income row, no anchors), so
  // scoped conservation is well-defined over whatever ops A applies.
  const accountIds: string[] = []
  for (let i = 0; i < NUM_TENANT_ACCOUNTS; i++) {
    const account = await factories.createAccount({
      familyId: ownerA.family.id,
      name: `Tenant A Acc ${i}`,
      accountType: "DEPOSITORY",
      currency: "IDR",
      balance: 0n,
    })
    accountIds.push(account.id)
  }
  const expenseCategory = await factories.createCategory({
    familyId: ownerA.family.id,
    name: "Tenant A Expense",
    type: "expense",
  })
  const incomeCategory = await factories.createCategory({
    familyId: ownerA.family.id,
    name: "Tenant A Income",
    type: "income",
  })
  for (const accountId of accountIds) {
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId,
        amount: OPENING_FLOAT,
        categoryId: incomeCategory.id,
        currency: "IDR",
        date: new Date("2026-01-01T00:00:00.000Z"),
        description: "Tenant rig float",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId: ownerA.family.id,
      user: ownerA.user,
    })
  }

  // Family B — the bait: real rows in a REAL second tenant, seeded through
  // factories (each factory call runs inside B's own GUC scope).
  const bAccount = await factories.createAccount({
    familyId: ownerB.family.id,
    name: "Tenant B Account",
    accountType: "DEPOSITORY",
    currency: "IDR",
    balance: 9_000_000n,
  })
  const bCategory = await factories.createCategory({
    familyId: ownerB.family.id,
    name: "Tenant B Expense",
    type: "expense",
  })
  const bMerchant = await factories.createMerchant({
    familyId: ownerB.family.id,
    name: "Tenant B Merchant",
  })
  const bTransaction = await factories.createTransaction({
    familyId: ownerB.family.id,
    accountId: bAccount.id,
    userId: ownerB.user.id,
    amount: -123_456n,
    categoryId: bCategory.id,
    merchantId: bMerchant.id,
    type: "expense",
  })

  return {
    familyA: {
      familyId: ownerA.family.id,
      user: ownerA.user,
      accountIds,
      expenseCategoryId: expenseCategory.id,
      incomeCategoryId: incomeCategory.id,
    },
    familyB: {
      familyId: ownerB.family.id,
      accountId: bAccount.id,
      categoryId: bCategory.id,
      merchantId: bMerchant.id,
      transactionId: bTransaction.id,
    },
  }
}

/** Family B's complete witness — read INSIDE B's own GUC scope. Any drift
 * between the before/after pair means an A-side operation mutated B. */
async function snapshotFamilyB(fixture: TenantFixture): Promise<{
  accountBalances: Array<readonly [string, bigint]>
  amounts: bigint
  rows: number
  audits: number
  idempotencyRecords: number
}> {
  return await harness.withFamily(fixture.familyB.familyId, async (tx) => {
    const accounts = await tx.account.findMany({
      select: { id: true, balance: true },
      orderBy: { id: "asc" },
    })
    const live = await tx.transaction.findMany({
      where: { deletedAt: null },
      select: { amount: true },
    })
    return {
      accountBalances: accounts.map(
        (account) => [account.id, account.balance] as const
      ),
      amounts: live.reduce((sum, row) => sum + row.amount, 0n),
      rows: await tx.transaction.count(),
      audits: await tx.auditLog.count(),
      idempotencyRecords: await tx.idempotencyRecord.count(),
    }
  })
}

/** P1: fire one poison op and assert the PRECISE rejection class. Runs OUTSIDE
 * the domain-rejection guard on purpose — a failed `expect` here IS the
 * property failing, and the guard's regex would swallow it as an "expected
 * rejection", turning a red silently green (Slice 2/3 lesson). A successful
 * poison (captured === null) fails `toBeInstanceOf` with the op kind printed. */
async function applyPoisonOp(
  fixture: TenantFixture,
  op: PoisonOp
): Promise<void> {
  const { familyA, familyB } = fixture
  tenantPoisonShots++

  let captured: unknown = null
  try {
    switch (op.kind) {
      case "poisonAccount": {
        await createTransactionForFamily({
          data: {
            id: factories.createIdempotencyKey(),
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: familyB.accountId,
            amount: 5_000n,
            categoryId: familyA.expenseCategoryId,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Poison: spend on family B's account",
            type: "expense",
            isSplit: false,
            status: "CLEARED",
          },
          familyId: familyA.familyId,
          user: familyA.user,
        })
        break
      }
      case "poisonTransferTo": {
        await createTransactionForFamily({
          data: {
            id: factories.createIdempotencyKey(),
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: familyA.accountIds[0],
            toAccountId: familyB.accountId,
            amount: 5_000n,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Poison: transfer into family B",
            type: "transfer",
            isSplit: false,
            status: "CLEARED",
          },
          familyId: familyA.familyId,
          user: familyA.user,
        })
        break
      }
      case "poisonCategory": {
        await createTransactionForFamily({
          data: {
            id: factories.createIdempotencyKey(),
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: familyA.accountIds[0],
            amount: 5_000n,
            categoryId: familyB.categoryId,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Poison: file under family B's category",
            type: "expense",
            isSplit: false,
            status: "CLEARED",
          },
          familyId: familyA.familyId,
          user: familyA.user,
        })
        break
      }
      case "poisonMerchant": {
        await createTransactionForFamily({
          data: {
            id: factories.createIdempotencyKey(),
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: familyA.accountIds[0],
            amount: 5_000n,
            merchantId: familyB.merchantId,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Poison: tag family B's merchant",
            type: "expense",
            isSplit: false,
            status: "CLEARED",
          },
          familyId: familyA.familyId,
          user: familyA.user,
        })
        break
      }
      case "poisonDelete": {
        await deleteTransactionForFamily({
          id: familyB.transactionId,
          idempotencyKey: factories.createIdempotencyKey(),
          familyId: familyA.familyId,
          user: familyA.user,
        })
        break
      }
    }
  } catch (error) {
    captured = error
  }

  if (op.kind === "poisonDelete") {
    // A cross-family id must be INVISIBLE under A's scope: the lookup misses
    // ("Transaction not found!"). TransactionGoneError would mean the row was
    // FOUND (wrong tenant saw a dead row); null would mean DELETE succeeded.
    expect(
      captured,
      `poison ${op.kind} must be rejected as not-found, got: ${String(captured)}`
    ).toBeInstanceOf(Error)
    expect((captured as Error).message).toMatch(/not found/i)
    return
  }

  expect(
    captured,
    `poison ${op.kind} was ACCEPTED — cross-family reference allowed! got: ${String(captured)}`
  ).toBeInstanceOf(TenantReferenceError)
}

async function applyTenantOps(
  fixture: TenantFixture,
  ops: TenantOp[]
): Promise<void> {
  const { familyA } = fixture
  const { familyId, user, accountIds } = familyA
  const liveTxIds: string[] = []

  for (const op of ops) {
    // Poison ops carry their own assertions and run OUTSIDE the guard — same
    // placement rationale as `replay` / `deleteAgain` (see applyOps).
    if (isPoisonOp(op)) {
      await applyPoisonOp(fixture, op)
      continue
    }

    try {
      if (op.kind === "delete") {
        if (liveTxIds.length === 0) continue
        const idx = op.pick % liveTxIds.length
        await deleteTransactionForFamily({
          id: liveTxIds[idx],
          idempotencyKey: factories.createIdempotencyKey(),
          familyId,
          user,
        })
        liveTxIds.splice(idx, 1)
        continue
      }

      const id = factories.createIdempotencyKey()
      const idempotencyKey = factories.createIdempotencyKey()

      if (op.kind === "transfer") {
        const from = op.from % accountIds.length
        const to = (from + op.toOffset) % accountIds.length
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey,
            accountId: accountIds[from],
            toAccountId: accountIds[to],
            amount: op.amount,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Tenant fuzz transfer",
            type: "transfer",
            isSplit: false,
            status: "CLEARED",
          },
          familyId,
          user,
        })
      } else {
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey,
            accountId: accountIds[op.account % accountIds.length],
            amount: op.amount,
            categoryId:
              op.kind === "expense"
                ? familyA.expenseCategoryId
                : familyA.incomeCategoryId,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: `Tenant fuzz ${op.kind}`,
            type: op.kind,
            isSplit: false,
            status: "CLEARED",
          },
          familyId,
          user,
        })
      }
      liveTxIds.push(id)
    } catch (error) {
      if (isExpectedDomainRejection(error)) continue
      throw error
    }
  }
}

/** The Slice 5 contract, read straight from Postgres after every sequence.
 * No mutations here, so it runs outside any rejection guard — a failure IS
 * the property failing, full stop. */
async function assertTenantIsolation(
  fixture: TenantFixture,
  bBefore: Awaited<ReturnType<typeof snapshotFamilyB>>
): Promise<void> {
  // P2 — family B is bit-identical: nothing A did touched a B row.
  const bAfter = await snapshotFamilyB(fixture)
  expect(bAfter).toEqual(bBefore)

  // P3a — family A's scope never sees a family-B row (RLS + tenant filters).
  const aView = await harness.withFamily(
    fixture.familyA.familyId,
    async (tx) => ({
      bAccount: await tx.account.findUnique({
        where: { id: fixture.familyB.accountId },
      }),
      bTransaction: await tx.transaction.findUnique({
        where: { id: fixture.familyB.transactionId },
      }),
      bMerchant: await tx.merchant.findUnique({
        where: { id: fixture.familyB.merchantId },
      }),
      accountIds: (await tx.account.findMany({ select: { id: true } })).map(
        (row) => row.id
      ),
    })
  )
  expect(aView.bAccount).toBeNull()
  expect(aView.bTransaction).toBeNull()
  expect(aView.bMerchant).toBeNull()
  expect(aView.accountIds).not.toContain(fixture.familyB.accountId)

  // P3b — sanity: the SAME rows are visible in B's own scope, so the nulls
  // above prove isolation rather than a fixture that never existed.
  const bVisible = await harness.withFamily(fixture.familyB.familyId, (tx) =>
    tx.account.findUnique({ where: { id: fixture.familyB.accountId } })
  )
  expect(bVisible).not.toBeNull()

  // P4 — family A's own books still balance: poison never corrupted A either.
  const scoped = await harness.withFamily(
    fixture.familyA.familyId,
    async (tx) => {
      const accounts = await tx.account.findMany({ select: { balance: true } })
      const rows = await tx.transaction.findMany({
        where: { deletedAt: null },
        select: { amount: true },
      })
      return {
        balances: accounts.reduce((sum, a) => sum + a.balance, 0n),
        amounts: rows.reduce((sum, r) => sum + r.amount, 0n),
      }
    }
  )
  expect(scoped.balances).toBe(scoped.amounts)
}

describe("tenant isolation (property-based, real Postgres) — PER-208", () => {
  test("INVARIANT: cross-family poison ops are always rejected, family B never mutates, family A never sees B's rows", async () => {
    tenantPoisonShots = 0
    await fc.assert(
      fc
        .asyncProperty(tenantSequenceArb, async (ops) => {
          const fixture = await seedTenantFixture()
          const bBefore = await snapshotFamilyB(fixture)
          await applyTenantOps(fixture, ops)
          await assertTenantIsolation(fixture, bBefore)
        })
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_TENANT_RUNS }
    )
    // Coverage gate (Slice 5): the cross-family poison path must have been
    // FIRING during this run — a property that never executed its probe is
    // green for the wrong reason.
    expect(tenantPoisonShots).toBeGreaterThan(0)
  })
})
