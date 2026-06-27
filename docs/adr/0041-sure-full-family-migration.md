# ADR-0041 — Sure full-family migration (accounts + categories + merchants + transactions)

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                         |
| **Date**          | 2026-06-27                                                                       |
| **Accepted**      | 2026-06-27                                                                       |
| **Deciders**      | Hendri Permana                                                                   |
| **Supersedes**    | —                                                                                |
| **Superseded by** | —                                                                                |
| **Builds on**     | ADR-0039 (import staging spine, PER-82), ADR-0008 §5, `docs/account-taxonomy.md` |
| **Amends**        | ADR-0039 §1/§10 (adds `migration` source kind + bundle artifact retention)       |
| **Reserves for**  | Phase 2 transfers/trades (PER-150/PER-146), Phase 3 rules (smart-rule engine)    |

## Context

PER-163 lets a user **leave Sure (`we-promise/sure`) and bring their whole
family's data into Permoney faithfully** — not just transactions. Sure exports
**one family (one tenant)** as a ZIP bundle of per-entity CSVs plus a single
`all.ndjson` relational dump. This ADR locks the **Phase 1** migration contract:
**accounts + categories + merchants + transactions**. Transfers, trades/holdings,
valuations, recurring transactions, and rules are deferred (§10).

This is **not a new ledger writer**. Transactions flow through the PER-82 staging
spine (ADR-0039): `StagedRowInput → stage → dedup → confirm → promote`, reusing
the one canonical create core. The migration adds only an **orchestration layer**
on top: a Sure-aware reader, an id-remap, and durable provider bindings.

### Canonical source: `all.ndjson`, verified against the open-source serializer

The migration consumes **`all.ndjson`** as the canonical source, not the flat
per-entity CSVs: the NDJSON preserves ids, types, and relations (the CSVs are
denormalized — e.g. `transactions.csv` references accounts/categories **by name**,
which collides and loses hierarchy). The CSVs are used only as a cross-check.

The exact entity schema was derived from **two sources and reconciled**:

1. **Authoritative — the Sure serializer.** `app/models/family/data_exporter.rb`
   (`Family::DataExporter`, `EXPORT_VERSION = 2`) defines the full ordered entity
   set written to `all.ndjson`:

   `Account` → `Balance` → `Category` → `Tag` → `Merchant` →
   `RecurringTransaction` → `Transaction` (with optional embedded `split_lines`) →
   `Transfer` → `RejectedTransfer` → `Trade` → `Holding` → `Valuation` →
   `Budget` → `BudgetCategory` → `Rule`.

   The **reader targets export v2** as the contract.

2. **Validation — the user's real bundle** (`fixture/sure-sample/all.ndjson`,
   3002 transactions / 41 accounts / 64 categories / 92 merchants). It is a
   **degraded / pre-v2 sample**: it contains only `Account`, `Balance`-absent,
   `Category`, `Tag`, `Merchant`, `Transaction`, `Valuation`, `Budget`,
   `BudgetCategory` — and is **missing `Balance`, `Transfer`, `RecurringTransaction`,
   `Trade`, `Holding`, `Rule`**. The reader must therefore treat every v2-only
   entity as **optional** and degrade gracefully (§5 fallback, §6 deferral).

### Two facts the reader must encode (verified from source + bundle)

- **Sign convention is inverted.** Sure stores `entry.amount` with
  **outflow/expense positive, inflow/income negative** (confirmed in
  `goal_pledge.rb`: _"Sure convention: inflow < 0"_, and in the bundle: the
  food-expense row "lumpia beef" is `amount: "17000.0"`, positive). Permoney's
  `Transaction.amount` is **signed the opposite way** (negative = outflow). The
  PER-82 seam takes an **absolute** amount + a `type`, so the conversion is a pure
  classification, not a sign hack (§4.C).
