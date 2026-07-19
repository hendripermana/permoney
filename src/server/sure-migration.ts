import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  allowsNegativeAssetBalance,
  type AccountClass,
  type AccountType,
} from "../lib/accounts"
import type { CurrencyCode } from "../lib/data/currencies"
import {
  classifySureAmount,
  normalizeSureAccountType,
  orderCategoriesParentsFirst,
  pairSureTransfers,
  parseSureBundle,
  SURE_PROVIDER,
  type ParsedSureBundle,
  type SureTransaction,
  type SureTransferAccountMeta,
  type SureTransferHeldReason,
  type SureTransferPairingResult,
  type SureTransferTier,
  type SureValuation,
} from "../lib/sure-migration"
import { toMinorUnits } from "../lib/money"
import { createUuidV7 } from "../lib/uuid-v7"
import {
  createImportBatchForFamily,
  promoteImportBatchForFamily,
  reviewImportRowsForFamily,
  type StagedRowInput,
} from "./imports"
import {
  type AuditLogEntry,
  auditLogs,
  createAuditContext,
} from "./middleware/audit"
import {
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { withBulkLedgerReplayBypass } from "./bulk-ledger-replay"
import {
  isUniqueConstraintError,
  type RunInTenantTransaction,
} from "./mutation-kit"
import { createTransactionForFamily, createdAuditEntries } from "./transactions"
import {
  createValuationForFamily,
  rebuildFamilyBalances,
  signMagnitudeForAccount,
} from "./valuations"

// ============================================================================
// PER-170 / ADR-0041 — Sure full-family migration (Phase 1), orchestration.
//
// One DEEP MODULE behind a single server fn. It reads `all.ndjson`, creates
// accounts / categories / merchants under durable `externalProvider="sure"`
// bindings, builds Sure-id → Permoney-id maps, then feeds transactions through
// the UNCHANGED PER-82 staging pipeline (stage → dedup → confirm → promote). It
// is NOT a new ledger writer — promotion reuses the one canonical create core.
//
// Re-running the whole migration is idempotent at every layer (ADR-0041 §7):
//   * accounts/categories/merchants — reused via the partial-unique binding,
//   * the batch — reused via `ImportBatch.contentHash = sha256(all.ndjson)`,
//   * each transaction row — its `promotionIdempotencyKey` is minted ONCE at
//     stage time and persisted, so re-promotion is a no-op at the
//     `Transaction (familyId, idempotencyKey)` backstop.
//
// The raw bundle is retained losslessly in `ImportBatchArtifact` (gzip BYTEA,
// `storageKind='inline_bytea'`) as tenant-private provenance and the durable
// source for the deferred Phase 2/3 entities (§8). Encryption-at-rest is the
// deployment's DB/disk-level encryption gated by RLS — NOT app-level column
// crypto — consistent with the same PII already living in Transaction/Account.
// ============================================================================

// Reject absurdly large bundles before parsing — protects the DB row, backups,
// and the import worker (aligned with the PER-164 large-import concern). The
// real validation bundle is ~1–2 MB (3002 transactions); 64 MiB is generous.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

// ADR-0044 §2/§4: bounded-transaction chunk size for the confirm→promote
// orchestration loop. Originally set to 250 from a ~2.5ms/row estimate (5-8x
// margin under Prisma's 5000ms interactive-tx default). Head-eng's real
// all.ndjson run (PER-182, 2026-07-06) measured the ACTUAL per-chunk cost at
// 250: 30.1s / ~9 chunks ≈ 3.3s/chunk (~13ms/row, not 2.5ms) — only a ~1.5x
// margin under the 5000ms budget, and head-eng hit one real 5039ms
// expired-transaction flake under load at that chunk size. Per ADR-0044 §2's
// own principle ("a future measurement showing a call site needs a different
// chunk size changes only that site's constant"), lowered to 100
// (≈1.3s/chunk at the same measured per-row cost, ~3.8x margin) — a
// measured correction, not a guess. LOCKSTEP INVARIANT (load-bearing):
// confirmation must never run more than one chunk ahead of promotion —
// `promoteImportBatchForFamily` has no row-subset filter, it always promotes
// every currently-`confirmed` row in the batch, so confirming the whole set
// up front before "promoting per chunk" would silently reproduce a single
// oversized promote transaction (ADR-0044 §4).
export const PROMOTE_CHUNK_SIZE = 100

// Per-phase wall-clock timings (ms) — ADR-0044 §5. Permanent import-
// observability, not throwaway diagnostic code; also what the ADR-0044 §6
// measurement-gate reads to decide whether the valuation/transfer candidate
// fixes are needed at all.
export interface SureMigrationTimings {
  accounts: number
  categories: number
  merchants: number
  valuations: number
  transactionsStage: number
  artifactRetention: number
  transactionsConfirm: number
  transactionsPromote: number
  transfers: number
  reconciliation: number
  rebuild: number
}

const sureMigrationInputSchema = z.object({
  filename: z.string().min(1).max(255),
  // Raw `all.ndjson` content. Phase 1a accepts it as a UTF-8 string over the
  // server-fn POST; a future slice may switch to multipart upload.
  bundle: z.string().min(1),
  // PER-188 — client-minted UUIDv7, the key into the ephemeral progress Map
  // below. Optional so existing callers (integration tests, any future
  // caller that doesn't care about live progress) don't have to pass one;
  // the function mints its own fallback when absent.
  importId: z.string().min(1).optional(),
})

export type SureMigrationInput = z.input<typeof sureMigrationInputSchema>

export interface SureMigrationResult {
  batchId: string
  replayed: boolean
  contentHash: string
  byteSize: number
  accounts: { created: number; reused: number }
  categories: { created: number; reused: number }
  merchants: { created: number; reused: number }
  transactions: {
    total: number
    staged: number
    promotedThisRun: number
    held: number
    zeroAmountSkipped: number
    invalidDateSkipped: number
  }
  // Reconciliation-anchor valuations written this run (ADR-0043 §5, PER-176).
  // `anchorsWritten` counts every Sure valuation successfully written as a
  // `type="reconciliation"` Valuation row (re-runs replay via the content-derived
  // idempotency key, not double-counted here since `createValuationForFamily`
  // returns the same row). `negativeSkipped` counts valuations skipped because
  // their amount was negative (never `abs()`'d — a defensive path, zero
  // occurrences verified against the real export).
  valuations: {
    anchorsWritten: number
    negativeSkipped: number
  }
  valuationsParsed: number
  malformedLines: number
  ignoredEntities: Record<string, number>
  // Transfer dual-leg pairing & promotion (ADR-0042). Leg-based so the reconcile
  // invariant `legsStaged === legsPromotedTotal + Σ heldLegsByReason` is exact for
  // any grouping. `legsPromotedTotal` is read from `rowStatus` AFTER the pass
  // (cumulative — stable across idempotent re-runs); `pairsPromotedThisRun` and
  // `pairedByTier` reflect only this run's work (0 on a clean re-run). Each held
  // leg carries exactly one DB-anchored reason (the first failing gate / structural
  // outcome), surfaced per-reason so the importer UI explains the WHY honestly.
  transfers: {
    legsSeen: number
    legsStaged: number
    pairsPromotedThisRun: number
    legsPromotedTotal: number
    pairedByTier: {
      deterministic: number
      clean: number
      resolvedCluster: number
    }
    heldLegsByReason: Record<SureTransferHeldReason, number>
  }
  // Post-promote closing anchors (ADR-0045's PER-182 amendment) — one final
  // `type="reconciliation"` Valuation per account asserting the "all legs"
  // projection, closing any gap left by legs Permoney's own staging gates
  // held. See writeSureFinalReconciliationAnchors.
  finalReconciliation: SureFinalReconciliationSummary
  timings: SureMigrationTimings
}

interface PermoneyAccountInfo {
  id: string
  currency: string
  isImportable: boolean
  balanceSource: string
  // ADR-0045: needed to decide whether a negative Sure valuation is a
  // legitimate carve-out anchor (DEPOSITORY/E_WALLET) or a data anomaly to
  // skip, in writeSureValuationAnchors below.
  accountType: AccountType
}

// ---------------------------------------------------------------------------
// Isomorphic byte helpers (Web Crypto + CompressionStream — no Node imports, so
// the module never pulls a Node-only dep into a client graph; ADR-0041 §1 keeps
// this a plain `.ts`, like `imports.ts`).
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

async function gzipBytes(
  input: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("gzip")
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  // The reader MUST drain concurrently with the write below, not after
  // (PER-181). A CompressionStream's internal readable-side queue has bounded
  // capacity; write()/close() can block on backpressure until it's drained.
  // Starting the read loop only after write()+close() deadlocks once the
  // compressed output exceeds that internal queue — reproduced standalone
  // with ordinary incompressible/JSON-shaped input from a few hundred KB up
  // (never triggers with highly-compressible input, which is why small
  // fixtures never caught this).
  const chunks: Uint8Array[] = []
  let total = 0
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
    }
  })()

  await writer.write(input)
  await writer.close()
  await drain

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Reconciliation-anchor valuations (ADR-0043 §5 / ADR-0041 §5, PER-176)
//
// Superseded design note: Phase-1/PER-174 picked ONE "best" valuation per
// account (kind-authoritative `opening_anchor`, or a date heuristic) to seed
// `Account.balance` directly. That entire subsystem is retired now that the
// balance CALCULATOR (ADR-0043) is anchor-aware: migration no longer decides
// or computes a balance at all — it writes every Sure valuation as its own
// `type="reconciliation"` anchor row (Sure's own `kind` becomes provenance-only,
// never routing logic) and lets `computeCanonicalBalance` derive the correct
// balance from the anchor chain + post-anchor flow. This reproduces Sure's own
// forward-calculator exactly, for cash AND investment accounts alike.
//
// Writes go through the canonical `createValuationForFamily` (no new ledger
// writer — same discipline PER-175 applied to transfers), so every anchor gets
// FX base-projection, audit, and idempotency for free. A negative Sure amount
// is SKIPPED + counted as an anomaly, never `abs()`'d: `createValuationForFamily`
// signs a non-negative magnitude by the account's `accountClass`, so silently
// flipping a negative would mask a real export sign anomaly (defensive path —
// verified zero occurrences in the real bundle).
//
// Idempotency key: a content-derived pseudo-UUIDv7 (SHA-256 of account + day +
// amount + currency, reshaped into the version/variant nibbles `uuidV7Schema`
// requires — it is a dedup TOKEN for `IdempotencyRecord`, never a real
// timestamp or an ordering key; the calculator's own tie-break is
// `valuationDate DESC, createdAt DESC, id DESC`). A re-run recomputes the
// identical key and replays through `createValuationForFamily`'s own
// endpoint-idempotency contract instead of duplicating an anchor — no separate
// find-before-create guard needed. Verified against the real export: zero
// `(account, day)` pairs carry more than one valuation, so this key never
// collapses two distinct anchors (it only collapses byte-identical repeats,
// which is correct to dedup). Forward-guard for a future bundle that DOES have
// same-day multiple valuations: write them in Sure's own source/file order so
// the last-written naturally wins the calculator's tie-break, matching Sure's
// own last-wins semantics — not built here since no real bundle exercises it.
// ---------------------------------------------------------------------------

