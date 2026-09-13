# ADR-0051 — Investments & Holdings domain (multi-instrument portfolio)

|                |                                                                                         |
| -------------- | --------------------------------------------------------------------------------------- |
| **Status**     | Proposed                                                                                |
| **Date**       | 2026-08-04                                                                              |
| **Deciders**   | Hendri Permana                                                                          |
| **Amends**     | ADR-0008 (domain/ledger boundaries), ADR-0034/0043 (valuations), ADR-0050 (market data) |
| **Supersedes** | PER-239 account-level opt-in valuation (folded in)                                      |

## Context

PER-229 gave each valuation-tracked account ONE value and ONE cost. Real
brokers do not work that way. Verified against the creator's actual holdings:

- **Bibit (reksadana)** — a "portfolio" account holds several funds; each fund
  shows _units_ (`1,353.5149`), _average buy price_ (`Rp 1,477.63`), _cost_
  (`Rp 2,000,000`), _current value_ (`Rp 2,008,370`), _gain_ (`+Rp 8,370
/ +0.42%`).
- **BSI Gold** — `2.0180 gram` × avg buy `Rp 2,760,809/gram` = cost
  `Rp 5,571,313`; today's sell price `Rp 2,455,000/gram` → value `Rp 4,954,190`;
  `−Rp 617,123 / −11.08%`.

Two corrections to earlier assumptions this ADR bakes in:

1. **Scale.** DB balances are minor units (sen). The account earlier read as
   "533jt" is `Rp 5,333,433`. All amounts here are real (millions of rupiah).
2. **Cost basis is NOT lost.** The creator has units + average cost from the
   broker apps. Cost lives PER-HOLDING and is user-entered (later auto from
   feeds/confirmations), never fabricated. The "cost unknown" worry only applies
   to a legacy account with no holdings entered yet.

Goal (creator's brief): support **every investment type worldwide** — mutual
funds, gold/metals, stocks, government bonds (SBN), time deposits (deposito),
crypto — and be decisively better than Sure/YNAB (no real holdings) and Revolut.

The account-level approximation (PER-239) can't express units, average cost, or
multiple positions per account. The right primitive is a **holding**.

## Decision

Introduce a **Holdings domain**: the asset-side valuation layer for investment
accounts, plugging into the canonical cash ledger (ADR-0008) WITHOUT becoming a
second source of cash truth.

### Model

- **`Instrument`** (global, family-neutral; shared with ADR-0050): the tradeable
  thing — fund / stock / metal / bond / crypto / deposit-product — carrying a
  `kind` and a `priceModel`. Manual "instruments" (a named fund with no feed)
  are allowed; a feed-backed instrument links to `InstrumentQuote`.
- **`Holding`**: a position of an `Instrument` inside an investment `Account`,
  tenant-scoped (familyId + RLS). Carries `quantity`, a `valuationMethod`, and
  method-specific fields. An account may hold many (Bibit = several funds).
- **`HoldingLot`** (from Slice 5): individual buy lots `(date, quantity, unitCost)`
  for exact cost basis (FIFO/average) and realized gains. v1 may aggregate to a
  single average-cost lot.
- **Account value = Σ its holdings' current value.** The investment account is
  valuation-tracked; its balance is materialized from the holdings via the
  existing valuation mechanism (a holdings-derived **anchor** valuation,
  ADR-0034/0043), so every net-worth / balance / audit invariant holds for free.

### Valuation methods (per instrument kind — extensible, not bespoke subsystems)

1. **Market-priced** — value = `quantity × latest price/unit`; cost = Σ lots
   (`unitCost × qty`); gain = value − cost.
   - reksadana: unit = fund unit, price = NAV/unit.
   - gold/metals: unit = gram (also troy oz), price = spot/gram.
   - stocks: unit = share, price = last; carries ticker + exchange (MIC).
   - crypto: unit = coin, price = spot.
2. **Yield-bearing** — value = `principal + accrued interest to date`; fields:
   principal, rate (bps), start date, tenor/maturity, compounding. Gain = accrued
   interest. Optional market price for tradeable instruments.
   - deposito (time deposit): principal + rate + tenor → accrued / maturity value;
     not market-fluctuating (hold to maturity), maturity-dated.
   - SBN / bonds: face value + coupon + maturity; held-to-maturity uses accrual,
     tradeable secondary adds an optional market price/yield.

A `valuationMethod` field selects the formula. New instrument types add a method,
never a new subsystem. All math is pure and unit-tested; property-based
invariants (PER-208 harness) fuzz thousands of qty/price/lot/accrual combinations
(quantity ≥ 0, value = method(qty, price/principal), Σ holdings = account value,
realized+unrealized accounting closes).

### Cash-ledger integration (one source of cash truth)

- **Buy**: cash leaves a cash account (a canonical `Transaction`, ADR-0048
  valuation-linked) → creates/increases a `Holding` (+ a cost lot).
- **Sell**: quantity leaves the `Holding`, cash enters a cash account → realized
  gain from lots.
- **Income** (dividends, coupons, distributions): cash in, optionally reinvested
  (a new lot).
- Cash movements stay canonical double-entry `Transaction`s (idempotent, audited,
  tenant-scoped, RLS). Holdings are the ASSET valuation layer, reconciled to the
  ledger through the valuation anchor — never a parallel cash ledger. This is the
  ADR-0008 §"asset tracking plugs in without rewriting the core" contract made real.

### Cost basis (honest)

Cost = Σ lots entered from the user's broker data (units + average price they
already have), later auto from confirmations/feeds. NEVER fabricated. A legacy
account with a manually-tracked value but no holdings shows value-only (PER-229
`hasBasis=false`) until holdings are entered — then cost + gain become exact.