- **Transfer pairing exists in v2 but not in the bundle.** Sure pairs the two legs
  of a transfer **deterministically** via a `Transfer { inflow_transaction_id,
outflow_transaction_id, status }` entity (verified in `sure_import/preflight.rb`
  required keys and `data_exporter.rb`). The user's bundle has **zero `Transfer`
  rows**, so its 928 transfer-kind transactions (902 `funds_movement` + 12
  `cc_payment` + 14 `loan_payment`) are **unpaired**. Phase 1 defers transfers
  regardless (§6); when the `Transfer` entity is present, the future transfer phase
  pairs **deterministically** (no heuristics); when absent, a separate heuristic
  ADR is required.

## Decision

**A Sure-aware orchestration layer reads `all.ndjson`, creates accounts /
categories / merchants under durable `externalProvider="sure"` bindings, builds
Sure-id → Permoney-id maps, and feeds transactions through the unchanged PER-82
staging pipeline per row. Re-running the whole migration is idempotent at every
layer. The raw bundle is retained losslessly as tenant-private provenance and is
the durable source for the deferred Phase 2/3 entities.**

### 1. Ordering & the orchestration pipeline (one deep module)

Reader + schema derivation + orchestration live in **one deep module**
`src/server/sure-migration.ts` (plain `.ts`, like `imports.ts`/`transactions.ts`
per ADR-0039 §10 — Prisma arrives transitively via `db.server`/middleware; **not**
a `.server.ts` suffix). Pure, unit-tested helpers (NDJSON line parse, Sure entity
Zod schemas, `normalizeSureAccountType`, sign/`type` classification,
description-derived fields) live in `src/lib/sure-migration.ts`, parallel to
`src/lib/import-staging.ts`. **No file scatter** (CLAUDE.md §5.C).

Strict dependency order, each step resolving the prior step's id-map:

```
1. parse + validate all.ndjson  (reject malformed lines; collect counts)
2. Accounts    -> create/upsert -> sureAccountId   -> permoneyAccountId  map
3. Categories  -> create/upsert -> sureCategoryId  -> permoneyCategoryId map  (two-pass: parents then children)
4. Merchants   -> create/upsert -> sureMerchantId  -> permoneyMerchantId map
5. Transactions-> map per-row accountId/categoryId/merchantId via maps above
                 -> StagedRowInput[] -> PER-82 stage -> dedup -> confirm -> promote
```

Accounts/categories/merchants are created **before** transactions so every
per-row reference resolves (no dangling refs). The transaction step is **pure
reuse** of PER-82; the migration never re-implements ledger writes.

### 2. Account mapping (Sure `accountable_type` → Permoney taxonomy)

Per-row binding: `externalProvider="sure"`, `externalAccountId = <Sure account.id>`
(**not** Sure's own upstream `external_id`/`provider`, which are Plaid/SimpleFIN
and are retained in the bundle only). `normalizeSureAccountType(accountable_type,
subtype)` is the Sure specialization of the PER-82 `normalizeProviderAccountType`
stub (ADR-0039 §6), with a conservative `DEPOSITORY`/`checking` fallback.

| Sure `accountable_type` | Sure `classification` | `accountClass` | `accountType`   | `accountSubtype` (from Sure `subtype`)                                             | `balanceSource`    | `isImportable` (Phase 1) |
| ----------------------- | --------------------- | -------------- | --------------- | ---------------------------------------------------------------------------------- | ------------------ | ------------------------ |
| `Depository`            | asset                 | `ASSET`        | `DEPOSITORY`    | `savings`→savings, `checking`→checking, `cooperative`→cooperative, `null`→checking | `transaction_flow` | **true**                 |
| `CreditCard`            | liability             | `LIABILITY`    | `CREDIT`        | `credit_card`                                                                      | `transaction_flow` | **true**                 |
| `Loan`                  | liability             | `LIABILITY`    | `LOAN`          | `personal_loan` (refine by name later)                                             | `transaction_flow` | **true**                 |
| `Investment`            | asset                 | `ASSET`        | `INVESTMENT`    | `mutual_fund`/`cooperative_share`→same, `null`→brokerage                           | `transaction_flow` | **false** (see note)     |
| `PreciousMetal`         | asset                 | `ASSET`        | `TRACKED_ASSET` | `gold`                                                                             | `valuation`        | **false**                |
| `OtherAsset`            | asset                 | `ASSET`        | `TRACKED_ASSET` | `generic_asset`                                                                    | `valuation`        | **false**                |