async function deriveValuationIdempotencyKey(
  externalAccountId: string,
  day: string,
  amount: string,
  currency: string,
  prefix = "sure-valuation"
): Promise<string> {
  const hex = await sha256Hex(
    new TextEncoder().encode(
      `${prefix}:${externalAccountId}:${day}:${amount}:${currency}`
    )
  )
  const h = hex.padEnd(32, "0").slice(0, 32)
  const variantNibble = "89ab"[parseInt(h[16] ?? "0", 16) % 4]
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `7${h.slice(13, 16)}`,
    `${variantNibble}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-")
}

interface SureValuationAnchorSummary {
  anchorsWritten: number
  negativeSkipped: number
}

async function writeSureValuationAnchors(
  valuations: readonly SureValuation[],
  accountMap: ReadonlyMap<string, string>,
  accountInfo: ReadonlyMap<string, PermoneyAccountInfo>,
  familyId: string,
  user: { id: string; familyId?: string | null },
  runInTenantTransaction: RunInTenantTransaction
): Promise<SureValuationAnchorSummary> {
  let anchorsWritten = 0
  let negativeSkipped = 0

  for (const valuation of valuations) {
    const permoneyAccountId = accountMap.get(valuation.account_id)
    if (!permoneyAccountId) continue // unmappable — shell missing (shouldn't happen)
    const account = accountInfo.get(permoneyAccountId)
    if (!account) continue

    const date = new Date(valuation.date)
    if (Number.isNaN(date.getTime())) continue // unparseable date — skip, never rejects the bundle

    const minor = toMinorUnits(
      valuation.amount,
      valuation.currency as CurrencyCode
    ) as bigint
    // ADR-0045: a negative Sure valuation is a genuine anchor (not an
    // anomaly) only for a carve-out account (DEPOSITORY/E_WALLET real
    // overdraft — the Dana case). For every other accountType, negative
    // stays the pre-existing anomaly (PER-176 Q2): skip the single row,
    // never abs() it, count it, never reject the whole bundle for it.
    if (minor < 0n && !allowsNegativeAssetBalance(account.accountType)) {
      negativeSkipped += 1
      continue
    }

    const idempotencyKey = await deriveValuationIdempotencyKey(
      valuation.account_id,
      valuation.date.slice(0, 10),
      valuation.amount,
      valuation.currency
    )

    await createValuationForFamily({
      data: {
        accountId: permoneyAccountId,
        value: minor.toString(),
        currency: valuation.currency,
        valuationDate: date,
        type: "reconciliation",
        source: "migration:sure",
        idempotencyKey,
      },
      familyId,
      user,
      runInTenantTransaction,
    })
    anchorsWritten += 1
  }

  return { anchorsWritten, negativeSkipped }
}

// ---------------------------------------------------------------------------
// ADR-0044 §8 — Pre-flight validator (PER-182). Projects every Sure account's
// FINAL balance PURELY from the parsed bundle (no DB read/write) using the
// same anchor + post-anchor-flow formula as ADR-0043 §2's `computeCanonicalBalance`,
// then evaluates it against ADR-0045's sign rule. A bundle that would leave
// any account illegal never touches the database. The projection formula
// must stay in lockstep with `computeCanonicalBalance` — an integration test
// asserts `projectedBalance === Account.balance` after the mandatory final
// rebuild, per account, for every fixture (so the two can never silently
// disagree, mirroring ADR-0043 §6's "one segmentation function" discipline).
// ---------------------------------------------------------------------------

export interface SureMigrationPreflightViolation {
  sureAccountId: string
  accountName: string
  accountType: AccountType
  accountClass: AccountClass
  projectedBalance: string
  violatedRule: string
}

/**
 * Raised when the pre-flight pass finds one or more accounts whose projected
 * FINAL balance would violate ADR-0045's sign rule. Thrown before step 1
 * (account shells) — zero DB writes occur for a bundle that would fail.
 */
export class SureMigrationPreflightError extends Error {
  override readonly name = "SureMigrationPreflightError"
  readonly statusCode = 422
  constructor(readonly violations: SureMigrationPreflightViolation[]) {
    super(
      `Sure migration pre-flight failed for ${violations.length} account(s): ` +
        violations
          .map(
            (v) =>
              `"${v.accountName}" (${v.accountType}) would end at ${v.projectedBalance} — ${v.violatedRule}`
          )
          .join("; ")
    )
  }
}

interface PreflightAccountFacts {
  name: string
  currency: string
  accountType: AccountType
  accountClass: AccountClass
  balanceSource: string
}

// -Infinity when there is no anchor at all — every promotable flow counts,
// which is exactly right: a fresh account shell starts at balance=0, so
// "anchor value 0, cutoff before all time" is mathematically identical to
// the real no-anchor fallback (stored balance, which for a brand-new shell
// accumulates to exactly Σ promotable flow via per-transaction increments —
// PER-176 Q2's "Borrow money from Abah" case).
function anchorCutoffMillis(isoDay: string | null): number {
  return isoDay === null
    ? Number.NEGATIVE_INFINITY
    : new Date(`${isoDay}T00:00:00.000Z`).getTime()
}

export interface SureMigrationAccountProjection {
  sureAccountId: string
  accountName: string
  accountType: AccountType
  accountClass: AccountClass
  projectedBalance: bigint
  // ISO day (YYYY-MM-DD) of the account's latest known activity (anchor or
  // any Sure leg), or null if the account has neither. Consumed by
  // writeSureFinalReconciliationAnchors to date the final anchor safely
  // after every real event, so zero flow is ever counted after it.
  lastActivityDay: string | null
}

/**
 * Pure per-account FINAL-balance projection from the parsed bundle alone (no
 * DB read/write) — the in-memory twin of `computeCanonicalBalance` (ADR-0043
 * §2). Exported separately from the violation-finder below so a test can
 * assert this projection equals the real post-rebuild `Account.balance` for
 * every account, pinning the two formulas together (ADR-0043 §6 discipline).
 */
export function projectSureMigrationBalances(
  bundle: ParsedSureBundle
): Map<string, SureMigrationAccountProjection> {
  const now = Date.now()
  const factsById = new Map<string, PreflightAccountFacts>()
  for (const account of bundle.accounts) {
    const taxonomy = normalizeSureAccountType(
      account.accountable_type,
      account.subtype
    )
    factsById.set(account.id, {
      name: account.name,
      currency: account.currency,
      accountType: taxonomy.accountType,
      accountClass: taxonomy.accountClass,
      balanceSource: taxonomy.balanceSource,
    })
  }

  // Latest ANCHOR per account, mirroring writeSureValuationAnchors' negative-
  // skip rule (ADR-0045) and the (valuationDate DESC, createdAt DESC)
  // tie-break: every Sure valuation is written in bundle array order, so a
  // later same-day entry naturally wins by processing order (`day >= existing.day`).
  const anchorById = new Map<string, { value: bigint; day: string }>()
  for (const valuation of bundle.valuations) {
    const facts = factsById.get(valuation.account_id)
    if (!facts) continue
    const date = new Date(valuation.date)
    if (Number.isNaN(date.getTime()) || date.getTime() > now) continue
    const minor = toMinorUnits(
      valuation.amount,
      valuation.currency as CurrencyCode
    ) as bigint
    if (minor < 0n && !allowsNegativeAssetBalance(facts.accountType)) continue
    // Mirror createValuationForFamily's EXACT signing branch (ADR-0045): a
    // negative raw value (carve-out only) is used as-is; a non-negative raw
    // value is signed via signMagnitudeForAccount, which NEGATES it for
    // LIABILITY — Sure exports a loan's valuation as a positive magnitude
    // (debt owed), Permoney stores the anchor negative. Reusing the real
    // writer's own signing helper (not reimplementing it) is load-bearing:
    // an earlier cut of this projection reimplemented the sign logic
    // independently and silently dropped this negation, producing
    // false-positive pre-flight rejections on the real bundle (verified by
    // head-eng against the real Sure UI: CC Bank Mega, Tunaiku, Abah, Pinjem).
    const signedValue: bigint =
      minor < 0n ? minor : signMagnitudeForAccount(facts.accountClass, minor)
    const day = valuation.date.slice(0, 10)
    const existing = anchorById.get(valuation.account_id)
    if (!existing || day >= existing.day) {
      anchorById.set(valuation.account_id, { value: signedValue, day })
    }
  }

  const projected = new Map<string, bigint>()
  const lastActivityDay = new Map<string, string>()
  for (const [accountId, anchor] of anchorById) {
    projected.set(accountId, anchor.value)
    lastActivityDay.set(accountId, anchor.day)
  }
  const addFlow = (
    accountId: string,
    date: Date,
    day: string,
    delta: bigint
  ) => {
    if (!factsById.has(accountId)) return
    const existingLast = lastActivityDay.get(accountId)
    if (!existingLast || day > existingLast) {
      lastActivityDay.set(accountId, day)
    }
    const cutoff = anchorCutoffMillis(anchorById.get(accountId)?.day ?? null)
    if (date.getTime() <= cutoff) return
    projected.set(accountId, (projected.get(accountId) ?? 0n) + delta)
  }

  // ADR-0045/ADR-0044 §8 (revised, PER-182 head-eng adu 2026-07-06): the flow
  // sum is over EVERY Sure leg for the account — standard transactions AND
  // transfer legs, PROMOTED or HELD alike — using each leg's OWN signed
  // amount and currency directly. This is deliberately NOT the "promoted
  // set": Permoney's own gating (non-importable counterpart, ambiguous
  // cluster, currency mismatch, orphan…) is a Permoney-side staging concern
  // that Sure's own forward-calculator knows nothing about. Projecting the
  // promoted-only set was the earlier design and produced false-positive
  // violations whenever a real account had ANY held leg (Tabungan Nikah and
  // others) — this "all legs" sum is exactly what the new post-promote final
  // reconciliation anchor (writeSureFinalReconciliationAnchors) asserts, so
  // pre-flight and the final anchor can never disagree (ADR-0043 §6
  // discipline: one segmentation function, not two).
  //
  // EXCEPTION (ADR-0034 §5, unchanged by any of the above): a
  // balanceSource="valuation" account (TRACKED_ASSET) never derives its
  // balance from transaction flow at all — its balance is strictly the
  // latest valuation. Flow must not be applied here regardless of promoted/
  // held status, or a held (never-promoted, by taxonomy) standard
  // transaction on a tracked account would corrupt its projection.
  //
  // A leg whose OWN currency doesn't match its OWN account's currency is
  // excluded, not converted: `toMinorUnits(txn.amount, txn.currency)` counts
  // minor units of WHATEVER currency the leg claims, and adding that number
  // straight onto a balance denominated in the account's (different)
  // currency is unit-mismatched — mixing cents into a yen balance. This is
  // NOT the same case as a legitimate cross-currency TRANSFER pair (e.g. an
  // IDR outflow leg paired with a USD inflow leg): there, each leg's OWN
  // currency already matches its OWN account, so each is counted correctly
  // in isolation — no pairing logic is needed here at all, only a per-leg
  // self-consistency check. FX conversion for a real mismatch is ADR-0035/
  // PER-147's job, not this projection's; excluding it here matches
  // `isPromotable`'s own currency gate for the promoted-only path.
  // PER-184 carve-out from the "all legs, promoted or held alike" doctrine
  // above: `excluded: true` marks a Sure split-transaction PARENT row (full
  // receipt amount) whose CHILD rows are separate, normal legs in this same
  // `bundle.transactions` array that already sum to the parent. Unlike an
  // ordinary held leg (non-importable counterpart, currency mismatch,
  // ambiguous cluster…) — where the money is real and uncounted anywhere else,
  // so the final anchor must absorb it — an excluded parent's money is ALREADY
  // counted via its children. Including it here would double it. This applies
  // regardless of `kind` (defensive: no real-data evidence of an excluded
  // transfer leg, but the check is free and keeps this loop's predicate exact).
  for (const txn of bundle.transactions) {
    if (txn.excluded === true) continue
    const facts = factsById.get(txn.account_id)
    if (!facts || facts.balanceSource !== "transaction_flow") continue
    if (txn.currency !== facts.currency) continue
    const date = new Date(txn.date)
    if (Number.isNaN(date.getTime())) continue
    const minor = toMinorUnits(
      txn.amount,
      txn.currency as CurrencyCode
    ) as bigint
    addFlow(txn.account_id, date, txn.date.slice(0, 10), -minor)
  }

  const result = new Map<string, SureMigrationAccountProjection>()
  for (const [accountId, facts] of factsById) {
    result.set(accountId, {
      sureAccountId: accountId,
      accountName: facts.name,
      accountType: facts.accountType,
      accountClass: facts.accountClass,
      projectedBalance: projected.get(accountId) ?? 0n,
      lastActivityDay: lastActivityDay.get(accountId) ?? null,
    })
  }
  return result
}

/**
 * Evaluates `projectSureMigrationBalances`' output against ADR-0045's sign
 * rule and returns every violation (collect-all, not fail-on-first — a
 * bundle with two bad accounts should report both in one pass).
 */
function findSureMigrationPreflightViolations(
  bundle: ParsedSureBundle
): SureMigrationPreflightViolation[] {
  const projections = projectSureMigrationBalances(bundle)
  const violations: SureMigrationPreflightViolation[] = []
  for (const projection of projections.values()) {
    const { accountClass, accountType, projectedBalance } = projection
    const legal =
      accountClass === "ASSET"
        ? projectedBalance >= 0n || allowsNegativeAssetBalance(accountType)
        : projectedBalance <= 0n
    if (!legal) {
      violations.push({
        sureAccountId: projection.sureAccountId,
        accountName: projection.accountName,
        accountType,
        accountClass,
        projectedBalance: projectedBalance.toString(),
        violatedRule:
          accountClass === "ASSET"
            ? `ASSET balance must be >= 0 for accountType ${accountType}`
            : "LIABILITY balance must be <= 0",
      })
    }
  }
  return violations
}

export interface SureFinalReconciliationSummary {
  anchorsWritten: number
}

/**
 * ADR-0045's PER-182 amendment (head-eng adu 2026-07-06) — the post-promote
 * closing step. Writes ONE final `type="reconciliation"` Valuation per
 * account, asserting exactly `projectSureMigrationBalances`' projection — the
 * same "all legs" value pre-flight already verified is legal. Dated one day
 * after the account's last known activity (its latest anchor or any Sure
 * leg), so under ADR-0043's anchor-chain formula this anchor is
 * unconditionally the effective one with zero flow ever counted after it:
 * the materialized balance becomes exactly this asserted value, closing any
 * gap left by legs Permoney's own staging gates held (non-importable
 * counterpart, ambiguous cluster, currency mismatch, orphan…) — a
 * source-data ASSERTION, not a fabricated plug (ADR-0043's own anchor
 * model), functioning as this migration's ground truth. Every account gets
 * one, unconditionally (not only ones with a detected gap), so the
 * mechanism needs no per-account special-casing.
 */
async function writeSureFinalReconciliationAnchors(
  bundle: ParsedSureBundle,
  accountMap: ReadonlyMap<string, string>,
  familyId: string,
  user: { id: string; familyId?: string | null },
  runInTenantTransaction: RunInTenantTransaction
): Promise<SureFinalReconciliationSummary> {
  const projections = projectSureMigrationBalances(bundle)
  const currencyById = new Map(bundle.accounts.map((a) => [a.id, a.currency]))
  let anchorsWritten = 0

  for (const projection of projections.values()) {
    if (!projection.lastActivityDay) continue // no activity — nothing to close
    const permoneyAccountId = accountMap.get(projection.sureAccountId)
    if (!permoneyAccountId) continue
    const currency = currencyById.get(projection.sureAccountId)
    if (!currency) continue

    const anchorDate = new Date(`${projection.lastActivityDay}T00:00:00.000Z`)
    anchorDate.setUTCDate(anchorDate.getUTCDate() + 1)

    // createValuationForFamily expects a non-negative MAGNITUDE for LIABILITY
    // (it negates internally via signMagnitudeForAccount, mirroring every
    // other liability valuation write) but the ALREADY-SIGNED value for
    // ASSET carve-out types (it uses a negative input as-is). projectedBalance
    // is always the final Permoney-signed value; convert only for LIABILITY.
    const magnitudeValue = (
      projection.accountClass === "LIABILITY" &&
      projection.projectedBalance < 0n
        ? -projection.projectedBalance
        : projection.projectedBalance
    ).toString()

    const idempotencyKey = await deriveValuationIdempotencyKey(
      projection.sureAccountId,
      projection.lastActivityDay,
      projection.projectedBalance.toString(),
      currency,
      "sure-final-reconciliation"
    )

    await createValuationForFamily({
      data: {
        accountId: permoneyAccountId,
        value: magnitudeValue,
        currency,
        valuationDate: anchorDate,
        type: "reconciliation",
        source: "migration:sure",
        idempotencyKey,
      },
      familyId,
      user,
      runInTenantTransaction,
    })
    anchorsWritten += 1
  }

  return { anchorsWritten }
}

// ---------------------------------------------------------------------------
// Transfer pairing inputs (pure, taxonomy-derived — ADR-0042)
// ---------------------------------------------------------------------------

/** Any non-`standard` Sure kind is a transfer leg in Phase 1 (held until paired). */
function isSureTransferLeg(txn: SureTransaction): boolean {
  const kind = (txn.kind ?? "standard").trim() || "standard"
  return kind !== "standard"
}

/** Per-Sure-account metadata for the pure pairer (no DB; mirrors the staging taxonomy). */
export function buildSureTransferMeta(
  bundle: ReturnType<typeof parseSureBundle>
): Map<string, SureTransferAccountMeta> {
  const meta = new Map<string, SureTransferAccountMeta>()
  for (const account of bundle.accounts) {
    const taxonomy = normalizeSureAccountType(
      account.accountable_type,
      account.subtype
    )
    meta.set(account.id, {
      sureAccountId: account.id,
      name: account.name,
      currency: account.currency,
      accountType: taxonomy.accountType,
      isImportable: taxonomy.isImportable,
      balanceSource: taxonomy.balanceSource,
    })
  }
  return meta
}

/**
 * The transfer legs that WILL be staged — mappable account, valid date, non-zero
 * amount: exactly the gates the standard staging path applies. Feeding the pure
 * pairer this same set keeps `gateSet === promoteSet` (the unmappable-leg lockstep
 * that protects the opening pre-scan, ADR-0042 / ADR-0041 §5).
 */
export function stageableSureTransferLegs(
  bundle: ReturnType<typeof parseSureBundle>,
  metaById: ReadonlyMap<string, SureTransferAccountMeta>
): SureTransaction[] {
  return bundle.transactions.filter((txn) => {
    if (!isSureTransferLeg(txn)) return false
    const meta = metaById.get(txn.account_id)
    if (!meta) return false
    if (Number.isNaN(new Date(txn.date).getTime())) return false
    const minor = toMinorUnits(
      txn.amount,
      meta.currency as CurrencyCode
    ) as bigint
    return minor !== 0n
  })
}

// ---------------------------------------------------------------------------
// Promotion gating (ADR-0041 §6)
// ---------------------------------------------------------------------------

// Phase-1 promotion gate. Exported so the client-side preview classifier in
// `src/lib/sure-migration.ts` can be parity-tested against the REAL server
// verdict (not a hand-written copy). Behavior-neutral export — see PER-171.
export function isPromotable(
  txn: SureTransaction,
  account: PermoneyAccountInfo
): boolean {
  const kind = (txn.kind ?? "standard").trim() || "standard"
  if (kind !== "standard") return false
  if (!account.isImportable || account.balanceSource !== "transaction_flow") {
    return false
  }
  if (txn.currency !== account.currency) return false
  if (txn.split_lines && txn.split_lines.length > 0) return false
  // PER-184: `excluded: true` is Sure's split-transaction representation (the
  // full-amount parent row); its child rows are separate normal, categorized
  // transactions that already sum to the parent. Promoting the parent too
  // would double the flow — hold it as provenance, mirroring `sureHeldReason`
  // (src/lib/sure-migration.ts) precedence exactly.
  if (txn.excluded === true) return false
  return true
}

// ---------------------------------------------------------------------------
// Orchestration (testable entry — mirrors createImportBatchForFamily shape)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PER-188 — ephemeral, observational import progress (polling side-channel).
//
// Grilled decision (see per-188-importer-copy-progress-design memory, locked
// decision 4): NOT a streamed Response. `runSureMigrationFn` stays a normal
// awaited call returning the typed `SureMigrationResult` above — that typed
// contract is load-bearing (CLAUDE.md "return values are the type
// contract") and a long-lived streaming response sits behind Cloudflare's
// ~100s origin timeout for no benefit here. Instead: the client polls
// `getSureImportProgressFn` every ~1s while the main request is in flight.
//
// This Map is a side-effect-free module-scope singleton (same discipline as
// `fallbackMap` in `middleware/rate-limit.ts`) — NEVER the source of truth.
// The import's actual correctness comes entirely from the idempotent,
// awaited `runSureMigrationForFamily` call; if the client's poll never sees a
// single update (process restart, wrong instance, tab closed and reopened),
// the import itself is unaffected and a re-call with the same `importId`
// replays safely (PER-179/190 structural idempotency).
//
// CAVEAT (documented, not hidden): this Map is single-instance. Permoney
// runs one prod container today, so "poll lands on the instance running the
// migration" always holds. If Permoney horizontal-scales, a poll can land on
// a different instance and see nothing — move this to Redis/DB at that point
// (the client already degrades gracefully to an indeterminate state on a
// miss, so this isn't a correctness cliff, just a UX one).
export type SureImportPhase =
  | "staging"
  | "pairing_transfers"
  | "reconciling"
  | "finalizing"

export interface SureImportProgressSnapshot {
  phase: SureImportPhase
  staged: number
  promoted: number
  heldSoFar: number
  updatedAt: number
}

interface SureImportProgressEntry extends SureImportProgressSnapshot {
  familyId: string
}

const IMPORT_PROGRESS_MAX_AGE_MS = 10 * 60 * 1000 // 10 min — sweep window

const importProgress = new Map<string, SureImportProgressEntry>()

function sweepStaleImportProgress(): void {
  const cutoff = Date.now() - IMPORT_PROGRESS_MAX_AGE_MS
  for (const [id, entry] of importProgress) {
    if (entry.updatedAt < cutoff) importProgress.delete(id)
  }
}

function setImportProgress(
  importId: string,
  familyId: string,
  patch: Partial<Omit<SureImportProgressSnapshot, "updatedAt">> & {
    phase: SureImportPhase
  }
): void {
  sweepStaleImportProgress()
  const previous = importProgress.get(importId)
  importProgress.set(importId, {
    staged: previous?.staged ?? 0,
    promoted: previous?.promoted ?? 0,
    heldSoFar: previous?.heldSoFar ?? 0,
    ...patch,
    familyId,
    updatedAt: Date.now(),
  })
}

const sureImportProgressInputSchema = z.object({
  importId: z.string().min(1),
})

// GET, not POST — this is a pure, cheap, idempotent read (no DB, no mutation).
export const getSureImportProgressFn = createServerFn({ method: "GET" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: unknown) => sureImportProgressInputSchema.parse(data))
  .handler(
    async ({ data, context }): Promise<SureImportProgressSnapshot | null> => {
      const entry = importProgress.get(data.importId)
      // Tenant isolation even though a UUIDv7 importId is practically
      // unguessable: never let one family's poll read another family's
      // in-flight progress counters.
      if (!entry || entry.familyId !== context.familyId) return null
      const { familyId: _familyId, ...snapshot } = entry
      return snapshot
    }
  )

export async function runSureMigrationForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SureMigrationResult> {
  const data = sureMigrationInputSchema.parse(rawData)
  const importId = data.importId ?? createUuidV7()
  setImportProgress(importId, familyId, {
    phase: "staging",
    staged: 0,
    promoted: 0,
    heldSoFar: 0,
  })

  const rawBytes = new TextEncoder().encode(data.bundle)
  if (rawBytes.length > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Sure bundle is ${rawBytes.length} bytes, exceeding the ${MAX_BUNDLE_BYTES}-byte limit`
    )
  }
  const contentHash = await sha256Hex(rawBytes)
  const auditCtx = await createAuditContext({ user })

  // ADR-0044 §5: permanent per-phase wall-clock instrumentation, printed by
  // callers/tests rather than asserted on in CI (wall-time is nondeterministic
  // — see ADR-0044 §6 measurement-gate discipline).
  const timings: SureMigrationTimings = {
    accounts: 0,
    categories: 0,
    merchants: 0,
    valuations: 0,
    transactionsStage: 0,
    artifactRetention: 0,
    transactionsConfirm: 0,
    transactionsPromote: 0,
    transfers: 0,
    reconciliation: 0,
    rebuild: 0,
  }

  const bundle = parseSureBundle(data.bundle)

  // Transfer pairing is computed PURELY and UP-FRONT (ADR-0042): the promotable
  // pairs feed the later promotion step. `promotableTransferLegIds` is no longer
  // consumed by any opening-balance pre-scan (ADR-0043/PER-176 — the calculator
  // derives balance from anchors, migration no longer computes one).
  const transferMeta = buildSureTransferMeta(bundle)
  const transferLegs = stageableSureTransferLegs(bundle, transferMeta)
  const transferLegsSeen = bundle.transactions.filter(isSureTransferLeg).length
  const transferPairing = pairSureTransfers({
    legs: transferLegs,
    metaById: transferMeta,
    transfers: bundle.transfers,
  })

  // --- 0. Pre-flight (ADR-0044 §8 / ADR-0045): fail fast, zero DB writes ----
  // Pure in-memory projection of every account's FINAL balance from the
  // bundle alone. Runs before any write (including account shells) so a
  // bundle that would leave any account illegal never touches the database.
  const preflightViolations = findSureMigrationPreflightViolations(bundle)
  if (preflightViolations.length > 0) {
    throw new SureMigrationPreflightError(preflightViolations)
  }

  // ADR-0044 §8: the ONLY 3 phases below that do incremental Account.balance/
  // Valuation writes before the mandatory final (unbypassed) rebuild use this
  // wrapper — valuations (anchors), transaction promote-chunk (not staging/
  // confirm), and transfer-pair promotion. Composes over whatever
  // `runInTenantTransaction` was passed in (production default or a test
  // double), so test injection (crash/chunk-tracking harnesses) is unaffected.
  const bulkReplayTx = withBulkLedgerReplayBypass(runInTenantTransaction)

  // --- 1. Accounts -> id-map (+ account info for mapping) -------------------
  // ADR-0043/PER-176: no opening-balance decision at creation time — every
  // account shell starts at balance=0. Step 4 below writes every Sure
  // valuation as a reconciliation anchor, and the final rebuild (step 7)
  // derives the real balance from the anchor chain + promoted flow.
  const accountMap = new Map<string, string>() // sureId -> permoneyId
  const accountInfo = new Map<string, PermoneyAccountInfo>() // permoneyId -> info
  let accountsCreated = 0
  let accountsReused = 0

  const accountsT0 = Date.now()
  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const auditEntries: AuditLogEntry[] = []
    for (const sureAccount of bundle.accounts) {
      const reused = await reuseAccount(tx, familyId, sureAccount.id)
      if (reused) {
        accountMap.set(sureAccount.id, reused.id)
        accountInfo.set(reused.id, reused)
        accountsReused += 1
        continue
      }
      const taxonomy = normalizeSureAccountType(
        sureAccount.accountable_type,
        sureAccount.subtype
      )
      const created = await tx.account.create({
        data: {
          familyId,
          name: sureAccount.name,
          accountClass: taxonomy.accountClass,
          accountType: taxonomy.accountType,
          accountSubtype: taxonomy.accountSubtype,
          balanceSource: taxonomy.balanceSource,
          balance: 0n,
          currency: sureAccount.currency,
          isImportable: taxonomy.isImportable,
          externalProvider: SURE_PROVIDER,
          externalAccountId: sureAccount.id,
          status: "active",
        },
      })
      accountMap.set(sureAccount.id, created.id)
      accountInfo.set(created.id, {
        id: created.id,
        currency: created.currency,
        isImportable: created.isImportable,
        balanceSource: created.balanceSource,
        accountType: created.accountType as AccountType,
      })
      accountsCreated += 1
      auditEntries.push(...createdAuditEntries("Account", [created]))
    }
    await auditLogs(tx, auditCtx, withFamily(auditEntries, familyId))
  })
  timings.accounts = Date.now() - accountsT0

  // --- 2. Categories -> id-map (two-pass: parents before children) ----------
  const categoryMap = new Map<string, string>()
  let categoriesCreated = 0
  let categoriesReused = 0

  const categoriesT0 = Date.now()
  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const auditEntries: AuditLogEntry[] = []
    for (const sureCategory of orderCategoriesParentsFirst(bundle.categories)) {
      const reused = await reuseBoundId(
        tx,
        "category",
        familyId,
        sureCategory.id
      )
      if (reused) {
        categoryMap.set(sureCategory.id, reused)
        categoriesReused += 1
        continue
      }
      const parentId = sureCategory.parent_id
        ? (categoryMap.get(sureCategory.parent_id) ?? null)
        : null
      const created = await tx.category.create({
        data: {
          familyId,
          name: sureCategory.name,
          type: sureCategory.classification,
          color: sureCategory.color ?? "#6172F3",
          icon: sureCategory.lucide_icon ?? "shapes",
          parentId,
          isSystem: false,
          externalProvider: SURE_PROVIDER,
          externalId: sureCategory.id,
        },
      })
      categoryMap.set(sureCategory.id, created.id)
      categoriesCreated += 1
      auditEntries.push(...createdAuditEntries("Category", [created]))
    }
    await auditLogs(tx, auditCtx, withFamily(auditEntries, familyId))
  })
  timings.categories = Date.now() - categoriesT0

  // --- 3. Merchants -> id-map ----------------------------------------------
  const merchantMap = new Map<string, string>()
  let merchantsCreated = 0
  let merchantsReused = 0

  const merchantsT0 = Date.now()
  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const auditEntries: AuditLogEntry[] = []
    for (const sureMerchant of bundle.merchants) {
      const reused = await reuseBoundId(
        tx,
        "merchant",
        familyId,
        sureMerchant.id
      )
      if (reused) {
        merchantMap.set(sureMerchant.id, reused)
        merchantsReused += 1
        continue
      }
      const created = await tx.merchant.create({
        data: {
          familyId,
          name: sureMerchant.name,
          color: sureMerchant.color ?? null,
          logoUrl: sureMerchant.logo_url ?? null,
          externalProvider: SURE_PROVIDER,
          externalId: sureMerchant.id,
        },
      })
      merchantMap.set(sureMerchant.id, created.id)
      merchantsCreated += 1
      auditEntries.push(...createdAuditEntries("Merchant", [created]))
    }
    await auditLogs(tx, auditCtx, withFamily(auditEntries, familyId))
  })
  timings.merchants = Date.now() - merchantsT0

  // --- 4. Write every Sure valuation as a reconciliation anchor (ADR-0043) --
  // Runs after account shells exist (needs accountMap) and before transaction
  // promotion — order doesn't affect final correctness (step 10's rebuild fixes
  // any intermediate state), this is just the natural shell→history reading
  // order. See writeSureValuationAnchors above for the write/idempotency design.
  const valuationsT0 = Date.now()
  const anchorSummary = await writeSureValuationAnchors(
    bundle.valuations,
    accountMap,
    accountInfo,
    familyId,
    user,
    bulkReplayTx
  )
  timings.valuations = Date.now() - valuationsT0

  // --- 5. Transactions -> StagedRowInput[] (per-row id remap + classify) ----
  const transactionsStageT0 = Date.now()
  const rows: StagedRowInput[] = []
  const promotableBySureId = new Map<string, boolean>()
  let zeroAmountSkipped = 0
  let invalidDateSkipped = 0

  for (const txn of bundle.transactions) {
    const permoneyAccountId = accountMap.get(txn.account_id)
    if (!permoneyAccountId) continue // unmappable — shell missing (shouldn't happen)
    const account = accountInfo.get(permoneyAccountId)
    if (!account) continue

    const date = new Date(txn.date)
    if (Number.isNaN(date.getTime())) {
      invalidDateSkipped += 1
      continue
    }

    const { type, absMinorUnits, isZeroAmount } = classifySureAmount(
      txn.amount,
      account.currency as CurrencyCode
    )
    // PER-82's staged amount is strictly positive minor units; a 0-amount Sure
    // entry can't be represented. It is retained in the artifact (lossless) and
    // counted here rather than staged (ADR-0041 §4.C "flagged for review").
    if (isZeroAmount) {
      zeroAmountSkipped += 1
      continue
    }

    const promotable = isPromotable(txn, account)
    promotableBySureId.set(txn.id, promotable)
    rows.push({
      accountId: permoneyAccountId,
      externalId: txn.id,
      rawPayload: { sureEntity: "Transaction", ...txn },
      date,
      amount: absMinorUnits.toString(),
      type,
      description: (txn.name ?? "").trim() || "Imported transaction",
      suggestedCategoryId: txn.category_id
        ? (categoryMap.get(txn.category_id) ?? null)
        : null,
      suggestedMerchantId: txn.merchant_id
        ? (merchantMap.get(txn.merchant_id) ?? null)
        : null,
    })
  }

  // --- 6. Stage through PER-82 (reuses the batch on re-run via contentHash) --
  let batchId: string
  let replayed: boolean
  if (rows.length > 0) {
    const batch = await createImportBatchForFamily({
      data: {
        sourceKind: "migration",
        provider: SURE_PROVIDER,
        contentHash,
        rows,
      },
      familyId,
      user,
      runInTenantTransaction,
    })
    batchId = batch.id
    replayed = batch.replayed
  } else {
    // Degraded bundle with zero stageable rows still gets a batch + artifact so
    // the raw provenance and the deferred-entity source are retained.
    batchId = await ensureEmptyMigrationBatch(
      runInTenantTransaction,
      familyId,
      user,
      contentHash,
      auditCtx
    )
    replayed = false
  }
  timings.transactionsStage = Date.now() - transactionsStageT0

  // --- 7. Retain the raw bundle (gzip BYTEA artifact, one-shot per content) --
  // PER-190: the existence-check is its own quick read, OUTSIDE the insert+
  // audit transaction, so that transaction stays minimal and well under the
  // 5s interactive-tx budget (ADR-0044 §5) — this gzip'd BYTEA insert sat
  // right at the edge under load with the check folded in. Splitting it opens
  // a theoretical TOCTOU gap (two imports of identical content racing between
  // the check and the insert), but that gap is already closed by the
  // `import_artifact_batch_content` unique index (PER-170): a losing insert
  // surfaces as P2002, caught below and treated as an idempotent no-op since
  // the artifact is already retained by the winner.
  const artifactRetentionT0 = Date.now()
  const gzip = await gzipBytes(rawBytes)
  const existingArtifact = await runInTenantTransaction(
    familyId,
    user.id,
    async (tx) =>
      tx.importBatchArtifact.findFirst({
        where: { importBatchId: batchId, contentHash },
        select: { id: true },
      })
  )
  if (!existingArtifact) {
    try {
      await runInTenantTransaction(familyId, user.id, async (tx) => {
        const created = await tx.importBatchArtifact.create({
          data: {
            familyId,
            importBatchId: batchId,
            filename: data.filename,
            storageKind: "inline_bytea",
            contentHash,
            byteSize: rawBytes.length,
            bytes: Buffer.from(gzip),
          },
        })
        await auditLogs(
          tx,
          auditCtx,
          withFamily(
            createdAuditEntries("ImportBatchArtifact", [created]),
            familyId
          )
        )
      })
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
  }
  timings.artifactRetention = Date.now() - artifactRetentionT0

  // --- 8. Confirm gated rows that are still normalized, then promote --------
  // ADR-0044 §4 LOCKSTEP INVARIANT (load-bearing): confirm and promote exactly
  // one PROMOTE_CHUNK_SIZE-sized slice at a time, never confirming ahead of
  // promotion. `promoteImportBatchForFamily` has no row-subset filter — it
  // always promotes every currently-`confirmed` row in the batch — so
  // confirming the entire promotable set up front and "promoting per chunk"
  // afterward would silently reproduce a single oversized promote transaction,
  // exactly the timeout this ADR fixes.
  let promotedThisRun = 0
  if (rows.length > 0) {
    // Sweep leftovers first: rows a prior crashed run confirmed but never
    // promoted. Bounded by construction — the lockstep loop below never
    // confirms more than one chunk ahead of promoting it, so at most
    // PROMOTE_CHUNK_SIZE rows can be sitting confirmed-but-unpromoted when
    // this call starts. On a fresh (non-crashed) run this is a fast no-op.
    const sweepT0 = Date.now()
    const sweep = await promoteImportBatchForFamily({
      data: { batchId, idempotencyKey: createUuidV7() },
      familyId,
      user,
      runInTenantTransaction: bulkReplayTx,
    })
    timings.transactionsPromote += Date.now() - sweepT0
    promotedThisRun += sweep.promotedCount

    const confirmT0 = Date.now()
    const stagedRowIds = await runInTenantTransaction(
      familyId,
      user.id,
      async (tx) => {
        const staged = await tx.rawImportedTransaction.findMany({
          where: { familyId, importBatchId: batchId, rowStatus: "normalized" },
          select: { id: true, externalId: true },
        })
        return staged
          .filter(
            (r) =>
              r.externalId != null &&
              promotableBySureId.get(r.externalId) === true
          )
          .map((r) => r.id)
      }
    )
    timings.transactionsConfirm += Date.now() - confirmT0

    for (
      let start = 0;
      start < stagedRowIds.length;
      start += PROMOTE_CHUNK_SIZE
    ) {
      const slice = stagedRowIds.slice(start, start + PROMOTE_CHUNK_SIZE)

      const chunkConfirmT0 = Date.now()
      await reviewImportRowsForFamily({
        data: {
          batchId,
          idempotencyKey: createUuidV7(),
          decisions: slice.map((rowId) => ({
            rowId,
            verdict: "confirm" as const,
          })),
        },
        familyId,
        user,
        runInTenantTransaction,
      })
      timings.transactionsConfirm += Date.now() - chunkConfirmT0

      const chunkPromoteT0 = Date.now()
      const promotion = await promoteImportBatchForFamily({
        data: { batchId, idempotencyKey: createUuidV7() },
        familyId,
        user,
        runInTenantTransaction: bulkReplayTx,
      })
      timings.transactionsPromote += Date.now() - chunkPromoteT0
      promotedThisRun += promotion.promotedCount

      // PER-188 — emitted at the existing PER-179 chunk boundary, between
      // the confirm and promote transactions above, never inside either one.
      setImportProgress(importId, familyId, {
        phase: "staging",
        staged: rows.length,
        promoted: promotedThisRun,
      })
    }
  }

  const promotableCount = Array.from(promotableBySureId.values()).filter(
    Boolean
  ).length

  // --- 9. Pair & promote transfers as dual-leg Permoney transfers (ADR-0042) -
  // Reuses the SAME pure pairing computed up-front; promotes each pair through the
  // canonical `createTransactionForFamily` core (no new ledger writer), holding
  // anything ambiguous/orphan/gated with a DB-anchored typed reason.
  setImportProgress(importId, familyId, { phase: "pairing_transfers" })
  const transfersT0 = Date.now()
  const transfers = await pairAndPromoteSureTransfers({
    pairing: transferPairing,
    transferLegs,
    legsSeen: transferLegsSeen,
    batchId,
    familyId,
    user,
    accountMap,
    transferMeta,
    runInTenantTransaction: bulkReplayTx,
    auditCtx,
  })
  timings.transfers = Date.now() - transfersT0

  // --- 10. Final reconciliation anchor (ADR-0045's PER-182 amendment) -------
  // Closes any remaining balance gap from legs Permoney's own staging gates
  // held (non-importable counterpart, ambiguous cluster, currency mismatch,
  // orphan…) by asserting the "all legs" projection — the same value
  // pre-flight already verified is legal — as one final, dated-last anchor
  // per account. See writeSureFinalReconciliationAnchors for the full
  // reasoning. Runs under the bulk-replay bypass like step 4 (another
  // anchor-writing phase in the same transient-until-rebuild window).
  setImportProgress(importId, familyId, {
    phase: "reconciling",
    heldSoFar: Object.values(transfers.heldLegsByReason).reduce(
      (sum, n) => sum + n,
      0
    ),
  })
  const reconciliationT0 = Date.now()
  const finalReconciliation = await writeSureFinalReconciliationAnchors(
    bundle,
    accountMap,
    familyId,
    user,
    bulkReplayTx
  )
  timings.reconciliation = Date.now() - reconciliationT0

  // --- 11. Mandatory final rebuild — the correctness guarantee (ADR-0043) ---
  // During steps 4-10, `Account.balance` is transiently WRONG: step 4 sets it
  // to the latest anchor's value (via createValuationForFamily's own interim
  // recompute), then steps 8-9 apply per-transaction increments/decrements
  // that over-count any PRE-anchor flow (createTransactionForFamily doesn't
  // know about anchors — it just applies a delta), and step 10 writes a NEW
  // latest anchor for every account. Nothing reads the balance mid-run, so
  // this is safe ONLY because this rebuild recomputes the materialized cache
  // from canonical rows (latest anchor + Σ post-anchor flow, or the existing
  // no-anchor-found fallback for the rare account with no valuations at all)
  // — overriding the incremental journey with the calculator's actual answer.
  setImportProgress(importId, familyId, { phase: "finalizing" })
  const rebuildT0 = Date.now()
  await rebuildFamilyBalances({ familyId, user, runInTenantTransaction })
  timings.rebuild = Date.now() - rebuildT0

  // Success — the typed result below is the source of truth from here on;
  // the observational progress entry has served its purpose.
  importProgress.delete(importId)

  return {
    batchId,
    replayed,
    contentHash,
    byteSize: rawBytes.length,
    accounts: { created: accountsCreated, reused: accountsReused },
    categories: { created: categoriesCreated, reused: categoriesReused },
    merchants: { created: merchantsCreated, reused: merchantsReused },
    transactions: {
      total: bundle.transactions.length,
      // `staged` is all staged rows (standard + transfer legs); it decomposes as
      // `promotedThisRun` (standard) + `held` (standard) + `transfers.legsStaged`.
      staged: rows.length,
      promotedThisRun,
      // STANDARD held only — transfer legs are owned by the `transfers` block, so
      // every leg is counted in exactly one place (the spanning reconcile, Q7).
      held: rows.length - promotableCount - transferLegs.length,
      zeroAmountSkipped,
      invalidDateSkipped,
    },
    transfers,
    valuations: anchorSummary,
    finalReconciliation,
    valuationsParsed: bundle.valuations.length,
    malformedLines: bundle.malformedLines.length,
    ignoredEntities: bundle.ignoredEntities,
    timings,
  }
}

