# ADR-0054 — Holdings-account operational coherence (money movement for investment accounts)

|              |                                                                                    |
| ------------ | ---------------------------------------------------------------------------------- |
| **Status**   | Accepted                                                                           |
| **Date**     | 2026-08-16                                                                         |
| **Deciders** | Hendri Permana                                                                     |
| **Amends**   | ADR-0043 (valuations), ADR-0048 (valuation-linked cash moves), ADR-0051 (holdings) |

## Context

Reksadana NAV auto-pricing is now live (PER-250/257/258), so real holdings-tracked
investment accounts exist and get used. Dogfooding surfaced that **money movement
for a holdings account is not operationally coherent** — there are several
entry points that do different, partly-conflicting things:

- **Buy/Sell trades** (`recordTradeFn`, PER-198/ADR-0051) — the correct path:
  cash leg on a funding (cash-like) account + units±quantity + cost basis + a new
  valuation on the investment side (never a raw balance write — respects the
  guard) + realized gain on sell. Atomic, audited, idempotent.
- **Valuation-linked transfer** (ADR-0048) — cash leg + a new **valuation**
  (value moves, **no units**). Correct for a valuation account that has **no
  holdings** (property, a manually-valued asset).
- **Plain transfer / "Add transaction"** — a classic dual-leg transfer. On a
  valuation account this is BLOCKED by the guard (`assertIncrementalBalanceWriteAllowed`
  - the `valuation_account_balance_write_safe` constraint trigger, ADR-0048 §3).
- **"Update value"** — a manual valuation on the tracked account.

The defect: on a **holdings** account, the valuation-linked-transfer and
"Update value" paths set a **value** without changing **units**, so units × NAV
(the real position) desyncs from the stored value. And Sell was only reachable
per-holding-row, so the account header showed Buy but no Sell. The system was not
"operationally ready" for the way an investor actually transacts.

## Decision

**Broker/country-agnostic principle.** Permoney serves users worldwide on any
broker/fund app (Bibit, Ajaib, Vanguard, Fidelity, IBKR, …), any currency, any
country. Every mechanism here is modelled on the UNIVERSAL concept (a
"distribution", a "position move", a "trade"), never a single vendor's wording or
behaviour. Vendor specifics (e.g. one app auto-reinvests, another pays cash) are
just which generic option a user picks — never hardcoded.

**A holdings-tracked account moves money ONLY through trades.** For an account
that carries holdings, every money movement is a trade on the `recordTradeFn`
family; the plain-transfer, valuation-linked-transfer, and manual "Update value"
paths are not offered and are rejected server-side. Value on a holdings account
is always Σ(units × price) — never set directly.

Precisely, keyed on the account's state:

| Account state                                          | Money-in / money-out mechanism                         |
| ------------------------------------------------------ | ------------------------------------------------------ |
| **cash-like** (`transaction_flow`)                     | normal transactions / transfers (unchanged)            |
| **valuation, NO holdings** (property, manual asset)    | valuation-linked transfer (ADR-0048) + "Update value"  |
| **valuation, WITH holdings** (reksadana, gold, stocks) | **trades only** — Buy / Sell / Dividend / Fee / Switch |

### The cascade — "if we do this, we also need…"

Making trades the sole path for holdings accounts implies a set of trade modes +
guards that must ALL exist for the model to be coherent (not just Buy/Sell):

1. **Sell must be first-class** — panel-level (not only per-row), a position
   picker when unspecified, guard sell-qty ≤ held, sell-all closes/archives the
   position, realized gain shown. _(Slice 1 — panel Sell shipped.)_
2. **Buy must cover first + subsequent** — create the instrument inline on the
   first buy; average-cost into an existing position on later buys. _(Exists.)_
3. **Dividend / distribution** — a distinct mode with TWO shapes, both universal
   across brokers/funds (NOT Bibit-specific — see the Broker-agnostic principle):
   - **Cash payout**: income with **no units and no position-value change** —
     cash credited to a **user-chosen destination account** (often a DIFFERENT
     account than the holding, e.g. a pension/cash pot), back-datable, and
     provenance-linked to the source holding for reporting. The holdings account
     is NOT mutated.
   - **Reinvest**: **units up** at the reinvest price, **no external cash**; cost
     basis increases by the reinvested amount (like an internally-funded Buy).
     Real case (creator, BNI-AM Ardhani): 3 CASH dividends (2025-06-11 12,151 ·
     2025-12-08 17,268 · 2026-06-08 595) auto-deposited to a _separate_ "Dana
     Pensiun" account; units flat. So the destination is user-selectable and the
     date is user-set — do not assume same-account or today.
4. **Fees** — purchase / redemption / management fees reduce cash or NAV value;
   a fee that isn't modeled gets mis-booked as a mystery value drop.