`classification` maps directly to `accountClass` (asset→ASSET, liability→LIABILITY).
`balanceSource` is a **pure function of `accountType`** (taxonomy contract) — it is
**never** copied from Sure.

**Taxonomy note on `INVESTMENT`.** Per `docs/account-taxonomy.md`, `INVESTMENT` is
`transaction_flow`, **not** valuation. Phase 1 nonetheless marks Investment
accounts `isImportable=false` and **holds** their rows, because their
economically-meaningful postings are **Trades/Holdings** (deferred to PER-150) —
promoting only the stray cash rows would render a misleading partial balance. This
is a deliberate phasing choice, **not** a taxonomy reclassification. `TRACKED_ASSET`
accounts (`PreciousMetal`, `OtherAsset`) are valuation-driven and owned by PER-146.

**All account shells are created in Phase 1** (correct taxonomy, `externalProvider`
binding) so transactions referencing any account resolve. Only `transaction_flow`
**and** `isImportable=true` accounts have their transactions promoted; rows
targeting held accounts are staged and **not promoted** (§6). Non-cash shell
balances are **neutral (0)**; Sure's reported `balance`/`cash_balance` are retained
as provenance **only** — never written as a fake reconciled number (§5).

### 3. Category & merchant mapping

Both reuse the **same machinery** as the account binding, so the marginal cost of
merchants over categories is ~zero (this is why Phase 1 includes merchants — a
justified expansion of the ticket's stated scope; deferring them would force an
extra audited `merchantId` relink on already-promoted transactions).

| Sure `Category` field | Permoney `Category` field                               |
| --------------------- | ------------------------------------------------------- |
| `id`                  | `externalId` (binding; **+ `externalProvider="sure"`**) |
| `name`                | `name`                                                  |
| `classification`      | `type` (`expense`/`income`)                             |
| `color`               | `color`                                                 |
| `lucide_icon`         | `icon`                                                  |
| `parent_id`           | `parentId` (remapped via the **same** category id-map)  |
| `key`                 | (ignored Phase 1 — see system-category note)            |
| `family_id`           | (ignored — replaced by `context.familyId`)              |

| Sure `Merchant` field | Permoney `Merchant` field                               |
| --------------------- | ------------------------------------------------------- |
| `id`                  | `externalId` (binding; **+ `externalProvider="sure"`**) |
| `name`                | `name`                                                  |
| `color`               | `color`                                                 |
| `logo_url`            | `logoUrl`                                               |

- **Categories map to TENANT categories**, always created under `context.familyId`.
  Sure categories are **never** merged into Permoney's `isSystem` global categories
  (ADR-0009): global categories must not be stamped with an `externalId` or
  mutated. Mapping Sure's `key` onto the system taxonomy is **deferred** and
  documented as a future fidelity improvement.
- **Parent hierarchy** is reconstructed via the same id-map in **two passes**
  (parents first, then children) so a child's `parentId` always resolves.

### 4. Transaction mapping (through the PER-82 seam, unchanged)