// ---------------------------------------------------------------------------
// Binding reuse helpers (find-by-partial-unique-binding; never recreate — §7)
// ---------------------------------------------------------------------------

async function reuseAccount(
  tx: TenantTransactionClient,
  familyId: string,
  sureAccountId: string
): Promise<PermoneyAccountInfo | null> {
  const existing = await tx.account.findFirst({
    where: {
      familyId,
      externalProvider: SURE_PROVIDER,
      externalAccountId: sureAccountId,
    },
    select: {
      id: true,
      currency: true,
      isImportable: true,
      balanceSource: true,
      accountType: true,
    },
  })
  return existing
    ? { ...existing, accountType: existing.accountType as AccountType }
    : null
}

async function reuseBoundId(
  tx: TenantTransactionClient,
  entity: "category" | "merchant",
  familyId: string,
  sureId: string
): Promise<string | null> {
  const where = {
    familyId,
    externalProvider: SURE_PROVIDER,
    externalId: sureId,
  }
  const existing =
    entity === "category"
      ? await tx.category.findFirst({ where, select: { id: true } })
      : await tx.merchant.findFirst({ where, select: { id: true } })
  return existing?.id ?? null
}

// Tag audit entries with the familyId explicitly (defense-in-depth; auditLogs
// otherwise falls back to ctx.session.user.familyId).
function withFamily(
  entries: AuditLogEntry[],
  familyId: string
): AuditLogEntry[] {
  return entries.map((entry) => ({ ...entry, familyId }))
}