### Migration (live prod, gated)

Existing INVESTMENT/TRACKED_ASSET accounts opt into holdings: seed the current
balance as the account's current value; the user adds holdings (units + avg cost
from Bibit/BSI) to make cost + gain exact. No data loss; the manually-adjusted
legacy transaction history is superseded by holdings and left untouched. Backup +
explicit creator go-ahead + real-PG + property-based migration tests before any
live write. Supersedes PER-239 (its account-level value+cost is the degenerate
"one holding" case).

## Consequences

**Positive**

- A true multi-instrument portfolio — units, average cost, current value,
  unrealized + realized gain, allocation — per account and aggregated. Surpasses
  Sure/YNAB (no holdings) and matches/exceeds Revolut across asset classes.
- One extensible model spans reksadana, gold, stocks, SBN, deposito, crypto; new
  types are a valuation method, not a rewrite.
- Cash truth stays in the canonical ledger; holdings reconcile via the existing
  valuation anchor, so ledger invariants + tenant isolation hold unchanged.
- Feeds (ADR-0050) auto-price market instruments; deposito/SBN accrue by formula.

**Costs / risks**

- New tenant-scoped schema (`Holding`, `HoldingLot`) + buy/sell/income flows +
  lot accounting + realized-gain math — delivered in slices, each real-PG +
  property-tested.
- A live-data migration of the creator's accounts (gated, backed up, tested).
- Instrument-type breadth (bond yield, deposito accrual) is genuinely intricate;
  each method needs its own careful tests.

## Implementation slices (Linear)

1. **Holdings core** — `Instrument` (manual) + `Holding` schema (tenant-scoped),
   Holding CRUD, market-priced valuation (qty × manual price), account value =
   Σ holdings as a valuation anchor. Real-PG + property tests.
2. **Reksadana + gold** — units (fund unit, gram), average cost, buy/sell flow
   cash-linked; the creator's Bibit + BSI Gold become exact.
3. **Stocks + crypto** — ticker/exchange, crypto; prices via ADR-0050 feeds.
4. **Yield-bearing** — deposito + SBN (principal/rate/tenor/maturity, accrued
   interest, coupons).
5. **Lots + realized gains** — FIFO/average cost, dividends/coupons reinvest.
6. **Portfolio + dashboard** — PER-230/231 read holdings (total value, cost,
   gain, allocation by kind), base-currency normalized (ADR-0035).