| Sure `Transaction` field       | Handling                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `id`                           | retained in `rawPayload` (provenance); not a Permoney PK                                  |
| `account_id`                   | → per-row `StagedRowInput.accountId` via account id-map (**ADR-0039 §1 per-row account**) |
| `category_id`                  | → `suggestedCategoryId` via category id-map; re-validated at promote                      |
| `merchant_id`                  | → `suggestedMerchantId` via merchant id-map; re-validated at promote                      |
| `date`                         | → `StagedRowInput.date`; bucketed family-tz at normalize (`calendarDateInZone`, §4.B)     |
| `amount` + `currency`          | → `type` + **abs** minor units (§4.C)                                                     |
| `name`                         | → `StagedRowInput.description`                                                            |
| `kind`                         | gates promotion: `standard`→promote; transfer kinds→**held** (§6)                         |
| `notes`, `excluded`, `tag_ids` | retained in `rawPayload`; no Permoney `excluded` field in Phase 1 (deferred fidelity)     |
| `split_lines` (v2)             | **out of scope** Phase 1 (PER-82 is income/expense only); held + retained                 |

**A. Currency.** Per ADR-0039 §4, the staged row's currency is **the target
account's currency**. A Sure transaction whose `currency` differs from its account
is foreign-currency-into-domestic — **out of scope** for PER-82 and held (§6). In
practice Sure posts each entry in its account's currency.

**B. Date / timezone.** The fingerprint and dedup bucket use the **family
timezone** via `calendarDateInZone` (ADR-0039 §4) — Sure `date` is already a
calendar date, so this is consistent.

**C. Sign → `type` + abs amount (the inversion).** For `kind="standard"`:

```
sureMinor = toMinorUnits(sure.amount, account.currency)   // src/lib/money.ts
type      = sureMinor >= 0 ? "expense" : "income"          // Sure: outflow>0, inflow<0
absAmount = abs(sureMinor)
```

PER-82 then **re-signs** at promote (`expense`→negative, `income`→positive), so
Sure `+17000` (expense) becomes Permoney `-17000`, and Sure `-5000` (income)
becomes `+5000`. The migration **never** writes a signed amount itself — it only
classifies. `sureMinor == 0` is treated as `expense` and flagged for review.

**D. FX / base projection.** Promotion materializes `baseAmount`/`baseCurrency`/
`fxRateScaled`/`fxRateSnapshotId` through the canonical ADR-0035 path
(`getFamilyBaseCurrency` + `computeBaseProjectionForAmount`) exactly as PER-82 §9
— no migration-specific FX. The integration test **asserts `baseAmount` is set**
(PER-159 lesson).

### 5. Opening balance for cash-like accounts (transfer-independent, additive)

PER-82 promotion applies signed deltas onto the account's **current** balance, so
the opening balance matters. **Primary strategy:** when the v2 `Balance` entity is
present, set a cash-like account's opening balance from the **earliest `Balance`
snapshot's `start_balance`** (converted to minor units) at account creation; this
is the **true, transfer-independent** opening, so when the deferred transfer phase
later posts legs, balances converge **additively** with no recomputation.