// A migration with zero stageable rows still needs a batch to anchor the
// retained artifact. Reuses the existing batch on re-run (contentHash dedup).
async function ensureEmptyMigrationBatch(
  runInTenantTransaction: RunInTenantTransaction,
  familyId: string,
  user: { id: string; familyId?: string | null },
  contentHash: string,
  auditCtx: Awaited<ReturnType<typeof createAuditContext>>
): Promise<string> {
  return runInTenantTransaction(familyId, user.id, async (tx) => {
    const existing = await tx.importBatch.findUnique({
      where: {
        import_batch_content_dedup: {
          familyId,
          sourceKind: "migration",
          contentHash,
        },
      },
      select: { id: true },
    })
    if (existing) return existing.id
    const batch = await tx.importBatch.create({
      data: {
        familyId,
        createdById: user.id,
        sourceKind: "migration",
        provider: SURE_PROVIDER,
        contentHash,
        status: "ready_for_review",
        totalRows: 0,
      },
    })
    await auditLogs(
      tx,
      auditCtx,
      withFamily(createdAuditEntries("ImportBatch", [batch]), familyId)
    )
    return batch.id
  })
}

// ---------------------------------------------------------------------------
// Transfer pairing & promotion (ADR-0042 — dual-leg via the canonical core)
// ---------------------------------------------------------------------------