## Opt-in valuation for investment accounts (PER-239)

Genuine INVESTMENT accounts default to `balanceSource="transaction_flow"`
(`getBalanceSourceForType` in `src/lib/accounts.ts` maps only `TRACKED_ASSET` →
`"valuation"`). The holdings core (Slice 1) attaches only to valuation-tracked
accounts, so an INVESTMENT account cannot record holdings until it is promoted.
Rather than change the default derivation — which would ripple through the
account-create path, the negative-balance carve-out, and existing accounts — a
genuine INVESTMENT account **opts in** through one dedicated, audited endpoint,
`enableHoldingsTrackingFn` (`src/server/accounts.ts`).

- **Controlled override, not a new default.** `getBalanceSourceForType` and the
  account-CREATE path are unchanged; the ADR-0008 taxonomy `balanceSource` is now
  a **derived default, overridable to `valuation` for INVESTMENT via explicit
  opt-in**. TRACKED_ASSET behavior is untouched.
- **Safe-seed-anchor invariant (no data loss).** A valuation-tracked account
  derives its balance from its latest valuation, not from transaction flow.
  Inside the same tenant transaction, after flipping `balanceSource` →
  `"valuation"`, the endpoint seeds a `reconciliation` anchor
  (`source="manual"`, `valuationDate = now`, so it is the latest anchor) equal to
  the account's current signed balance. `computeCanonicalBalance` then resolves
  to exactly the pre-flip balance. When the user later adds holdings, the
  holdings-derived anchor (`source="holdings"`, written afterwards) supersedes
  the seed. A real-PG test asserts the balance is preserved on flip and equals
  Σ holdings after the first holding.
- **Preconditions.** Eligibility is one pure predicate
  (`evaluateHoldingsTrackingEligibility`) shared by the endpoint and the UI CTA:
  `accountClass="ASSET"`, `accountType="INVESTMENT"`,
  `balanceSource="transaction_flow"`, `status="active"`, and **reserve must be
  clear** (`reserveBalance IS NULL`) and no person-debt link
  (`counterpartyMerchantId IS NULL`) — a reserve floor is cash-only and a
  counterparty link is RECEIVABLE/LOAN-only, both incompatible with a
  valuation-sourced account. TRACKED_ASSET / already-`valuation` accounts are
  rejected as "already valuation-tracked".
- **One-way for now.** The reverse (`valuation` → `transaction_flow`) is a later
  slice; the endpoint only promotes. Full §5A contract: RLS-scoped tenant
  transaction, endpoint idempotency (replay + unique-race replay so a retry never
  writes a second anchor or moves the balance again), and before/after `Account`
  audit rows in the same transaction. Supersedes the PER-239 account-level value
  approach folded into this ADR.

## Buy / Sell trade primitive (PER-198)

Recording a purchase or sale used to be two manual motions: a valuation-linked
transfer (ADR-0048) to move the cash, then a separate holding edit to update the
position. PER-198 collapses them into ONE atomic ledger action,
`recordTradeForFamily` (`src/server/holdings.ts`), exposed as `recordTradeFn`.
Semantically: cash **into** a valuation-tracked investment account is a BUY; cash
**out** is a SELL.

- **Atomic cash ↔ holding link.** A trade is a single valuation-linked transfer
  whose tracked-side `Valuation` is the Σ-holdings anchor, plus the position
  mutation, all in one `scopedTenantTransaction`. It reuses the ADR-0048 double-
  entry primitive `postValuationLinkedTransferLegs` (factored out of the transfer
  path so a non-transfer caller can drive it): the funding (cash-like,
  `balanceSource="transaction_flow"`) leg is a real, guarded `Transaction`; the
  investment (`balanceSource="valuation"`) side never takes an incremental
  balance write. One `Transfer` row (ADR-0048 §4 shape: one `Transaction` FK +
  `valuationId`) links them, so delete, drift detection, and reporting treat a
  trade exactly like any other valuation-linked move.

