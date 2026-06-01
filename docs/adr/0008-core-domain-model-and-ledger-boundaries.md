# ADR-0008 — Core domain model and ledger boundaries

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-06-01     |
| **Accepted**      | 2026-06-01     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

Permoney is a financial ledger, not a collection of interchangeable CRUD
tables. Future work will add bank/API imports, AI enrichment, asset valuation,
reconciliation, reporting, budgets, family authorization, and temporal
semantics. Those systems will all need to touch money-shaped data, but they
must not all become new sources of ledger truth.

The current schema already encodes several M2 decisions:

- `Transaction` rows carry signed BigInt minor-unit amounts, currency, account,
  type/status/kind, split state, soft-delete/supersession fields, and
  transaction-level idempotency.
- `Account.balance` is updated atomically inside the same database transaction
  as ledger mutations and protected by optimistic locking.
- `Transfer` and `SplitEntry` shape multi-row ledger events.
- `Category`, `Merchant`, and `SmartRule` support classification and
  enrichment.
- `AuditLog` records append-only evidence for mutations.
- Raw provider data and future bank-sync payloads are explicitly not canonical
  ledger data until normalized, deduplicated, tenant-validated, and confirmed.

Without a written domain boundary, future agents may accidentally treat imports,
metadata, AI suggestions, valuation snapshots, and report caches as alternate
ledgers. That would weaken auditability, tenant isolation, idempotency, and the
ability to replace providers or enrichment systems without rewriting the
financial model.

## Decision

**`Transaction` is the canonical ledger center. `Account`, `Transfer`,
`SplitEntry`, `AuditLog`, metadata, import staging, valuation snapshots, and
derived views each have explicit ownership around it.**

Permoney uses the following domain classes.

### 1. Canonical ledger data

Canonical ledger data is the durable representation of user-visible financial
events. It is the only class of data allowed to change account balances or
represent realized money movement.

- `Transaction` is the primary ledger row. It owns the signed amount, currency,
  source `accountId`, `type`, `kind`, `status`, transaction date, tenant
  (`familyId`), actor (`userId`), soft-delete state, supersession links, and
  idempotency key for create-style writes.
- `SplitEntry` is canonical allocation data for a split transaction. When
  `Transaction.isSplit = true`, the parent `Transaction.categoryId` and
  `merchantId` must be `null`; category/merchant allocation lives in the child
  rows.
- `Transfer` is the canonical pairing record for a transfer movement. A
  transfer is not one loose row; it is two `Transaction` legs plus one
  `Transfer` row that proves the graph.
- Soft-deleted and superseded transactions remain ledger history. They are not
  active for normal lists, but they are still part of the canonical historical
  record.

Only ledger mutations may create, supersede, soft-delete, or reconcile
canonical ledger data. They must run through the existing server-side mutation
boundary: interactive Prisma transaction, transaction-scoped RLS GUC,
tenant-reference validation, idempotency, atomic account deltas, Serializable
retry, and append-only audit logging.

### 2. Account state

`Account` is the tenant-owned balance container for ledger postings. It is a
core domain entity, but it is not a separate transaction ledger.

- `Account.balance` is a durable materialized state updated by canonical
  `Transaction` mutations.
- `Account.version` protects concurrent balance updates.
- Account type, currency, display name, and institution metadata describe where
  transactions post.

No code path may compute a new balance from memory and save it as a shortcut.
Balances change through atomic increments/decrements in the same transaction
that writes the canonical ledger event and audit rows.

### 3. Metadata and enrichment

Metadata describes, classifies, or suggests meaning for ledger rows. It does
not by itself prove money moved.

- `Category` classifies spending/income. System categories are global metadata;
  tenant categories belong to exactly one family.
- `Merchant` identifies counterparties for reporting, search, and rules.
- `SmartRule` stores deterministic enrichment rules used before import preview
  or manual classification.
- Notes, attachments, labels, and future AI-generated hints are enrichment until
  an accepted mutation writes them onto canonical ledger rows with audit
  evidence.

Changing a transaction's category or merchant can change reporting, budgets, and
search results, so it still requires tenant validation and audit logging. It
does not create a new financial event unless amount, account, transfer shape,
split allocation, or other ledger semantics change.

### 4. Evidence and mutation control plane

`AuditLog` and idempotency records are not balance sources, but they are part of
the financial control plane.