const EMPTY_HELD_BY_REASON = (): Record<SureTransferHeldReason, number> => ({
  not_staged: 0,
  non_importable: 0,
  currency_mismatch: 0,
  kind_divergence: 0,
  db_rejected: 0,
  unpaired_orphan: 0,
  ambiguous_cluster: 0,
})

const TIER_TO_RESULT_KEY: Record<
  SureTransferTier,
  keyof SureMigrationResult["transfers"]["pairedByTier"]
> = {
  deterministic: "deterministic",
  clean: "clean",
  resolved_cluster: "resolvedCluster",
}

interface StagedTransferRow {
  id: string
  externalId: string | null
  rowStatus: string
  promotionIdempotencyKey: string
}

/**
 * Pair & promote Sure transfer legs as dual-leg Permoney transfers (ADR-0042).
 *
 * Each promotable pair is created through the UNCHANGED canonical core
 * `createTransactionForFamily({type:"transfer"})` (no new ledger writer), keyed by
 * the OUTFLOW leg's persisted `promotionIdempotencyKey` (the stable idempotency
 * anchor minted once at PER-170 stage time). The core's own `replayIdempotentTransaction`
 * runs BEFORE any balance delta, so a re-run returns the existing legs, creates no
 * second leg and moves no balance (self-healing 2B — the leg-create runs in the
 * core's OWN tx, then both staged rows are marked promoted in a second tx by
 * recovering the leg ids via the stable key → outflow leg → `Transfer` →
 * inflow leg, which works identically on fresh create and replay).
 *
 * Held legs (structural or gated) keep `rowStatus="normalized"` and persist their
 * typed reason in `errorReason`; a runtime rejection from the core (e.g. a
 * liability balance-sign CHECK) is caught per-pair and held as `db_rejected` — one
 * poisoned pair never blocks the rest. All counts are read back from `rowStatus` at
 * the end (DB-anchored), so the reconcile invariant holds across idempotent re-runs.
 */
