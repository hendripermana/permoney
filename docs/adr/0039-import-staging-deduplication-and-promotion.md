# ADR-0039 — Import staging, deduplication, and promotion contract

|                   |                                                       |
| ----------------- | ----------------------------------------------------- |
| **Status**        | Accepted                                              |
| **Date**          | 2026-06-22                                            |
| **Accepted**      | 2026-06-22                                            |
| **Deciders**      | Hendri Permana                                        |
| **Supersedes**    | —                                                     |
| **Superseded by** | —                                                     |
| **Amends**        | ADR-0008 §5 (import staging); clarifies ADR-0031 note |
| **Reserves for**  | PER-118 / ADR-0015 (provider integration contract)    |

## Context

ADR-0008 §5 declared the **principle** that raw import data is staging data, not
ledger data: future bank APIs, CSV uploads, and reconciliation feeds must land in
import-staging models first, and a staged row becomes canonical only when a
confirmed mutation writes `Transaction`/`SplitEntry`/`Transfer` through the same
ledger mutation contract used by manual entry. It did **not** lock the concrete
model shape, the state machine, the deduplication algorithm, the idempotency
keys, the provider→account mapping, retention, or the promotion boundary.

PER-82 (M2.5-11) is the slice that turns that principle into a durable contract.
It is the **foundation for every importer** — the PER-151 CSV wizard
(Mint/YNAB/QIF) and all future M8 bank/provider integrations build on top of it.
PER-82 ships the **generic staging contract only**: the staging models, the
pipeline, deduplication, idempotency, provider→account mapping, raw-payload
retention, and the server functions that run the pipeline and promote confirmed
rows into canonical `Transaction`s. It ships **no UI, no CSV parser, and no
column-mapping wizard** — those are PER-151.

### What already exists and must be reused, not reinvented

1. **Canonical create path** — `createTransactionForFamily` and the bulk path
   `bulkCreateTransactionsForFamily` (`src/server/transactions.ts`) already encode
   the ledger invariants: interactive `scopedTenantTransaction`, transaction-scoped
   RLS GUC, `validateTenantReferences`, signed amounts, the canonical
   base-currency FX projection (`getFamilyBaseCurrency` +
   `computeBaseProjectionForAmount`, ADR-0035 §4), atomic `applyAccountDeltas`
   (`{ increment }`/`{ decrement }`), per-row
   `Transaction (familyId, idempotencyKey)` uniqueness, and append-only
   `auditLogs`. Promotion **reuses these internals** (extracting a shared
   row-construction helper where one does not yet exist); it does not invent a
   second ledger writer or copy the bulk logic.
2. **Idempotency + audit** — ADR-0006: client UUIDv7 `Idempotency-Key`,
   `IdempotencyRecord` for endpoint-scoped replay, `Transaction.idempotencyKey`
   for create-level uniqueness, and append-only `AuditLog` inside the same
   transaction.
3. **Tenant isolation + membership** — ADR-0010 composite tenant FKs, ADR-0011
   app-level reference validation, and ADR-0036's RLS membership guard
   (`app_is_active_member(app.family_id, app.user_id)`) plus the
   `requireCapability` middleware and the `ledger:write` capability (which ADR-0036
   §2 explicitly scopes to "txn create/update/delete, bulk, **import**").
4. **Account taxonomy** — `docs/account-taxonomy.md`: `Account` already carries
   `externalProvider`, `externalAccountId`, `mask`, `institutionName`, and
   `isImportable`, so the durable "provider account = Permoney account" binding
   already has a home.
5. **Smart rules** — `SmartRule { keyword, categoryId, merchantId }` exists as
   CRUD only; **no apply/match engine exists yet**. PER-82 builds the matcher.

### The PER-118 collision (why the spine is source-agnostic)

Two tickets name `RawImportedTransaction`:

- **PER-82 (this slice)** — generic staging for CSV _and_ future providers.
- **PER-118 (M8, design-only)** — reserves
  `RawImportedTransaction { id, providerConnectionId, externalId, rawPayload,
normalizedAt?, confirmedTransactionId?, familyId }` keyed to a future
  `ProviderConnection`, under the reserved ADR-0015.