- `AuditLog` is append-only evidence for create, update, delete, bulk, import,
  onboarding, and future reconciliation mutations. It stores family, actor,
  entity identity, before/after snapshots, request metadata, and idempotency
  correlation.
- `IdempotencyRecord` owns replay for endpoint-scoped mutations such as update,
  delete, bulk operations, and future import confirmation jobs.
- `Transaction.idempotencyKey` owns transaction-level uniqueness for create-like
  ledger rows.

Reports may derive from `Transaction`; forensic explanations must be able to
walk `AuditLog` and idempotency records to explain why a ledger row exists or
changed.

### 5. Import staging

Raw import data is staging data, not ledger data.

Future bank APIs, CSV uploads, Open Banking providers, and reconciliation feeds
must first land in import-staging models such as an import batch, raw provider
payload, normalized candidate, match result, and per-row confirmation state.
Those models may store provider IDs, raw JSON, hashes, statement dates,
counterparty strings, confidence scores, and match candidates.

A staged row becomes canonical only when a confirmed mutation writes
`Transaction`/`SplitEntry`/`Transfer` rows through the same ledger mutation
contract used by manual entry. Duplicate detection, provider IDs, hashes, and
idempotency keys protect the staging-to-ledger transition; they do not make the
raw payload a ledger row.

### 6. Valuation snapshots

Valuation snapshots model point-in-time estimates of non-cash value. They are
not a substitute for transactions.

Future asset, liability, investment, loan, crypto, or property features may
store snapshots such as market price, quantity, quoted currency, source, and
valuation timestamp. Those snapshots feed net-worth and performance views.
They do not change `Account.balance` or create realized income/expense unless a
separate canonical transaction records a buy, sell, fee, dividend, interest
payment, cash transfer, loan payment, or realized adjustment.

Valuation data must be replaceable by a different provider without rewriting the
ledger. The transaction ledger records realized events; valuation snapshots
record estimates about state at a time.

### 7. Derived and cache data

Derived data is rebuildable.

Dashboard aggregates, budget rollups, report tables, search indexes, account
balance history materializations, reconciliation summaries, AI embeddings, and
TanStack DB client collections may accelerate reads. They must never become the
only place where financial truth exists.

If a derived row conflicts with canonical ledger rows and audit evidence, the
derived row is wrong and must be rebuilt.

## Relationship model

The core relationship model is:

```text
Family
  |-- Account: balance/version state updated by ledger mutations
  |-- Category: metadata; system categories may be global
  |-- Merchant: metadata
  |-- Transaction: canonical ledger event
  |   |-- SplitEntry[]: canonical split allocation
  |   |-- Transfer leg links: canonical dual-leg movement graph
  |   |-- Category/Merchant refs: accepted classification metadata
  |   `-- supersession/deletedAt: canonical history closure
  |-- AuditLog: append-only mutation evidence
  |-- Import staging: raw/normalized/confirmed provider pipeline
  `-- Valuation snapshots: point-in-time estimates for assets/liabilities
```

The direction matters. Imports, AI, rules, reconciliation, reports, and
valuation systems attach to or produce confirmed mutations into the ledger. They
do not replace the ledger.

## Boundary rules

1. **Realized money movement belongs in `Transaction`.** Any event that changes
   a cash, card, loan, liability, or tracked account balance must be represented
   as one or more canonical transactions.
2. **Classification is metadata until accepted.** A suggested category,
   merchant, note, label, or split is enrichment until a validated mutation
   writes it onto the ledger and audit log.
3. **Raw provider payloads stay in staging.** Bank/API payloads, CSV rows,
   statement lines, and OCR extracts may be stored losslessly, but they are not
   canonical until confirmed.
4. **Valuation is state, not posting.** Market-price movement and estimated net
   worth changes are valuation snapshots unless a realized transaction occurs.
5. **Derived views are disposable.** They can be cached, denormalized, or
   re-indexed, but they must be rebuildable from canonical rows and audit
   evidence.
6. **Future integrations call the ledger boundary.** Providers and AI workers
   may suggest or stage changes; the final write path remains the canonical
   mutation service with tenant validation, idempotency, audit, and balance
   invariants.

## Examples

### Manual entry

A user enters a grocery expense for IDR 250,000.

Permoney writes one `Transaction` with a negative signed amount, the user's
account, currency, date, status, optional accepted `Category`/`Merchant`
references, and a create idempotency key. The same database transaction
atomically decrements `Account.balance`, increments `Account.version`, validates
tenant-owned references, and writes `AuditLog`.