- **Dependence on the PER-196 valuation-transfer guard.** The whole design rests
  on ADR-0048 §3 / PER-196: `applyAccountBalanceDelta` refuses to mutate a
  `balanceSource="valuation"` account's stored balance. The funding leg
  decrements/credits normally; the investment account moves ONLY through the
  Σ-holdings valuation this primitive supplies. Without that guard a trade would
  double-count (a cash leg AND a valuation both hitting the tracked balance). The
  guard was verified to leave a valuation account's balance untouched while
  decrementing the funding account — this is what makes the trade a clean
  net-worth-conserving swap. See ADR-0048 (amends ADR-0042/ADR-0043 dual-leg).

- **Net-worth conservation.** The funding account moves by exactly `cashAmount`
  and the investment account's COST BASIS moves by exactly `cashAmount` (buy) /
  `costRemoved` (sell). When holdings are carried at cost (no market `lastPrice`
  — the freshly-traded case), the investment account's materialized value moves
  by the same amount, so family net worth is unchanged. A holding already
  carrying a market `lastPrice` values at market (honest cost basis, above); the
  difference is unrealized gain already recognized, not a conservation
  violation. Fractional-quantity rounding is bounded by one minor unit per
  holding (inherent to carrying cost as a rounded per-unit price). A trade never
  touches `lastPrice`.

- **Average cost.** BUY blends: `newAvgUnitCost = round_half_up((oldUnits ×
oldAvg + cashAmount) × SCALE / newUnits)` (`averageUnitCostMinor`,
  `src/lib/holdings.ts`), so `cost += cashAmount`. SELL removes cost pro-rata at
  the current average (`costRemoved = quantity × avgUnitCost`) and leaves the
  average of the remaining units unchanged — the average-cost method, not FIFO.

- **Derived realized gain.** SELL returns `realizedGain = cashAmount −
costRemoved` (signed, minor units). It is DERIVED and returned for display
  only — this slice does NOT post an income/expense row for it.

- **One-way holding close at zero.** Selling the last unit
  (`newUnits === 0`) closes the position by hard-deleting the `Holding` row
  (mirroring `deleteHoldingForFamily`); the ledger history (`Transaction`,
  `Valuation`, `Transfer`, `AuditLog`) is preserved.

- **`kind` reuse (not a new domain value).** A trade posts under the existing
  transfer kind the account pair implies (`deriveTransferKindForAccounts`;
  cash ↔ investment ⇒ `funds_movement`, or `liability_draw`/`cc_payment` when the
  funding account is a credit line). The DB trigger
  `enforce_transfer_liability_kind_invariant` derives the expected kind purely
  from account class/type, so it cannot distinguish a "trade" from a plain
  valuation-linked cash move between the same accounts — a dedicated
  `investment_buy`/`investment_sell` kind would have to teach that trigger the
  same pair means two different kinds, which is not expressible. The trade's
  identity lives in the position mutation and the `source="holdings"` valuation,
  not in a new kind.

- **Full §5A contract.** One interactive tenant transaction with the
  `app.family_id` RLS GUC; endpoint-scoped idempotency (`recordTradeFn`
  `IdempotencyRecord`, replay + unique-race replay so a retry never posts a
  second transfer or moves a balance/position again); tenant-owned validation of
  BOTH accounts and the instrument; append-only `AuditLog` rows for every entity
  written (the cash `Transaction`, the `Transfer`, the `Holding`, and the
  `Valuation`) in the same transaction.

### Guarded: trade transactions cannot be deleted until trade reversal exists

A trade posts a normal valuation-linked transfer `Transaction` that shows in the
transaction list, so the delete UI can reach it. The generic valuation-linked
delete (`softDeleteValuationLinkedTransferWithinTx`) reverses the cash leg and
tombstones the trade's `Valuation`, but the paired `Holding` is outside the
transfer graph and would NOT be reversed — the account would re-materialize from
the prior valuation while the position still shows the traded units, silently
inflating net worth (the read-only drift detector would flag it, but the data
would already be wrong). That is a UI-reachable corruption of money data, so it
is **guarded, not deferred**:

