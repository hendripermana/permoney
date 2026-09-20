# ADR-0058 — People, ownership, and the Pit Stop balance check

|                   |                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                                                         |
| **Date**          | 2026-09-20                                                                                                       |
| **Accepted**      | 2026-09-20                                                                                                       |
| **Deciders**      | Hendri Permana                                                                                                   |
| **Supersedes**    | —                                                                                                                |
| **Superseded by** | —                                                                                                                |
| **Builds on**     | ADR-0036 (membership), ADR-0043 (balance anchors), ADR-0054 (holdings), ADR-0056 (Zakat), ADR-0057 (invitations) |

## Context

The first real two-person household joined a Permoney family (ADR-0057). Three gaps showed up within a day, none of them bugs in the ledger:

1. **"Whose is this account?" has no visible answer.** Ownership already exists in the engine — `ZakatPayer` (a family-scoped person, optionally linked to a `User`) plus `Account.zakatPayerId` / `zakatJointPayerId` / `zakatJointSharePercent`, set through an idempotent, audited, tenant-validated server function. But the only control (`ZakatOwnershipSection` in the account dialog) is labelled "Zakat ownership", only renders while _editing_, and renders **nothing until a second payer exists** (ADR-0056's "no clutter for a single-person household" rule). A second payer can only be created from the Zakat settings page. A household that does not use Zakat, or does not know to look there, cannot say who owns what.
2. **A shared portfolio holds different people's products.** A holdings account (ADR-0054) such as "Dana Darurat Family" is one Bibit portfolio holding funds that belong to different people, and each person can see only their own products' details. Ownership therefore has to be per **holding**, not only per account.
3. **Recording effort is the real cost.** One spouse spends from a bank account and from cash, mixed at random; there is no statement export. Reconstructing three months of transactions is not going to happen, and should not be required. The ledger already has the right primitive — a reconciliation anchor (ADR-0043) asserts the true balance without posting a compensating transaction — but it can only be applied one account at a time, from an account's detail page.

The creator framed the standard for the fix: Permoney should behave like a Formula 1 car — enormously sophisticated under the skin, but with a steering wheel the driver can operate without thinking.

## Decision

### Design doctrine (applies to every decision below)

1. **One control per intent.** The user states an intent ("this is Rahayu's", "my wallet has Rp 120,000 now"), never a bookkeeping mechanism.
2. **Ask once, derive the rest.** An owner and a real balance are each asked for once. Wealth per person, Zakat per person and unrecorded spending are derived, never re-entered.
3. **Derived numbers can never disagree.** Per-person wealth is computed by the same function as the family net-worth card, and a conservation property (Σ persons + unassigned = family total, to the minor unit) is asserted in tests.
4. **Telemetry before crashes.** Numbers that look implausible are challenged at entry time (see Phase 3).

### D1 — A "person" is the existing `ZakatPayer`; the UI says "Owner"

No table rename now. `ZakatPayer` already is a lightweight, family-scoped, auth-free "who" with a `linkedUserId` hook; renaming a shipped model to `Person` is a mechanical refactor that buys nothing for the driver, so it is deferred until a third consumer justifies it (recorded as debt, not hidden). User-facing copy is neutral ("Owner", "Shared with"); Zakat pages keep saying "payer".

**Members resolve to people on demand.** Ownership inputs accept an `OwnerRef` = `{ personId }` **or** `{ memberUserId }`. For a `memberUserId` the server validates that the user is an _active member of this family_, then get-or-creates the person linked to them inside the same transaction. No backfill migration, and there is no "add payer" chore before you can assign an owner.

**The owner control is always available** in the account dialog when the family has two or more active members _or_ two or more people — independent of whether Zakat is enabled and independent of the payer count. A one-member family still sees nothing.

### D2 — Ownership is per holding as well as per account

`Holding.ownerPersonId` (nullable) with a composite tenant FK to `ZakatPayer(id, familyId)` and `ON DELETE SET NULL (ownerPersonId)` — the same PG15 column-scoped form ADR-0056 needed, because a bare composite `SET NULL` would also null `familyId`. Effective owner of value, in order: the holding's owner → the account's owner (with its joint split) → **unassigned** (shown as "Shared / unassigned"). The holding form gains an Owner select defaulting to "Same as account". Holdings created by a Buy trade default to no owner (they inherit the account's).

### D3 — Wealth by person

A pure function in `src/lib/wealth-by-person.ts` attributes each account's (and each holding's) signed native balance to people, then runs each person's list through `normalizeNetWorthAt` — the same normalizer as `NetWorthInBaseCard` and the net-worth series (ADR-0038). Joint accounts split by `zakatJointSharePercent`, with any integer-rounding remainder going to the primary owner so nothing is created or lost. Where a holdings account's holdings do not sum exactly to its balance, the residual stays with the account-level owner (or unassigned). Surfaced as a "Wealth by person" card on the Accounts page, shown only when the family has two or more people. No new persistence: it is computed on read.

### D4 — Pit Stop: a batch balance check

A new route `/pit-stop`, and one server function that applies **the existing ground-truth reconciliation** (`createValuationWithinTx`, type `reconciliation`, provenance `ground_truth`) to many accounts in one transaction.

- **Who sees what:** by default the accounts owned by (or jointly owned with) the current user's person; a toggle shows everyone's. If the user owns nothing yet, all eligible accounts are shown with a prompt to set owners.
- **Eligible accounts:** active, not deleted, `balanceSource = transaction_flow`, type DEPOSITORY, CASH, E_WALLET or CREDIT. Holdings/valuation accounts are excluded (their value comes from units × price, and the ledger already rejects a manual value on them).
- **One screen, one field per account:** account name, "In app" (canonical balance), "Actual now" (a `MoneyInput`), and a live difference preview. Blank rows are skipped. Capability: `ledger:write`, the same as a single reconcile.
- **All-or-nothing, idempotent, audited:** one batch idempotency key with a canonical payload hash; each anchor is audit-logged by the existing path, with metadata `{ source: "pit_stop", priorBalance, delta }`. The server reads the canonical balance inside the transaction immediately before writing each anchor, so the returned before/after/delta are authoritative, not the client's possibly stale numbers.
- **Result:** per-account before → after and the net **unrecorded movement** per currency ("Rp 632,000 left that was never recorded"). It is a derived number, not a transaction: no compensating row is posted (ADR-0043 forbids the double-count). The label says "net" because unrecorded income and unrecorded spending cancel.
- **Freshness:** each row shows when the account was last checked (its latest ground-truth anchor date); a dashboard nudge ("Pit stop due") is a fast follow.

### D5 — Phasing

| Phase | Scope                                                                                                                                                                                                                                         | Notes                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | D1–D3: owner control, per-holding owner, Wealth by person                                                                                                                                                                                     | one additive migration                                                                     |
| 2     | D4: Pit Stop (batch reconcile, "last checked", result screen)                                                                                                                                                                                 | no migration; independent of Phase 1 (reads the existing payer/link fields)                |
| 3     | Sanity guard on holding entry ("3,070 units × 1,309 = Rp 4.02M — matches your Bibit?"; warns when units × price is wildly off the deposits); unrecorded-movement line in the cash-flow report, derived from anchors; Pit Stop dashboard nudge |                                                                                            |
| 4     | Zakat for investments and gold, per owner, using D2                                                                                                                                                                                           | needs the creator's fiqh decisions (ADR-0056 left holdings/gold out of Slice 1 on purpose) |

## Alternatives rejected

- **Rename `ZakatPayer` → `Person` now.** Correct eventually, invisible to the user, and a wide diff across a shipped, religiously sensitive feature. Deferred.
- **Reconstruct history via CSV import / bank sync for the second spouse.** No statement export exists for her banks, her spending is mixed with cash, and the goal is accurate balances and net worth, not receipt-level fidelity. A balance check gives that at a tiny fraction of the effort.
- **Post a plug transaction for the unrecorded difference.** Rejected by ADR-0043: it double-counts the anchor's own value.
- **Per-account privacy / per-person permissions.** A different product (it breaks the shared ledger's single net worth). Not proposed; Zakat's per-person separation is a _calculation_ concern, not visibility.
- **Auto-create people for every member via a backfill migration.** Adds a data migration to protect an invariant the on-demand resolver already gives for free.

## Consequences

- One additive migration (`Holding.ownerPersonId` + index + composite FK). No change to ledger math, balances, or existing ownership columns.
- **Zakat interaction to watch:** once a family has a second person, Zakat runs in multi-payer mode, where an account with no owner is _excluded_ until tagged (ADR-0056). Resolving an owner for a member can therefore make untagged accounts drop out of the Zakat number. The Zakat page must keep listing unassigned accounts prominently; verify this in Phase 1.
- Real-Postgres tests are required: the on-demand member→person resolver (active-member validation, one person per user, idempotent), the per-holding FK (tenant isolation, `SET NULL` on person delete leaving `familyId` intact), the batch reconcile (all-or-nothing, idempotent replay, holdings accounts rejected, canonical `before` read in-transaction), plus a property test for the wealth-by-person conservation invariant.
- Pit Stop writes an anchor even when the difference is zero: it asserts the truth at that time and refreshes "last checked". A backdated transaction entered after an anchor follows the existing ADR-0043 / anchor-provenance behaviour ("record only — balance unchanged" versus "also update balance").