The category and merchant help explain the row, but the canonical financial
event is the transaction plus account delta and audit evidence.

### Import

A bank feed returns a card purchase payload.

Permoney stores the raw provider payload and normalized candidate in import
staging with provider IDs, hashes, statement metadata, and match candidates.
Smart rules and AI may suggest a category, merchant, or duplicate match. The
user or an approved rule confirms the candidate. Only then does the import flow
call the same create/bulk ledger mutation path used by manual entry.

Replaying the provider payload or browser request must not create another
transaction. Raw import rows may be retained for traceability, but they are not
the ledger.

### Asset tracking

A user tracks a brokerage account whose ETF position rises in market value.

The new market price is stored as a valuation snapshot for net-worth reporting.
It is not an income transaction and does not mutate cash balance by itself. If
the user buys shares, sells shares, receives a dividend, pays a fee, or moves
cash between accounts, those realized events are canonical transactions. The
valuation provider can be replaced later because realized ledger history is not
encoded in provider snapshots.

### Reconciliation

A statement line matches an existing transaction.

The reconciliation process records the match in staging/reconciliation metadata
and, if accepted, updates the canonical transaction status or reconciliation
fields through a ledger mutation with audit evidence. If the statement line does
not match, it remains a candidate or exception. It must not silently rewrite
amounts, accounts, dates, or transfer graphs outside the canonical mutation
boundary.

## Consequences

### Positive

- Future agents have one domain map before adding bank-sync, AI enrichment,
  valuation, reconciliation, or authorization work.
- `Transaction` remains the durable center for realized financial events, while
  metadata, staging, valuation, and caches have explicit ownership.
- Bank/API providers can be replaced because raw provider data and canonical
  ledger rows are separated.
- AI enrichment can improve categorization and matching without becoming an
  unreviewed ledger writer.
- PER-97 temporal semantics and PER-98 family authorization can refine their
  specific boundaries without redefining the core domain model.

### Negative

- Some future features require extra staging or snapshot tables instead of
  writing directly to `Transaction`. That is intentional overhead for audit and
  provider independence.
- Reports and UI caches cannot take shortcuts by treating aggregate rows as
  source of truth. Rebuild paths must exist.
- Reclassification still needs audit even when it does not change balances,
  because classification affects budgets, reports, and reconciliation evidence.

## Alternatives considered

1. **Treat every money-shaped table as ledger data.** Rejected. Import rows,
   provider payloads, valuations, and report aggregates have different trust
   levels and lifecycles. Merging them into the ledger would make reconciliation
   and audit ambiguous.
2. **Let bank providers write `Transaction` directly.** Rejected. Provider data
   needs deduplication, tenant validation, user/rule confirmation, idempotency,
   and audit before becoming canonical. Direct writes would couple the core
   ledger to provider quirks.
3. **Let AI enrichment mutate ledger rows directly.** Rejected. AI output is a
   suggestion with provenance and confidence, not a financial authority. Accepted
   suggestions must flow through normal mutations.
4. **Model asset market movement as income/expense transactions.** Rejected.
   Unrealized price movement is valuation state, not realized cashflow. Mixing
   the two would distort spending, income, and reconciliation.
5. **Make reports the primary source for balances.** Rejected. Reports are
   projections. `Transaction` plus atomic `Account.balance` updates and audit
   evidence remain the authoritative model.

## References

- PER-72 (M2.5-1 — ADR-0008: Core domain model and ledger boundaries)
- PER-97 (M2.5-15 — Temporal model for transaction, posting, clearing, and
  timezone semantics)
- PER-98 (M2.5-16 — Family membership and role authorization model)
- ADR-0001 (Money type migration)
- ADR-0006 (Idempotency keys and audit-log architecture)
- ADR-0010 (Tenant composite foreign-key invariants)
- ADR-0011 (App-level tenant reference validation)
- ADR-0012 (Transfer soft-delete symmetry)
- ADR-0013 (Optimistic locking and Serializable retry)
- ADR-0031 (Transfer graph database invariants)
- ADR-0032 (Idempotent update/delete semantics)
- ADR-0033 (Bulk mutation parity)
- `AGENTS.md` §5, The Transaction Core Architecture
- `prisma/schema.prisma`