- `softDeleteValuationLinkedTransferWithinTx` throws
  `HoldingsTradeDeleteUnsupportedError` (422) **before mutating anything** when
  the linked `Valuation.source === HOLDINGS_VALUATION_SOURCE` (`"holdings"`) —
  the exact, per-transfer, definitional marker of a trade (its tracked-side move
  is a Σ-holdings anchor). The constant lives in `valuations.ts` and is shared by
  the holdings anchor writer and this guard. A per-account heuristic ("the
  account has any `Holding` rows") was rejected because it would false-block a
  legitimate plain valuation transfer to an account that also holds positions;
  the per-transfer valuation source cannot false-block — a plain valuation-linked
  transfer's own `Valuation.source` is `"transfer"`, so it still deletes
  normally.
- Full trade reversal (also undoing the `Holding` position, and eventually
  restoring sold-to-zero closes) is a later slice that pairs naturally with lots
  (PER-141-adjacent). Until then, trade transactions cannot be deleted; a real-PG
  test asserts the delete is rejected with the funding balance, investment value,
  and holding all unchanged.

### Deferred (out of scope this slice)

- **Trade EDIT and full trade REVERSAL** (see the guard above): editing a trade,
  or a delete that also undoes the position, needs its own design (PER-141-
  adjacent). This slice is create-only, mirroring ADR-0048 §4's deferral of
  valuation-linked transfer editing.
- **FIFO / tax lots** (PER-141), **realized-gain-as-income posting**,
  **market-data auto-pricing** (the next slice sets `lastPrice` from a feed
  rather than leaving positions at cost), and **transfer fees**.

## Market-data auto-pricing (PER-238)

The holdings `Instrument` now carries an OPTIONAL, nullable
`marketInstrumentId → MarketInstrument` (ADR-0050's global price series;
`onDelete: SetNull`). This is the bridge the PER-233 note deferred, and it makes
ADR-0050 §5's promise concrete: a linked position values at `quantity × latest
price/unit` from the quote store instead of at cost.

- **The link is on the holdings `Instrument`, priced onto the `Holding`.** When
  a holding's instrument is linked, `refreshHoldingPricesForFamily`
  (`src/server/holdings.ts`) reads the latest `MarketQuote`, converts it to the
  holding's price basis (`marketQuoteToHoldingPriceMinor`, pure — metal derives
  per-gram from the canonical per-troy-ounce quote; security/crypto are
  per-unit), sets `Holding.lastPriceMinor`, and re-materializes the Σ-holdings
  anchor via the SAME `recomputeAccountValueAnchorWithinTx` that every holding
  mutation uses. So value/cost/gain and the account balance stay derived from
  ONE mechanism.

- **Anchor-safe — a price is an OBSERVATION (ADR-0043/0050 §2).** The refresh
  only ever moves a holding's `lastPriceMinor` and the derived `source="holdings"`
  valuation of the SAME investment account. It never touches a cash balance, a
  user `opening`/`reconciliation`/`manual` anchor, or a non-holdings account, and
  a refresh with unchanged quotes is a NO-OP (no duplicate anchor, no balance
  move). Same-currency (`MarketInstrument.quoteCurrency` == account currency) is
  required this slice; cross-currency via FX is deferred.

- **Contract.** Setting the link (`upsertHoldingFn`) and the refresh
  (`refreshHoldingPricesFn`) both run the full §5A ledger-mutation contract
  (RLS-scoped tenant tx, idempotency, tenant validation, append-only audit).
  Real-Postgres tests cover link, refresh, anchor-safety (cash + non-holdings
  anchors untouched), idempotent re-refresh, same-currency rejection, unlinked
  holdings, and tenant isolation
  (`tests/integration/holding-market-prices.integration.ts`).

- **Deferred:** the scheduled refresh worker (PER-237 — this slice exposes an
  explicit "Refresh prices" action only), real scraper adapters (PER-235
  gold-local; reksadana NAV), and cross-currency quote → holding.
