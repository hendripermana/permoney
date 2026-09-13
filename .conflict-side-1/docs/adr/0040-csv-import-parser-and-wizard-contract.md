# ADR-0040 — CSV/QIF import parser and wizard contract

|                   |                                                     |
| ----------------- | --------------------------------------------------- |
| **Status**        | Accepted                                            |
| **Date**          | 2026-06-24                                          |
| **Accepted**      | 2026-06-24                                          |
| **Deciders**      | Hendri Permana                                      |
| **Supersedes**    | —                                                   |
| **Superseded by** | —                                                   |
| **Builds on**     | ADR-0039 (import staging, deduplication, promotion) |

## Context

ADR-0039 locked the durable **staging spine**: `StagedRowInput`, the row state
machine, deterministic dedup, three-layer idempotency, atomic audited promotion,
and the four server functions (`createImportBatchFn`, `getImportBatchFn`,
`reviewImportRowsFn`, `promoteImportBatchFn`). It deliberately ships **no CSV
parser and no UI** — §10 names that the seam input is already-field-extracted
`StagedRowInput[]`, and states "PER-151's wizard does CSV→`StagedRowInput`
(including resolving each row's account)."

PER-151 is that wizard. The only genuinely new, durable decisions it introduces
are about **turning an opaque file into `StagedRowInput[]` deterministically** —
how columns map to fields, how an absolute magnitude + `income|expense` type is
derived from the many ways exporters encode sign, how ambiguous dates are
resolved without silent corruption, and how the non-columnar QIF format fits the
same seam. None of these touch ledger correctness, tenant isolation, balances, or
money invariants — those are all enforced **server-side** by ADR-0039 at staging
and promotion. A mis-mapped column at worst produces a wrong-looking preview row
that the user rejects before promotion; it can never silently corrupt the ledger.

This ADR documents the parser/wizard contract so a future agent adding a new
preset (Revolut, OFX, a local bank export) extends a known shape instead of
reinventing one.

## Decision

**The CSV/QIF parser is a pure, DB-free module (`src/lib/csv-import.ts`) that
deterministically maps a file + an explicit column/format mapping into client
`ParsedImportRow`s, which the wizard stamps with one chosen target account and
submits as `StagedRowInput[]`. All money/ledger correctness stays in ADR-0039.**

### 1. Pure module boundary

`src/lib/csv-import.ts` contains only pure functions and types — no Prisma, no
React, no server fns, no network. It is unit-tested in isolation
(`src/lib/csv-import.test.ts`). The wizard route imports it, adds the chosen
`accountId` and `rawPayload`, and calls the existing server fns. This mirrors the
`src/lib/import-staging.ts` (pure) ↔ `src/server/imports.ts` (server) split from
ADR-0039 §10.

### 2. The three-mode amount model

`StagedRowInput.amount` is **positive minor units** (`absAmountSchema`) plus a
separate `type ∈ {income, expense}`. Exporters encode this three different ways,
so the mapping's amount config is a discriminated union — the minimal set that
covers the named formats without per-format special-casing:

- **`signed`** — one amount column; the sign decides the type. Config carries
  `negativeMeans: "expense" | "income"` because banks disagree on whether a
  debit is negative. → generic bank CSV.
- **`split`** — two columns (outflow/debit, inflow/credit), each a positive
  magnitude; whichever is non-empty/non-zero sets both type and amount. →
  **YNAB** (`Outflow`/`Inflow`).
- **`typed`** — one positive-magnitude amount column plus a separate type column
  whose values map (case-insensitively) to expense/income. → **Mint**
  (`Amount` + `Transaction Type`: `debit`→expense, `credit`→income).

Magnitudes are parsed with the canonical, currency-aware `parseUserInput(raw,
currency)` from `src/lib/money.ts` (tolerant of locale thousands/decimal
separators and currency symbols; returns `null` on garbage), then reduced to
absolute minor units. **Currency is the chosen target account's currency** — the
same single-source-of-truth rule ADR-0039 §4 applies at normalize/promote.

### 3. Explicit date format — never heuristic

CSV dates are ambiguous (`03/04/2026` is Mar 4 US or Apr 3 elsewhere). Silent
month/day flips would corrupt ledger dates, so the wizard requires an **explicit
date-format choice** from a small supported set
(`YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-MM-YYYY`); presets pre-select a
sensible default but the user can override. The parsed date is shown in the
preview before promotion. A cell that does not parse under the chosen format
makes the row an **error row** with a reason — it is surfaced and excluded from
submission, never silently dropped or guessed.

### 4. Presets

Presets pre-fill the column mapping + amount mode + date default; the user can
adjust every field afterward. Shipped: **generic** (user maps everything),
**Mint** (`typed`), **YNAB** (`split`). A preset is data, not code — adding one
is a new entry in the preset table, the reason this lives behind an explicit
mapping contract.

### 5. QIF is a separate parser, same seam

QIF is line-oriented (`!Type:Bank`, `D`=date, `T`=signed amount, `P`=payee,
`M`=memo, `^`=record end), not columnar, so it cannot share the column-mapping
UI. It gets its own pure parser that emits the same `ParsedImportRow[]`; the
`T` sign maps to type (negative→expense). It still needs the explicit date-format
choice (QIF dates are equally ambiguous) and the target account. The wizard
detects `.qif`, skips column-mapping, and goes straight to account selection,
date-format, then preview.

### 6. Single target account per file (this slice)

ADR-0039 §1 makes `accountId` authoritative **per row** so one file can fan out
across many accounts (a full Sure export). PER-151 ships the common case: the
user picks **one** Permoney account and every row is stamped with it. Per-row
account-column resolution (and the full multi-account Sure migration) is
**reserved** for PER-163 / a follow-up; it does not change this contract, it only
populates `accountId` differently.

### 7. Review default verdicts (preview → confirm/reject)

`promoteImportBatchFn` only promotes `rowStatus === "confirmed"` rows
(ADR-0039 §9), so the review step is mandatory and its **defaults decide what
lands**. The wizard pre-selects:

- `normalized` (clean) → **Confirm**.
- `normalized` + `possibleDuplicate` (near-dup) → **Confirm**, badged amber so
  the user notices.
- `duplicate` (exact canonical/in-batch match) → **Reject**, badged — opt back in
  deliberately.

The user can flip any verdict before promoting; this is a UI default only, never
a server invariant — the server's per-row promotion idempotency key still makes a
true canonical double-book impossible regardless of the choice.

### 8. Error and scope boundaries

Rows failing client validation (unparseable date/amount under the chosen format,
empty description, zero amount) are shown as **won't-import** with a reason and
excluded from the `StagedRowInput[]` payload, because `stagedRowInputSchema`
requires a valid positive amount, date, and non-empty description. Like ADR-0039
§9, the wizard handles **income/expense flat single-account rows only**;
transfers, splits, and multi-currency rows (row currency ≠ account currency) are
out of scope here.

## Consequences

### Positive

- Adding a new file format is a new pure preset/parser entry feeding the same
  seam — no new server code, no ledger risk.
- Deterministic date handling removes a whole class of silent date-corruption
  bugs; the preview makes every transformation visible before promotion.
- The wizard reuses ADR-0039's four server fns unchanged; all money invariants
  (dedup, idempotency, atomic balance, audit, RLS, FX projection) stay in one
  place.

### Negative / costs

- The explicit mapping/date UI is more steps than blind auto-detect, traded for
  correctness and visibility.
- Per-row account mapping and QIF's investment/split records are deferred; a Sure
  full-family import (PER-163) needs more than this contract provides.

## Alternatives considered

1. **Auto-detect date format heuristically.** Rejected — ambiguous all-≤12 dates
   can silently flip month/day in a ledger; explicit choice + preview is safe.
2. **Two amount modes (special-case Mint inside its preset).** Rejected — the
   `typed` mode generalizes the abs-amount-plus-type-column pattern for future
   exporters instead of hiding it in one preset.
3. **Fold QIF into the column mapper.** Rejected — QIF is not columnar; forcing it
   into column mapping is leakier than a small dedicated parser to the same seam.
4. **No ADR (pure client code).** Rejected — the amount model, date set, and
   preset shape are durable decisions future format work builds on; ADR-0039
   explicitly left the parser contract to this slice.

## Testing

- **Pure units (`src/lib/csv-import.test.ts`):** CSV header parsing; each amount
  mode (`signed` sign→type, `split` outflow/inflow→type, `typed` value→type);
  locale amount parsing → minor units for 0- and 2-decimal currencies; each
  supported date format + rejection of an unparseable date; Mint and YNAB preset
  mappings end-to-end; QIF record parsing; error rows surfaced not dropped.
- **E2E (`tests/e2e`):** upload a small CSV → preview shows normalized rows →
  promote → the transaction appears in the ledger (real route + server fns).
- **Server-side ledger correctness** (idempotent replay, promotion parity, tenant
  isolation, dedup) is already covered by ADR-0039 / PER-82's real-Postgres
  integration suite, which this wizard calls unchanged.

## References

- ADR-0039 (Import staging, deduplication, and promotion — the seam this consumes)
- ADR-0035 (Currency/FX — base projection at promote; account currency authority)
- ADR-0006 (Idempotency keys and audit-log architecture)
- ADR-0036 (`ledger:write` capability covers import)
- `src/lib/money.ts` (`parseUserInput`, `toMinorUnits` — canonical amount parsing)
- PER-151 (P4 — CSV import wizard), PER-82 (M2.5-11 — import staging)
- PER-163 (Sure full-family migration — per-row multi-account import, reserved)