5. **Switch** (fund A → fund B) — an atomic sell-A + buy-B in one account, the
   single most common reksadana action after buy/sell; without it users do two
   trades that can half-fail.
6. **Server + DB invariant** — reject a plain transfer / valuation-linked move /
   manual value-set whose leg is a **holdings** account, fail-loud with "use
   Buy/Sell" (the guard already blocks raw balance writes; this extends it to the
   value-set paths and gives an actionable message). UI hides the paths;
   **the server is the law** (single + bulk + import + future bank-sync).
7. **Entry-point coherence (UI)** — on a holdings account the primary actions are
   Buy/Sell (+ Dividend/Fee/Switch); "Add transaction" transfer and "Update
   value" are removed or redirected so a user can't silently desync the position.
8. **Edit / delete / correct a trade** — a mis-entered Buy/Sell must be
   correctable (reverse + re-record, audited) — today edit of a valuation-linked
   transfer is unsupported (ADR-0048 known limitation); trades need coherent
   edit/delete too.
9. **Funding-account selection** — every trade names the cash account the money
   comes from / returns to; multi-account families need it explicit.
10. **Multi-currency trade** — buying a USD fund from IDR cash needs FX; deferred
    to the global-instruments slice (Slice C of ADR-0052) but the trade schema
    must not assume same-currency forever.
11. **Legacy rows** — plain transfers / manual income that predate holdings on an
    account (e.g. the creator's Dana Darurat) are **grandfathered as history**; a
    "holdings baseline" marks where holdings tracking begins. No destructive
    migration (creator's call).
12. **Precision + idempotency** — fractional units (scaled bigint) and an
    idempotency key on every trade (retry-safe), same contract as the ledger.
13. **Move a position between accounts (in-kind portfolio move)** — a broker lets
    you move a fund/position from one portfolio to another WITHOUT selling (Bibit
    "pindah portofolio", and its analogues everywhere). Model as an in-kind move:
    the holding (units + cost basis) leaves account A and lands in account B; both
    accounts' Σ(units × price) re-materialize; NO cash leg, NO realized gain (cost
    basis carries over). Distinct from Sell-then-Buy (which realizes gain + moves
    cash). Withdraw stays Sell.

### Non-goals (this ADR)

Options pricing, dividends tax lots, corporate actions (splits/mergers), and
FIFO-vs-average election beyond the current average-cost model — later.

## Consequences

- One coherent mental model: _on a holdings account, you trade; value follows
  units × price automatically._ No conflicting entry points, no desync.
- More trade modes to build (dividend/fee/switch) — but each closes a real hole
  a user would otherwise hit.
- The guard + UI removal must land together with the modes, else a holdings
  account temporarily can't record a legitimate movement (sequence carefully).

## Implementation slices (Linear epic)

- **Slice 1 — discoverability + entry-point coherence**: panel Sell (done);
  hide/redirect "Add transaction" transfer + "Update value" on holdings accounts;
  server + DB invariant with an actionable "use Buy/Sell" message; real-PG + e2e.
- **Slice 2 — Dividend / distribution** trade mode (cash-out or reinvest).
- **Slice 3 — Fees** (standalone) — DONE (PER-259 Slice 3). A **standalone fee**
  tied to an investment (platform / annual / one-off transaction / redemption fee
  charged _separately_) is modelled as an **EXPENSE** on a **user-chosen cash
  account** (`transaction_flow`), reducing its balance via the guarded delta (so
  a fee can never land on a holdings/valuation account), back-datable,
  categorised with a family **"Investment Fee"** expense category (find-or-create,
  case-insensitive — the Slice 2 pattern), and provenance-linked to the source
  holding/instrument (description + notes + an append-only `Fee` AuditLog row).
  **The source holding is NOT mutated.** Server `recordFeeFn` / `recordFeeForFamily`;
  within-tx primitive `postExpenseTransactionWithinTx` (the EXPENSE sibling of
  Slice 2's `postIncomeTransactionWithinTx`; `createTransactionForFamily`
  untouched). Same-currency this slice.
  - **Out of scope — already captured, never double-counted:** a fee **embedded
    in a Buy/Sell** (purchase / redemption load) is already in the trade —
    `cashAmount` is authoritative, the load is part of the cash actually
    paid/received. And **NAV-embedded management fees** (reksadana / ETF expense
    ratios) are already inside the NAV/price, so the Σ-holdings value already
    reflects them — NOT recorded separately. Slice 3 adds only the standalone fee.
- **Slice 4 — Switch** (atomic sell-A + buy-B).
- **Slice 5 — Edit/correct a trade** (reverse + re-record, audited).
- **Slice 6 — Move a position between accounts** (in-kind, no cash, cost basis carries).
- Cross-cutting: multi-currency trade + FX rides ADR-0052 Slice C/D; everything
  broker/country-agnostic (Broker-agnostic principle above).