ADR-0031 already records the intent that "`RawImportedTransaction` is the future
escape route in PER-118." If PER-82 builds a CSV-only table and PER-118 redefines
it, we fork the table or take a painful migration. Therefore **the staging row's
source is polymorphic from day one**: PER-82 builds the table with the provider
columns **reserved-nullable**, and PER-118/ADR-0015 later only _adds_
`ProviderConnection` and _populates_ those columns — it never redefines the
table. This ADR amends ADR-0008 §5; ADR-0015 will reference it rather than
re-specify staging.

## Decision

**Imports flow through a source-agnostic staging spine. Raw payloads are stored
losslessly and retained; a deterministic pipeline normalizes, deduplicates, and
enriches candidates; and only explicitly `confirmed`, tenant-validated,
deduplicated rows are promoted into canonical `Transaction`s through the existing
ledger mutation internals — atomically, idempotently, and audited.**

### 1. Models: a source-agnostic staging spine (one wide raw row, per-row account)

Two new tenant-scoped models. `RawImportedTransaction` is **one wide row** that
carries the immutable raw payload plus nullable, pipeline-filled parsed,
enrichment, and dedup columns — not a raw/normalized/match table scatter (house
deep-module rule, CLAUDE.md §5.C), and consistent with the single-row shape
PER-118 already reserved.

**Account is resolved per row, not per batch.** A real-world export — including a
Sure export — is **one file spanning many bank accounts in one family**, so its
rows reference different Permoney accounts. The authoritative `accountId` lives on
`RawImportedTransaction` (and in `StagedRowInput`, §10); `ImportBatch.accountId`
is a **nullable optional default/hint** for the common single-account CSV, never
the source of truth. The per-row account is resolved from the source account
identifier via the §6 `Account.externalProvider`/`externalAccountId` binding (or
supplied directly by the caller). The `contentHash` batch-dedup stays
**per-file**, independent of how many accounts the file touches.

```prisma
model ImportBatch {
  id          String   @id @default(cuid())   // cuid PK — sibling convention (§5)
  familyId    String
  createdById String              // acting member (User.id)
  sourceKind  String              // 'csv_upload' | 'provider'  (DB CHECK)
  accountId   String?             // OPTIONAL default/hint only; per-row account is authoritative
  status      String   @default("pending") // see §3 (DB CHECK)
  contentHash String              // sha256 of raw file/payload bytes — batch dedup, per-file (§5)
  idempotencyKey String?          // client UUIDv7 for the create-batch endpoint (ADR-0006)
  // Coarse rollup counters, derived; not authoritative over row status.
  totalRows     Int   @default(0)
  duplicateRows Int   @default(0)
  errorRows     Int   @default(0)
  promotedRows  Int   @default(0)
  // Reserved for PER-118 / ADR-0015 (NULL in PER-82):
  providerConnectionId String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @default(now()) @updatedAt

  @@unique([familyId, sourceKind, contentHash], name: "import_batch_content_dedup")
  @@index([familyId, status])
  // composite tenant FK to Account per ADR-0010 (accountId, familyId)
}

model RawImportedTransaction {
  id            String @id @default(cuid())   // cuid PK — sibling convention (§5)
  familyId      String
  importBatchId String                 // always set (source-agnostic spine)
  accountId     String                 // AUTHORITATIVE per-row target account (composite tenant FK)

  // (1) Lossless raw — IMMUTABLE after insert (retention/traceability evidence).
  rawPayload    Json

  // (2) Normalized candidate — pipeline-filled, mutable working area.
  externalId    String?                // provider dedup key; NULL for CSV
  type          String?                // 'income' | 'expense'  (DB CHECK; §9 scope)
  amount        BigInt?                // SIGNED minor units once normalized (DB CHECK by type)
  currency      String?                // resolved at NORMALIZE = account currency (§4 — part of fingerprint)
  date          DateTime?
  description   String?

  // (3) Enrichment + dedup verdict — suggestion columns, never canonical writes.
  fingerprint            String?        // §4
  rowStatus              String  @default("pending") // §3 (DB CHECK)
  possibleDuplicate      Boolean @default(false)      // soft near-dup flag (§4)
  duplicateOfTransactionId String?                    // exact/externalId match target
  suggestedCategoryId    String?
  suggestedMerchantId    String?
  matchedSmartRuleId     String?
  errorReason            String?

  // Promotion linkage.
  promotionIdempotencyKey String        // UUIDv7 (becomes Transaction.idempotencyKey, ADR-0006);
                                         // minted at stage time, threaded into create (§5)
  promotedTransactionId   String?        // set when rowStatus='promoted' (§9)

  // Reserved for PER-118 / ADR-0015 (NULL in PER-82):
  providerConnectionId String?

  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt

  @@unique([familyId, promotionIdempotencyKey], name: "raw_import_promotion_key")
  @@index([importBatchId, rowStatus])
  @@index([familyId, fingerprint])
  // composite tenant FK to Account (accountId, familyId) and to ImportBatch (importBatchId, familyId)
}
```