async function pairAndPromoteSureTransfers({
  pairing,
  transferLegs,
  legsSeen,
  batchId,
  familyId,
  user,
  accountMap,
  transferMeta,
  runInTenantTransaction,
  auditCtx,
}: {
  pairing: SureTransferPairingResult
  transferLegs: readonly SureTransaction[]
  legsSeen: number
  batchId: string
  familyId: string
  user: { id: string; familyId?: string | null }
  accountMap: ReadonlyMap<string, string>
  transferMeta: ReadonlyMap<string, SureTransferAccountMeta>
  runInTenantTransaction: RunInTenantTransaction
  auditCtx: Awaited<ReturnType<typeof createAuditContext>>
}): Promise<SureMigrationResult["transfers"]> {
  const pairedByTier = { deterministic: 0, clean: 0, resolvedCluster: 0 }
  const legsStaged = transferLegs.length

  if (legsStaged === 0 && pairing.pairs.length === 0) {
    return {
      legsSeen,
      legsStaged: 0,
      pairsPromotedThisRun: 0,
      legsPromotedTotal: 0,
      pairedByTier,
      heldLegsByReason: EMPTY_HELD_BY_REASON(),
    }
  }

  const allLegIds = transferLegs.map((leg) => leg.id)

  // Recover the staged held rows (stable key + status + rowId) by Sure id.
  const stagedRows: StagedTransferRow[] = await runInTenantTransaction(
    familyId,
    user.id,
    async (tx) =>
      tx.rawImportedTransaction.findMany({
        where: {
          familyId,
          importBatchId: batchId,
          externalId: { in: allLegIds },
        },
        select: {
          id: true,
          externalId: true,
          rowStatus: true,
          promotionIdempotencyKey: true,
        },
      })
  )
  const rowByExternalId = new Map(
    stagedRows.map((row) => [row.externalId, row])
  )

  let pairsPromotedThisRun = 0

  // --- Promote each promotable pair -----------------------------------------
  for (const pair of pairing.pairs) {
    const outRow = rowByExternalId.get(pair.outflow.id)
    const inRow = rowByExternalId.get(pair.inflow.id)
    // A pair promotes only when BOTH legs recovered a staged row + stable key.
    if (!outRow || !inRow) {
      if (outRow)
        await persistSureHeldReason(
          runInTenantTransaction,
          familyId,
          user,
          auditCtx,
          outRow,
          "not_staged"
        )
      if (inRow)
        await persistSureHeldReason(
          runInTenantTransaction,
          familyId,
          user,
          auditCtx,
          inRow,
          "not_staged"
        )
      continue
    }
    // Re-run: a promoted pair is authoritative & done — skip (Q3 linkage authority;
    // 2B marks both rows in one tx so they are never split across statuses).
    if (outRow.rowStatus === "promoted" || inRow.rowStatus === "promoted") {
      continue
    }

    const outMeta = transferMeta.get(pair.outflow.account_id)
    const outAccountId = accountMap.get(pair.outflow.account_id)
    const inAccountId = accountMap.get(pair.inflow.account_id)
    if (!outMeta || !outAccountId || !inAccountId) {
      await persistSureHeldReason(
        runInTenantTransaction,
        familyId,
        user,
        auditCtx,
        outRow,
        "not_staged"
      )
      await persistSureHeldReason(
        runInTenantTransaction,
        familyId,
        user,
        auditCtx,
        inRow,
        "not_staged"
      )
      continue
    }

    const minor = toMinorUnits(
      pair.outflow.amount,
      outMeta.currency as CurrencyCode
    ) as bigint
    const absMinor = minor < 0n ? -minor : minor
    const stableKey = outRow.promotionIdempotencyKey

    try {
      // Leg-create + Transfer + dual balance + audit — the canonical core's OWN
      // tx (2B keeps the canonical writer & its P2002 recovery pristine).
      await createTransactionForFamily({
        data: {
          type: "transfer",
          accountId: outAccountId,
          toAccountId: inAccountId,
          amount: absMinor.toString(),
          description: (pair.outflow.name ?? "").trim() || "Imported transfer",
          date: new Date(pair.outflow.date),
          idempotencyKey: stableKey,
          status: "CLEARED",
        },
        familyId,
        user,
        runInTenantTransaction,
      })

      // Second tx: recover both leg ids via the stable key (fresh OR replay) and
      // mark both staged rows promoted — minimal window, self-healing on re-run.
      await runInTenantTransaction(familyId, user.id, async (tx) => {
        const outflowLeg = await tx.transaction.findFirst({
          where: { familyId, idempotencyKey: stableKey },
          select: { id: true },
        })
        if (!outflowLeg) {
          throw new Error("Promoted transfer outflow leg not found")
        }
        const transfer = await tx.transfer.findFirst({
          where: { outflowTransactionId: outflowLeg.id },
          select: { inflowTransactionId: true },
        })
        if (!transfer) throw new Error("Transfer link row not found")
        if (!transfer.inflowTransactionId) {
          // Unreachable: this promotion path only ever creates classic
          // dual-leg Transfer rows (PER-196 / ADR-0048's valuation-linked
          // shape is written elsewhere, never by Sure-migration promotion).
          // Narrows the type below without a cast.
          throw new Error(
            `Transfer link row for outflow leg ${outflowLeg.id} is missing its inflow leg`
          )
        }

        const entries: AuditLogEntry[] = []
        await markSureTransferRowPromoted(tx, outRow.id, outflowLeg.id, entries)
        await markSureTransferRowPromoted(
          tx,
          inRow.id,
          transfer.inflowTransactionId,
          entries
        )
        await auditLogs(tx, auditCtx, withFamily(entries, familyId))
      })

      pairsPromotedThisRun += 1
      pairedByTier[TIER_TO_RESULT_KEY[pair.tier]] += 1
    } catch {
      // Runtime rejection (e.g. liability balance-sign CHECK overshoot) → HOLD the
      // pair as db_rejected, keep both rows normalized; the next re-run retries it.
      await persistSureHeldReason(
        runInTenantTransaction,
        familyId,
        user,
        auditCtx,
        outRow,
        "db_rejected"
      )
      await persistSureHeldReason(
        runInTenantTransaction,
        familyId,
        user,
        auditCtx,
        inRow,
        "db_rejected"
      )
    }
  }

  // --- Persist the pure pairer's held reasons (skip anything already promoted) -
  for (const heldLeg of pairing.held) {
    const row = rowByExternalId.get(heldLeg.txn.id)
    if (!row || row.rowStatus === "promoted") continue
    await persistSureHeldReason(
      runInTenantTransaction,
      familyId,
      user,
      auditCtx,
      row,
      heldLeg.reason
    )
  }

  // --- Count from rowStatus (DB-anchored → reconciles on re-run, Q7 #2) ------
  const finalRows = await runInTenantTransaction(
    familyId,
    user.id,
    async (tx) =>
      tx.rawImportedTransaction.findMany({
        where: {
          familyId,
          importBatchId: batchId,
          externalId: { in: allLegIds },
        },
        select: { rowStatus: true, errorReason: true },
      })
  )
  const heldLegsByReason = EMPTY_HELD_BY_REASON()
  let legsPromotedTotal = 0
  for (const row of finalRows) {
    if (row.rowStatus === "promoted") {
      legsPromotedTotal += 1
      continue
    }
    const reason = (row.errorReason ?? "") as SureTransferHeldReason
    if (reason in heldLegsByReason) heldLegsByReason[reason] += 1
    else heldLegsByReason.unpaired_orphan += 1
  }

  return {
    legsSeen,
    legsStaged,
    pairsPromotedThisRun,
    legsPromotedTotal,
    pairedByTier,
    heldLegsByReason,
  }
}