> For `transaction_flow` accounts the opening is simply the **initial materialized
> `Account.balance`** (taxonomy / PER-143 — "captures the opening balance as the
> initial materialized balance"). It does **not** require the PER-146 valuation
> primitive; PER-146 governs only the deferred `TRACKED_ASSET` accounts.

**Mandatory fallback** (the user's bundle has **no `Balance` rows**): if no
snapshot exists for an account, set opening `= 0`, **never plug**, and document the
reconciliation gap. Sure's reported `account.balance` + any snapshots are retained
as provenance only.

**Forbidden:** opening `= Sure.balance − Σ(promoted standard txns)`. Because
transfers are deferred, this plug silently absorbs transfer effects into the
opening and **double-counts** when transfers later post.

**By-design statement (ADR-explicit):** a cash-like account's final balance will
**not** equal Sure's reported balance until **(a)** the correct opening is set
**and (b)** the transfer phase completes. This gap is **additive and intentional**,
never patched with a plug.

### 6. Promotion gating & what is "held"

Phase 1 promotes a transaction row only when **all** hold:

1. `kind == "standard"` (transfer kinds held — §10, deferred),
2. target account `isImportable == true` **and** `balanceSource == transaction_flow`
   (Investment/TrackedAsset accounts held — §2),
3. row currency == account currency (foreign-into-domestic held — §4.A),
4. not a split parent (`split_lines` held — §4).

"Held" rows are **staged and retained** (`rowStatus` stays `normalized`/`skipped`,
never `promoted`) as provenance, exactly per ADR-0039 §3/§7 — what was deliberately
not promoted is itself evidence and the input for Phase 2/3.

### 7. One-shot idempotency (re-run never double-creates)

Three independent, **non-overlapping** layers — the migration must keep them
distinct (do not mix):

| Entity                   | Dedup key (idempotency)                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| **Account**              | upsert guard on `(familyId, externalProvider="sure", externalAccountId=sureId)`         |
| **Category / Merchant**  | upsert guard on `(familyId, externalProvider="sure", externalId=sureId)`                |
| **The bundle / batch**   | `ImportBatch.contentHash = sha256(all.ndjson bytes)` — re-upload returns the same batch |
| **Each transaction row** | PER-82 `promotionIdempotencyKey` (UUIDv7) → `Transaction (familyId, idempotencyKey)`    |

On re-run: an account/category/merchant whose `(familyId, "sure", sureId)` already
exists is **reused** (its Permoney id re-enters the id-map) — never recreated.
Transactions short-circuit on the PER-82 per-row key and the `confirmed`-only
promotion filter. Net: **no duplicate accounts/categories/merchants/transactions,
no double balances**, even across sessions.

**Transaction-row reuse on re-run (stable per-Sure-transaction key).** Re-running
the migration on a bundle with the same `contentHash` **must reuse the already
staged `RawImportedTransaction` rows** (ADR-0039 §5 batch replay returns the
existing `ImportBatch`, not a second staging run). It **must not** re-stage new
rows or mint a new `promotionIdempotencyKey`: the key is generated **once at stage
time and persisted on the row**, so a given Sure transaction maps to the **same**
`promotionIdempotencyKey` across every run. That stability is precisely what makes
re-promotion a no-op at the `Transaction (familyId, idempotencyKey)` backstop — a
fresh key per run would defeat it. The Sure transaction `id` is retained in
`rawPayload` for traceability, but the durable idempotency anchor is the persisted
key, not a re-derived natural key. The "idempotent re-run" integration test asserts
this directly (no second `Transaction`, no second balance delta).

#### Schema deltas (additive, nullable, backward-compatible)

```prisma
// Category: add provider binding (mirrors Account)
model Category {
  // … existing …
  externalProvider String?
  externalId       String?
  @@unique([familyId, externalProvider, externalId], name: "category_provider_binding") // PARTIAL: WHERE externalProvider IS NOT NULL
}

// Merchant: add provider binding (mirrors Account)
model Merchant {
  // … existing …
  externalProvider String?
  externalId       String?
  @@unique([familyId, externalProvider, externalId], name: "merchant_provider_binding")  // PARTIAL: WHERE externalProvider IS NOT NULL
}

// Account: harden the existing (familyId, externalProvider, externalAccountId)
//          INDEX into a PARTIAL UNIQUE.
@@unique([familyId, externalProvider, externalAccountId], name: "account_provider_binding") // PARTIAL: WHERE externalProvider IS NOT NULL
```

**Why partial (corrected rationale).** A plain composite `@@unique` would **not**
collide the manual rows: Postgres treats `NULL`s as **distinct by default**
(`NULLS DISTINCT`), so every `externalProvider = NULL` row is already unique under
the constraint. The reason to make the index **partial** (`WHERE externalProvider
IS NOT NULL`) is therefore (a) a **smaller index** — it covers only provider-bound
rows, not the manual majority — and (b) **explicit intent**: the binding uniqueness
applies only to imported rows. `familyId` is included for tenant isolation
(ADR-0010). New columns are nullable → existing rows are unaffected.

**Implementation gotcha (do not skip).** Prisma's `@@unique` does **not** emit a
partial index — it always generates a full `CREATE UNIQUE INDEX`. The
`WHERE externalProvider IS NOT NULL` predicate **must be hand-written in raw SQL**
inside the migration (drop the Prisma-generated full index, create the partial one),
following the established precedent in the `family_membership` and
`idempotent_update_delete` migrations.

**Category composite tenant FK (ADR-0010).** Unlike `Merchant`, `Category` does
**not** yet carry `@@unique([id, familyId])`. The migration must not assume that
composite key exists; if a composite tenant FK to `Category` is later required
(ADR-0010), it is a separate, explicit schema change — adding the provider binding
here neither provides nor presumes it. (Categories also legitimately allow
`familyId = NULL` system rows, which are out of this binding's scope by §3.)

### 8. Raw-bundle provenance & retention

- **Batch:** one `ImportBatch` per bundle. Extend the `sourceKind` CHECK with a
  **provider-agnostic** value: `sourceKind = "migration"` **+ a `provider` column
  = "sure"** (ready for future full-family migrations), rather than a hardcoded
  `"sure_migration"`. `ImportBatch.contentHash = sha256(all.ndjson)` provides the
  one-shot batch replay (§7).
- **Lossless bundle:** stored once in a **new tenant-scoped artifact table**
  `ImportBatchArtifact { id, importBatchId, familyId, filename, contentHash, … }`,
  RLS-guarded with a composite tenant FK `(importBatchId, familyId)` and
  transaction-scoped GUC. **Do not** add a raw blob to `Account`/`Category`/
  `Merchant`. **Storage form and encryption are not left open** — the implementing
  slice **must** pick and record one of: (i) object-store reference (preferred when
  an object store is wired) — the artifact row stores a key/URL + `contentHash` +
  `byteSize`, bytes never touch Postgres; or (ii) Postgres `bytea` (fallback) for a
  self-contained deployment, accepting the multi-MB row. Either way the slice
  **must** state the **encryption-at-rest** decision explicitly (object-store SSE,
  or DB/disk-level encryption for `bytea`), consistent with the PII posture in §9/§11.
  This decision is made in the implementation PR, not deferred indefinitely.
- **The bundle is the durable source for deferred entities.** Phase 2/3 read
  `Balance`, `Transfer`, `Trade`, `Holding`, `Valuation`, `RecurringTransaction`,
  and `Rule` from the **same retained artifact** — no re-upload.
- **Transactions** additionally retain per-row raw via PER-82
  `RawImportedTransaction.rawPayload` (do not duplicate that responsibility in the
  artifact).
- **Retention** aligns with PER-82 / ADR-0006 (7 years; purge by a **non-app
  role**, since raw payloads are sensitive financial data). No purge job ships here.

### 9. Tenant isolation & RLS

Every created/read row is validated to belong to `context.familyId`; id-map
lookups are **tenant-scoped**; `validateTenantReferences` runs per transaction row
at promote (reused from PER-82). All writes occur inside one or more interactive
`scopedTenantTransaction` blocks with **transaction-scoped** `app.family_id` GUC
(`set_config(..., true)`). The new `ImportBatchArtifact` carries `familyId` and the
ADR-0036 RLS membership guard; raw bundles are family-private and never cross-read.
The capability is `ledger:write` (ADR-0036 §2 already scopes import) — **no new
capability**. Given the bundle holds real financial data, encryption-at-rest for
the artifact is recommended, consistent with the fixture-privacy decision (§11).

### 10. Phasing (what is deferred, and why it is safe)

| Phase   | Scope                                                | Blocked by              |
| ------- | ---------------------------------------------------- | ----------------------- |
| **1**   | accounts + categories + **merchants** + transactions | PER-82 (done)           |
| **1.5** | transfers (pair legs → `Transfer` mutation)          | transfer-import design  |
| **2**   | trades / holdings / valuations                       | PER-150, PER-146        |
| **3**   | rules → `SmartRule`                                  | smart-rule apply engine |

Deferral is safe because every deferred input is **retained** (§8) and every
held row is **staged not dropped** (§6). **Phase 1.5 (transfers)** pairs legs
**deterministically** from `Transfer.{inflow,outflow}_transaction_id` when the
entity is present (the common v2 case); a bundle **without** `Transfer` rows (like
the validation fixture) needs a **separate heuristic-pairing ADR** — Phase 1.5
must not silently heuristically pair, since `funds_movement` legs across accounts
can collide on amount+date.

### 11. UI shape & fixtures

- **Guided importer, not the generic PER-151 wizard.** Upload bundle → preview
  (accounts, categories, merchants, transaction count, dedup/held summary) →
  confirm → orchestrated promote inside the staging contract. It **may reuse**
  PER-151 parsing/preview UX components, but the flow is multi-entity orchestration,
  not column-mapping.
- **Fixtures are synthetic, built by a deterministic seeded builder** derived from
  the Sure v2 serializer schema (schema-faithful to the reader contract). **No real
  bundle is ever committed.** Two committed scenarios:
  - **v2 complete:** Account + `Balance` (snapshot-opening) + Category(with parent)
    - Merchant + Transaction + `Transfer` (`inflow/outflow_transaction_id`,
      deterministic pairing) + Sure sign inversion (`inflow < 0`) — exercises the
      primary paths.
  - **v1 degraded:** no `Balance`/`Transfer` — exercises the fallback (opening = 0,
    transfers deferred, documented gap).
- The real bundle stays **local + gitignored** (`fixture/`, `*.ndjson`), used only
  for the actual one-shot migration and manual local smoke — never CI. When real
  data reveals a quirk (encoding/locale/odd nominal), **iterate the builder**;
  never commit real data.

## Acceptance criteria (Phase 1)

- [ ] Migration ADR accepted (this document).
- [ ] Sure accounts → Permoney `Account` with `externalProvider="sure"` /
      `externalAccountId`; **re-run does not duplicate** (partial-unique guard).
- [ ] Sure categories → `Category` (tenant-owned, parent hierarchy) and Sure
      merchants → `Merchant`; Sure→Permoney id-maps built; **re-run does not
      duplicate**.
- [ ] Sure transactions through the PER-82 pipeline (per-row `accountId`,
      account/category/merchant resolved), promoted with full ledger parity (signed
      amount, atomic balance, **`baseAmount`/FX set**, audit, RLS, idempotency).
- [ ] Re-running the whole migration is idempotent (no double
      accounts/categories/merchants/transactions, no double balances).
- [ ] Tenant isolation throughout; raw bundle retained as provenance
      (`ImportBatchArtifact`, RLS).
- [ ] Real-Postgres integration test against the **synthetic** Sure bundle.
- [ ] `vp run check && vp test run && vp build` clean.

## Testing (real Postgres — mandatory)

Per AGENTS.md / ADR-0006 / ADR-0036 (PER-86 harness, `docs/testing.md`):

- **Idempotent re-run:** running the full migration twice on the same bundle
  produces the same account/category/merchant/transaction counts and the same
  balances (assert no second `Transaction`, no second delta). **Additionally assert
  the staged rows are reused, not re-created:** the second run returns the existing
  `ImportBatch` (same `contentHash`) and each `RawImportedTransaction` keeps its
  **original persisted `promotionIdempotencyKey`** (no new UUIDv7 minted) — this is
  the stable key that makes re-promotion a no-op (§7).
- **Promotion parity:** a promoted Sure transaction equals the single-create path
  — signed amount (with the **inversion** applied), atomic balance delta,
  `Transaction.idempotencyKey`, `AuditLog`, RLS scope, tenant-validated refs, and
  **`baseAmount`/`baseCurrency`/`fxRateScaled` set**.
- **Sign inversion:** a Sure expense (`amount > 0`) lands as a negative Permoney
  amount; a Sure income (`amount < 0`) lands positive.
- **Opening balance:** with `Balance` rows, a cash-like account's opening =
  earliest `start_balance`; without `Balance` rows, opening = 0 + documented gap
  (and **no plug**).
- **Gating/held:** transfer-kind rows, rows on `isImportable=false`
  (Investment/TrackedAsset) accounts, and split parents are **staged but not
  promoted**; referenced accounts still exist as shells (no dangling refs).
- **Tenant isolation:** family A cannot read/write family B's batch, artifact, or
  raw rows; cross-family `accountId`/`categoryId` is rejected.
- **Partial-failure recovery:** a failure mid-transaction step leaves the run
  safely re-runnable — already-bound accounts/categories/merchants are reused, and
  no partial double-book occurs.

Pure units (`src/lib/sure-migration.ts`): NDJSON line parse + malformed-line
rejection, `normalizeSureAccountType` mapping + fallback, sign→`type`+abs
classification (incl. `0`), category parent two-pass remap.

## Alternatives considered

1. **Consume the per-entity CSVs.** Rejected — they reference accounts/categories
   by name (collisions, lost hierarchy, lost ids). `all.ndjson` preserves relations.
2. **Promote transfer legs as income/expense to reconcile balances now.** Rejected
   — corrupts the income statement and cash-flow reports (a transfer is not
   spending); violates the ledger contract.
3. **Plug opening balance = Sure.balance − Σ(txns).** Rejected (§5) — double-counts
   when deferred transfers later post.
4. **Seed non-cash/tracked balances from Sure now.** Rejected — front-runs PER-146
   and writes fake reconciled numbers.
5. **Natural-key (name+type+parent) dedup for categories.** Rejected — a post-import
   rename breaks re-run idempotency; name collisions merge distinct rows.
6. **Separate `SureCategoryMap`/`SureAccountMap` tables.** Rejected — duplicates the
   binding `Account` already inlines; two sources of truth; not provider-agnostic.
7. **Per-row `rawPayload` Json on `Account`/`Category`/`Merchant`.** Rejected —
   widens core ledger tables with blobs and duplicates the retained bundle.
8. **Hardcode `sourceKind="sure_migration"`.** Rejected — `sourceKind="migration"`
   - `provider="sure"` stays provider-agnostic for future migrations.
9. **Defer merchants to a later phase.** Rejected as default — same machinery as
   categories (~zero marginal cost) and deferring forces an extra audited
   `merchantId` relink on already-promoted transactions. (Kept as a fallback only if
   merchants reveal unexpected coupling to deferred rules/enrichment.)
10. **Commit the real (or lightly redacted) bundle as a fixture.** Rejected — real
    financial PII must never enter git; a deterministic synthetic builder is
    schema-faithful and safe.

## References

- PER-163 (Sure full-family migration — this ADR is its Phase-1 contract)
- PER-82 / ADR-0039 (import staging spine — reused unchanged for transactions)
- PER-151 (CSV import wizard — reusable parsing/preview UX)
- PER-150 (Investments — Phase 2 trades/holdings), PER-146 (valuation primitive)
- PER-118 / ADR-0015 (provider integration — `externalProvider` binding direction)
- ADR-0008 §5 (import staging boundary), ADR-0006 (idempotency + audit)
- ADR-0009 (category RLS / system-vs-tenant), ADR-0010 (composite tenant FKs)
- ADR-0011 (app-level tenant validation), ADR-0035 (FX base projection)
- ADR-0036 (membership / `ledger:write`), `docs/account-taxonomy.md`
- Sure source: `app/models/family/data_exporter.rb` (`EXPORT_VERSION = 2`),
  `app/models/sure_import/preflight.rb`, `app/models/transfer.rb`,
  `app/models/goal_pledge.rb` ("Sure convention: inflow < 0")