`rawPayload` is written once and **never updated** — it is the provenance record.
All other columns are the mutable pipeline working area. `status`/`type`/sign are
`String` + DB `CHECK` (house convention, not Prisma enums).

### 2. Where normalized data lives

One wide row (§1). The raw payload is immutable-by-convention; parsed,
enrichment, and dedup data are nullable columns filled by pipeline steps. A
near-duplicate is **not** a separate match model — it is
`duplicateOfTransactionId` + `possibleDuplicate` + `rowStatus`.

### 3. Row state machine (durable; `promoted` is the sole irreversible terminal)

`rowStatus ∈ { pending, normalized, duplicate, error, confirmed, promoted,
rejected }` (DB CHECK). There is **no separate `enriched` status**: enrichment
writes suggestion columns and leaves status at `normalized`, because dedup and
enrichment are not a linear gate.

| status       | meaning                                           | reversible?                         |
| ------------ | ------------------------------------------------- | ----------------------------------- |
| `pending`    | raw inserted, not yet normalized                  | → normalized / error                |
| `normalized` | parsed candidate built; enrichment columns filled | yes                                 |
| `duplicate`  | exact-fingerprint or `externalId` match           | yes (explicit override → confirmed) |
| `error`      | parse/validation failure (`errorReason` set)      | yes (re-normalize)                  |
| `confirmed`  | explicitly approved; eligible for promotion       | yes (until promoted)                |
| `promoted`   | canonical `Transaction` written                   | **terminal / irreversible**         |
| `rejected`   | explicitly discarded; never promotes              | terminal (soft)                     |

`promoted` is the **only** hard-irreversible state. Reversal is "delete the
canonical `Transaction` through its own audited mutation," **never** a staging
edit — the canonical row is the system of record once it exists.

**Batch status** is a separate, coarse, derived rollup
(`pending → ready_for_review → partially_promoted → completed`, plus `failed`).
It is informational and never authoritative over row status.

### 4. Deduplication: deterministic fingerprint + soft near-dup

Two distinct jobs:

- **Content dedup (row).** A deterministic fingerprint:

  ```
  fingerprint = sha256( familyId | accountId | postedDate(FAMILY-tz calendar day)
                       | signedAmountMinor | currency | normalize(description) )
  ```

  where `normalize(description)` lowercases, collapses whitespace, and strips
  punctuation. The calendar day is computed in the **family timezone** via the
  shared `calendarDateInZone(date, familyTimezone)` helper
  (`src/lib/budget-progress.ts`, already used by R1/R2/cash-flow/budget) — **not**
  a UTC day. A transaction at 23:00 in a non-UTC zone can fall on a different
  _UTC_ day than the date-only CSV value, so a UTC bucket would miss dedups near
  midnight; the family-tz day matches how every other report buckets dates. When
  the source row carries a provider `externalId`, the
  fingerprint is `sha256( familyId | accountId | externalId )` and is
  **authoritative** — provider IDs beat heuristics.
  - **In-batch:** a second row with the same fingerprint in one batch →
    `rowStatus='duplicate'`.
  - **Vs. canonical ledger:** the same tuple is computed **on read** from
    existing `Transaction`s (windowed query on the existing
    `@@index([accountId, date])` by account + date window + amount, then hash
    confirm). **No `importFingerprint` column is added to `Transaction`** — the
    canonical table is not touched; the fingerprint is derived.
  - **Near-duplicate (fuzzy):** same date+amount+account but differing
    description → **not** auto-`duplicate`; set the soft `possibleDuplicate`
    flag while status stays `normalized`, for the PER-151 preview to resolve.
    Hard `duplicate` is reserved for exact-fingerprint or `externalId` match.