/** Mark a held transfer row promoted (links the created leg; clears any held reason). */
async function markSureTransferRowPromoted(
  tx: TenantTransactionClient,
  rowId: string,
  legId: string,
  entries: AuditLogEntry[]
): Promise<void> {
  await tx.rawImportedTransaction.update({
    where: { id: rowId },
    data: {
      rowStatus: "promoted",
      promotedTransactionId: legId,
      errorReason: null,
    },
  })
  entries.push({
    action: "update",
    entityType: "RawImportedTransaction",
    entityId: rowId,
    before: { rowStatus: "normalized", promotedTransactionId: null },
    after: { rowStatus: "promoted", promotedTransactionId: legId },
  })
}

/**
 * Persist a transfer leg's typed hold reason in `errorReason` on its still-held
 * (`normalized`) row — DB-anchored provenance, zero migration (`errorReason` is a
 * free TEXT column with no `rowStatus='error'` CHECK and is not surfaced by the
 * generic batch read). Never touches a promoted row.
 */
async function persistSureHeldReason(
  runInTenantTransaction: RunInTenantTransaction,
  familyId: string,
  user: { id: string; familyId?: string | null },
  auditCtx: Awaited<ReturnType<typeof createAuditContext>>,
  row: StagedTransferRow,
  reason: SureTransferHeldReason
): Promise<void> {
  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const current = await tx.rawImportedTransaction.findFirst({
      where: { id: row.id, familyId },
      select: { rowStatus: true, errorReason: true },
    })
    if (!current || current.rowStatus === "promoted") return
    if (current.errorReason === reason) return
    await tx.rawImportedTransaction.update({
      where: { id: row.id },
      data: { errorReason: reason },
    })
    await auditLogs(
      tx,
      auditCtx,
      withFamily(
        [
          {
            action: "update",
            entityType: "RawImportedTransaction",
            entityId: row.id,
            before: { errorReason: current.errorReason },
            after: { errorReason: reason },
          },
        ],
        familyId
      )
    )
  })
}

// ---------------------------------------------------------------------------
// Server-fn surface (capability-gated — ADR-0036 ledger:write, no new cap)
// ---------------------------------------------------------------------------

export const runSureMigrationFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: unknown) => sureMigrationInputSchema.parse(data))
  .handler(async ({ data, context }) =>
    runSureMigrationForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  )