- **Batch dedup (don't re-stage)** is §5 (`contentHash`).

**Currency is resolved at the `normalize` step, not at promote.** Because
`currency` is part of the fingerprint, it must be fixed before dedup runs — it
cannot wait until promotion. The row's `currency` is defined as **the target
account's currency** (the account is the single source of truth for what money
this is, matching the canonical create path), resolved once the per-row
`accountId` is bound. **Foreign-currency transactions posted into a
domestic-currency account are out of scope for PER-82**: a staged row's currency
always equals its account's currency, and multi-currency import (a row whose
native currency differs from its account) is reserved for a follow-up alongside
the transfer/split import work (§9). Date is likewise bucketed at normalize via
the family-tz `calendarDateInZone` helper.

**ID strategy.** Both tables' primary `id` is `@default(cuid())`, matching every
sibling model in `prisma/schema.prisma` (`Transaction`, `Valuation`,
`FxRateSnapshot`, `Budget`, `AuditLog`, `IdempotencyRecord`). The **UUIDv7** form
is used only for `promotionIdempotencyKey`, because that value becomes
`Transaction.idempotencyKey`, which ADR-0006 mandates be a client-style UUIDv7.
So: cuid PK (sibling convention) + UUIDv7 idempotency key (ADR-0006) — no new ID
scheme is introduced.

### 5. Idempotency at batch and row level (the double-book defense)

Two retry surfaces, two keys:

- **Batch (don't double-_stage_).** `ImportBatch.contentHash` (sha256 of the raw
  bytes) is unique per `(familyId, sourceKind)`. Re-uploading the identical file
  — even in a new session with a fresh client UUID — returns the **existing
  batch** (replay), not a second staging run. The client `idempotencyKey` still
  guards the literal double-click/retry on the create-batch endpoint via the
  standard `IdempotencyRecord` kit. (A deliberate "force re-import of an identical
  file" is a distinct future intent and is **out of scope** here.)
- **Row (don't double-_book_).** Each `RawImportedTransaction` is assigned a
  **`promotionIdempotencyKey` (UUIDv7) at stage time**, persisted on the row.
  Promotion threads _that_ key into the canonical create, so the existing
  `Transaction (familyId, idempotencyKey)` unique constraint short-circuits any
  re-promotion — across separate requests or sessions — with no second
  `Transaction` and no second balance delta. Generating it at stage time (not at
  promote time) is what makes replay stable across sessions.

### 6. Provider→account mapping

- **Type normalization** is a **pure function**
  `normalizeProviderAccountType(providerKind, providerType, hints) →
{ accountClass, accountType, accountSubtype, balanceSource, capabilities }` in
  `src/lib/import-staging.ts`, with a conservative fallback
  (`DEPOSITORY`/`checking`). It is **reserved/stubbed** in PER-82 (no real
  providers yet); PER-118/M8 fills provider-specific behavior.
- **Reusable binding** reuses `Account.externalProvider` + `externalAccountId`
  (already in the taxonomy) as the lookup key within the tenant — **no new
  mapping table**, which would duplicate state already on `Account` and risk
  drift.
- **Account binds per row, not per batch** (§1): each `RawImportedTransaction`
  resolves its own authoritative `accountId`. For CSV the caller/wizard supplies
  it per row; for providers it is resolved from the source account identifier via
  the `externalProvider`/`externalAccountId` binding above. A single file may
  therefore fan rows out across many accounts (e.g. a Sure export). The staging
  row stores the **raw source account string in `rawPayload`** for traceability
  plus the **resolved per-row `accountId`**.
- **`isImportable` gate:** promotion requires `account.isImportable = true`
  (taxonomy contract), enforced server-side.

### 7. Raw-payload retention

- `rawPayload` is **retained indefinitely** within PER-82; promotion **never
  deletes** the staging row — it sets `promotedTransactionId` and freezes it. The
  staging row is the provenance record, parallel to `AuditLog`. `rejected` and
  `duplicate` rows are retained too: what was deliberately _not_ promoted is
  itself evidence.
- The retention horizon is documented as aligning with `AuditLog`'s **7 years**
  (ADR-0006), but PER-82 ships **no purge/retention job** — a future
  data-lifecycle ADR owns purge and must use a **non-app role** (raw payloads may
  contain sensitive bank data), exactly as ADR-0006 deferred audit deletion.
- **Tenant scoping:** both tables carry `familyId` and the ADR-0036 RLS
  membership guard (`app_is_active_member`); raw payloads are family-private and
  must never cross-read.

### 8. Smart-rule enrichment (enrich-only; never bypass the ledger)

- The matcher is a **pure function**
  `applySmartRules(rules, normalizedRow) → { suggestedCategoryId,
suggestedMerchantId, matchedSmartRuleId }` in `src/lib/import-staging.ts`.
  Match = normalized description **contains** a rule's lowercased `keyword`;
  **first match wins** by deterministic `createdAt` order.
- It writes **suggestion columns only** on the staging row during the normalize
  step. It **never** writes a canonical `Transaction` and **never** auto-advances
  status to `confirmed`.
- **Confirmation is an explicit mutation** (`reviewImportRowsFn`). PER-82 ships
  the human/explicit path; **rule auto-confirm is reserved-not-built** (e.g. a
  future `SmartRule.autoConfirm` flag), so "rules never cause a promotion by
  themselves" is an ironclad invariant for this slice.
- At **promotion**, suggested category/merchant become the real `categoryId`/
  `merchantId` and are **re-validated** through the canonical
  `validateTenantReferences` — a poisoned suggestion can never promote a
  cross-tenant reference.

### 9. Promotion (one atomic transaction, reusing bulk internals)

A dedicated deep function `promoteConfirmedImportRows` runs **one interactive
`scopedTenantTransaction`** over the selected rows:

1. selects **only `rowStatus='confirmed'`** rows in the batch — already-`promoted`
   rows are excluded by the filter, so re-running promotes nothing (natural
   no-op);
2. `validateTenantReferences` per row (account/category/merchant), reusing the
   exact same helper as single/bulk;
3. for each row, derives the signed `amount` by `type`, takes the **account's
   currency**, and **materializes the base-currency projection through the
   canonical FX path** — `getFamilyBaseCurrency` + `computeBaseProjectionForAmount`
   (ADR-0035 §4) — so every promoted `Transaction` gets `baseAmount`,
   `baseCurrency`, `fxRateScaled`, and `fxRateSnapshotId` set; builds rows carrying
   each row's stored `promotionIdempotencyKey`, then applies the aggregate atomic
   `applyAccountDeltas` (reusing `addAccountDelta`/`signedIncomeExpenseAmount`);
4. flips each staging row → `promoted` + `promotedTransactionId` in the **same
   transaction**;
5. `auditLogs` the account balance deltas, the created `Transaction`s, **and** the
   staging status flips — all atomic.

**Promotion shares the canonical create core; it does not copy it.** The amount
signing, tenant-reference validation, FX base projection, atomic balance delta,
per-row idempotency key, and audit emission are the **same shared helpers**
(`signedIncomeExpenseAmount`, `validateTenantReferences`, `getFamilyBaseCurrency` +
`computeBaseProjectionForAmount`, `applyAccountDeltas`, `accountBalanceAuditEntries`

- `createdAuditEntries` + `auditLogs`) used by `createTransactionForFamily` and
  `bulkCreateTransactionsForFamily`. Where the shared row-construction logic is not
  yet a standalone helper, it is **extracted** into one so single, bulk, and
  promotion call the same code — satisfying CLAUDE.md §5.A "Bulk Paths Must Match
  Single Paths." Promotion does **not** call `bulkCreateTransactionsForFamily`
  literally, because that function's `createMany` throws `P2002` on any
  already-promoted row and its endpoint-replay only catches whole-batch
  re-submits — partial/incremental promotion across calls would hard-error. It
  reuses the _internals_, not the endpoint wrapper.

**Idempotency = three layers:** the `confirmed`-only filter (logical), the per-row
`Transaction (familyId, idempotencyKey)` unique (durable backstop), and an
endpoint `IdempotencyRecord` on the promote-call key (transport retry).
Partial/incremental promotion across multiple calls is therefore safe and never
double-books.

**Scope:** like the existing bulk path, promotion handles **income/expense only**.
Transfers and splits in imports are **reserved/out-of-scope** for PER-82 (CSV
Mint/YNAB/QIF rows in PER-151 are flat single-account rows).

### 10. Authorization, server-fn surface, and the PER-82/PER-151 seam

- **Capability:** `ledger:write` already covers import (ADR-0036 §2) — **no new
  capability**. Staging, review, and promotion require `ledger:write` (viewer
  blocked); reads require active membership (`*:read`).
- **Input seam (keeps PER-151 out of PER-82):** `createImportBatchFn` accepts
  **already-field-extracted** rows — `StagedRowInput { accountId, externalId?,
rawPayload, date, amount, type, description, suggestedCategoryId?,
suggestedMerchantId? }[]` plus batch fields `{ sourceKind, accountId?,
contentHash, idempotencyKey }`. **`accountId` is per row** (the batch-level
  `accountId?` is only an optional default/hint, §1); each row may target a
  different account so one file spans many accounts. PER-82 **canonicalizes**
  (signs amount by type, buckets date in family-tz, derives currency from the
  row's account, normalizes description, computes fingerprint, runs dedup +
  `applySmartRules`). It does **not** interpret arbitrary columns — PER-151's
  wizard does CSV→`StagedRowInput` (including resolving each row's account).
- **Module layout (house deep-module pattern):**
  - `src/server/imports.ts` — deep module + server fns (plain `.ts`, like
    `transactions.ts`/`budgets.ts`; prisma arrives transitively via
    `db.server`/middleware).
  - `src/lib/import-staging.ts` — **pure** utils (fingerprint, normalize,
    `applySmartRules`, `normalizeProviderAccountType`), unit-tested.
  - **No TanStack DB collection** (like ADR-0036 members): PER-82 ships server
    fns only; UI is PER-151.
- **Server-fn surface (4 fns):**
  - `createImportBatchFn` (`ledger:write`) — stage + run pipeline; `contentHash`
    replay.
  - `reviewImportRowsFn` (`ledger:write`) — per-row verdict `confirm | reject` +
    optional category/merchant override.
  - `promoteImportBatchFn` (`ledger:write`) — promote `confirmed` rows atomically.
  - `getImportBatchFn` (read) — batch + rows for preview.

## Consequences

### Positive

- Every importer (PER-151 CSV, M8 providers) builds on one staging contract;
  adding a provider is implementing the seam, not redesigning staging.
- Re-importing the same file (content hash) cannot re-stage, and promoting the
  same confirmed rows twice cannot double-book (three-layer idempotency).
- Raw payloads are durable, tenant-private provenance; promotion is fully audited
  and reuses the one canonical ledger writer — no second source of truth.
- The PER-118 reserved columns mean M8 plugs in without a table fork or migration,
  reconciling the ADR-0031 note.

### Negative / costs

- Two new tables, new RLS policies, and new CHECK domains widen the migration and
  the real-Postgres test surface.
- Canonical-ledger dedup derives fingerprints on read (windowed query); for very
  large ledgers a materialized fingerprint may later be warranted — reserved, not
  built.
- Promotion is income/expense only; transfer/split imports and foreign-currency
  rows posted into a domestic-currency account (row currency ≠ account currency)
  need a follow-up ADR.

## Alternatives considered

1. **CSV-only table now, provider table later.** Rejected — forks
   `RawImportedTransaction` against PER-118's reserved shape; a source-agnostic
   spine with reserved provider columns avoids the fork.
2. **Co-design ADR-0015 (providers) now.** Rejected — M8 scope creep; PER-82 only
   needs the reserved columns, not the provider contract.
3. **Raw / normalized / match split into three models.** Rejected — table scatter
   against the house deep-module rule; one wide row with nullable pipeline columns
   is simpler and matches PER-118's single-row reservation.
4. **Store `importFingerprint` on every `Transaction`.** Rejected — touches the
   canonical table for a staging concern; derive-on-read keeps the ledger clean.
5. **Rely on the client UUID alone for batch dedup.** Rejected — a re-upload in a
   new session has a new UUID; `contentHash` catches the identical file.
6. **Generate the promotion key at promote time.** Rejected — not replay-stable
   across sessions; minting at stage time and persisting it is.
7. **Let smart rules auto-confirm / auto-promote.** Rejected for PER-82 — keeps
   "rules never cause a promotion by themselves" ironclad; auto-confirm is
   reserved behind a future flag.
8. **Per-row promotion (N transactions) or literal `bulkCreateTransactionsForFamily`.**
   Rejected — per-row loses aggregate atomicity; the literal bulk call hard-errors
   on partial/incremental promotion. A dedicated function reusing bulk internals
   gives atomicity + clean incremental idempotency.

## Testing (real Postgres — mandatory)

Per AGENTS.md and ADR-0006/0036 (PER-86 harness, `docs/testing.md`):

- **Idempotent re-import:** staging the same `contentHash` twice returns the same
  batch and does not re-stage; promoting the same batch twice does not create a
  second `Transaction` or a second balance delta.
- **Promotion parity:** a promoted row equals the single-create path — signed
  amount, atomic balance delta, `Transaction.idempotencyKey`, `AuditLog` rows,
  RLS GUC scope, tenant-validated references. **The test MUST assert
  `baseAmount`, `baseCurrency`, and `fxRateScaled` are set** on every promoted
  `Transaction` (via the canonical ADR-0035 FX projection). Lesson from PER-159: a
  null `baseAmount` makes the row render as "FX-pending" in R2 / dashboard, so
  promotion that skips the base projection would silently corrupt reporting even
  though balances look correct.
- **Dedup:** in-batch duplicates flagged; a row matching an existing canonical
  `Transaction` flagged `duplicate`; near-dup sets `possibleDuplicate` only.
- **Provider mapping:** `normalizeProviderAccountType` fallback; promotion
  rejects a non-`isImportable` target account.
- **Tenant isolation:** member of family A cannot read/write family B's batches or
  raw rows (mis-set GUC, cross-family `accountId`); RLS membership guard returns
  zero rows when `app.user_id` is not an active member.
- **Smart-rule enrichment:** a matched rule sets suggestion columns only, never
  auto-confirms, and never writes a `Transaction`; a poisoned cross-tenant
  suggestion is rejected at promotion by `validateTenantReferences`.
- **Capability:** `viewer` cannot stage/review/promote; reads require membership.
- **State machine:** `promoted` is terminal; promotion selects only `confirmed`
  rows; re-promotion is a no-op.

Pure units (`src/lib/import-staging.ts`): fingerprint determinism + `externalId`
override, description normalization, `applySmartRules` first-match ordering,
`normalizeProviderAccountType` fallback.

## References

- PER-82 (M2.5-11 — Import staging, deduplication, and provider account mapping)
- PER-151 (P4 — CSV import wizard; consumes this contract)
- PER-118 / ADR-0015 (Provider integration contract; reserves provider columns)
- ADR-0008 §5 (Core domain model — import staging boundary; amended here)
- ADR-0006 (Idempotency keys and audit-log architecture)
- ADR-0010 (Tenant composite foreign-key invariants)
- ADR-0011 (App-level tenant reference validation)
- ADR-0031 (Transfer graph invariants — `RawImportedTransaction` escape-route note)
- ADR-0033 (Bulk mutation parity)
- ADR-0035 (Currency/FX snapshots — base projection at write time)
- ADR-0036 (Family membership and role authorization — RLS guard, `ledger:write`)
- `docs/account-taxonomy.md` (provider/account binding, `isImportable`)
- `AGENTS.md` §5.A (Raw Bank Data Is Not Canonical Ledger Data)
