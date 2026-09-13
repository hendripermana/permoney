# ADR-0056 — Zakat Maal Calculator

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-09-13     |
| **Accepted**      | 2026-09-13     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |
| **Amends**        | —              |

## Context

Permoney is global, but a large share of its real users are Muslim, and
Zakat Maal (wealth tax) is a personal religious obligation with real
financial stakes — getting it wrong is not a UX bug, it is a mistake in
someone's worship. No mainstream personal-finance app (Indonesian or
global) computes Zakat from a user's REAL transaction history; every
existing calculator the research below found is a manual point-in-time
form the user fills in by hand, trusting their own memory of whether their
wealth stayed above the threshold all year. Permoney already reconstructs
historical account balances (`buildBalanceSeries`, the net-worth reporting
engine) — that is a genuine, unique capability to verify Zakat eligibility
from evidence instead of asking the user to guess.

This ADR intentionally does **not** silently pick one school of Islamic
jurisprudence (madhab) and hard-code its ruling. The research below found
real, longstanding, legitimate scholarly disagreement on several
load-bearing calculation questions. Presenting one answer as _the_ answer
would be a worse mistake than building nothing — Permoney is global and
users follow different schools (Hanafi, Maliki, Shafi'i, Hanbali) and
different national/institutional standards. The product answer is
**transparency + configurability**, not a single opinion.

### Research summary (sources at the end of this document)

**Points of unanimous agreement across all four Sunni madhabs (safe to
hard-code):**

- Zakat rate on monetary wealth: **2.5%** (1/40). No dispute anywhere.
- Gold's own nisab: **20 mithqal = 87.48 grams**. All four madhabs agree
  without exception. (Note: many popular Indonesian sources round this to
  "85 grams" — that is a rounding simplification, not a competing
  scholarly position; 87.48g, per AAOIFI Shari'a Standard No. 35, is the
  precise figure this ADR uses.)
- A "strong debt" (_dayn qawī_ — a loan or trade-goods receivable owed by a
  solvent, acknowledging debtor) is zakatable annually to the person owed
  the money. A "weak debt" (uncertain/disputed, or owed for services) is
  only zakatable in the year it is actually collected.
- The Hawl (holding period) is one **Hijri (lunar) year**, ~354–355 days —
  not a Gregorian year.
- Zakat is an **individual, personal** obligation — "neither husband nor
  wife pays the Zakah due on the other" by default.

**Points of real, documented disagreement (must be configurable, not
hard-coded):**

1. **Which metal's nisab values a modern cash/mixed-asset portfolio.**
   Maliki/Shafi'i/Hanbali benchmark cash against **gold's** nisab value.
   Hanafi benchmarks mixed wealth (cash + gold + silver + trade goods)
   against the much lower **silver** nisab (612.36g, AAOIFI), which is
   more precautionary (more people become obligated, more reaches those in
   need) — Yusuf al-Qaradawi's _Fiqh az-Zakat_, the most widely cited
   cross-madhab reference work, favors silver for this exact reason.
2. **Whether the Hawl requires continuous nisab.** Hanafi only requires
   wealth to be at/above nisab at the **start and end** of the Hawl (a dip
   in between does not break it). Maliki/Shafi'i/Hanbali require nisab to
   be maintained **continuously** — any drop below nisab during the year
   resets the Hawl clock to the recovery date.
3. **How much debt is deductible.** Majority position: only debt **due
   within the near term** (this cycle/imminently) is deducted — a credit
   card's outstanding statement balance, yes; the full remaining principal
   of a 3-year personal loan, no (only the portion currently due). AAOIFI
   itself documents multiple valid scholarly positions here.
4. **How much debt is deductible, continued — and a correction this ADR
   originally got wrong.** See "Married couples' wealth" below: an earlier
   draft of this ADR proposed computing Zakat on a family's POOLED total
   wealth by default, reasoning that combining spouses' money "with mutual
   consent" is a documented valid position. That reasoning is true on its
   own, but applying it as the DEFAULT is a real fiqh error, not a
   simplification — see the worked scenarios below. It has been corrected.

### Why pooling by default is a real fiqh error, not a simplification

Corrected after review: across all four madhabs, marital wealth is
**Dhimmah Māliyyah Mustaqillah** — husband and wife hold 100% independent
legal ownership of their own property, full stop. Zakat is _farḍ ʿayn_
(an individual, non-transferable obligation), never a household-level
one. Pooling before checking nisab produces two concrete failure modes,
not just imprecision:

- **False positive (neither owes, app says both do).** Husband holds
  wealth equal to 50g of gold, wife holds 50g. Nisab is 87.48g. Neither
  individually reaches nisab, so the correct answer is **zero** owed by
  either. A pooled total of 100g crosses nisab and would wrongly declare
  the household obligated — manufacturing a religious obligation that
  does not exist.
- **Misattributed obligation (right total, wrong payer, wrong amount).**
  Husband holds 100g (above nisab, owes 2.5g), wife holds 20g (below
  nisab, owes nothing). Pooled to 120g, a family-level calculator computes
  3g owed — silently taxing the wife's wealth, which she has no
  obligation on at all, and getting the total itself wrong in the
  process.

Neither of these is an edge case for Permoney specifically: the creator's
own real data already has exactly this shape today — a bank account that
is legally and beneficially the spouse's own money (recorded under the
only login that currently exists), and an investment account
("Dana Darurat") both spouses contribute to jointly every month. A
pooled-by-default calculator would already be wrong for this account
today.

### The real architectural gap, and the design that avoids conflating two different problems

Permoney's `Account` model is scoped only to `familyId` — there is no
concept of which individual a given account's wealth economically belongs
to. Checked directly: `FamilyMember.userId` is required (not nullable),
and `addMemberForFamily` explicitly requires "the target user must already
exist" — **there is no invite-a-person-who-hasn't-signed-up-yet flow
built today** (`status: "invited"` is a reserved, unbuilt value). The
creator's spouse cannot log in to Permoney yet.

Building this correctly means NOT conflating two genuinely separate
problems:

1. **Who does this account's zakatable wealth economically belong to?**
   — a lightweight domain fact, true today regardless of who is logged
   in, needed NOW to compute correctly.
2. **Who can authenticate and see/manage it?** — the multi-user
   invite/login system, a real, larger, unrelated feature, correctly
   deferred (see ADR-0036 for the membership model it would extend).

Solving (1) without waiting on (2): a new, minimal, family-scoped
`ZakatPayer` record — **not** a `FamilyMember`, **not** a `User`, no auth
implications at all:

```prisma
model ZakatPayer {
  id          String  @id @default(cuid())
  familyId    String
  displayName String  // "Saya", "Istri", free text the household chooses
  // Set later, non-breaking, when a real login exists for this person —
  // the eventual "claim your tagged accounts" flow just fills this in.
  linkedUserId String? @unique
  family Family @relation(fields: [familyId], references: [id], onDelete: Cascade)
}
```

`Account` gains three nullable, additive columns:

- `zakatPayerId` — who this account's wealth is attributed to. `NULL`
  (unset) is a valid state, not an error — see the default-behavior rule
  below.
- `zakatJointPayerId` — if the account is jointly owned, the second payer.
- `zakatJointSharePercent` — the **joint payer's** share (1–99; the
  primary `zakatPayerId` holder keeps the remainder). Defaults to 50,
  matching the fiqh default rule below — overridable per account for a
  different agreed ratio.

**Default-behavior rule (keeps the 95% single-person household
unaffected):** a family with zero or one `ZakatPayer` row needs no
tagging at all — every account is implicitly 100% that one payer's
wealth, exactly like today. Tagging only becomes necessary, and the UI
only prompts for it, once a **second** `ZakatPayer` is created — a
one-time "these accounts need an owner for Zakat purposes" reconciliation
screen, not a burden on everyone.

**Joint-account default ratio**: per the fiqh rule the creator's own
research surfaced — _"aset dalam rekening bersama dibagi sesuai porsi
akad kepemilikan (default 50:50 kecuali ada kesepakatan rasio lain)"_ —
`zakatJointSharePercent` defaults to 50 and is editable per account,
never silently assumed to be something else.

## Decision

**Ship a Zakat Maal calculator as a new, dedicated slice family (own
routes, own pure lib module) that (a) verifies Hawl eligibility from real
historical balance data instead of asking the user to self-report it, and
(b) never hides which scholarly position it is applying.**

### Methodology settings (user-configurable, not hard-coded)

A per-family `ZakatSettings` record (new, minimal) capturing:

- `nisabBasis`: `"gold"` (default) | `"silver"` — which metal's nisab
  values the household's mixed wealth. Silver surfaced as the explicitly
  labeled "more precautionary — includes more people, recommended by
  Qaradawi's Fiqh az-Zakat" option, not buried as an advanced setting.
- `haulRule`: `"hanafi_start_end"` | `"jumhur_continuous"` (default —
  Maliki/Shafi'i/Hanbali, the majority position and Indonesia's own
  mainstream Shafi'i-majority context) — governs how eligibility is
  verified (see below).
- `hawlStartDate`: when the household's Hawl clock began. Either
  user-supplied, or Permoney can suggest the date net worth first
  crossed nisab (from existing history) as a starting point to confirm.

Every settings choice is displayed alongside the final number — "Using:
gold nisab (87.48g), majority (continuous) Hawl rule" — never a bare
Rupiah figure with no visible assumptions. This is itself the correct
Islamic scholarly practice (being transparent about _khilaf_, differences
of opinion), not just a UX nicety.

### Nisab value

`nisab_value = nisab_grams(nisabBasis) × current_market_price_per_gram`.
Gold price is already tracked (existing market-data gold source/worker).
Silver price is **not** currently tracked — adding a silver price source
is required before the silver option can be offered; ship gold-only in the
very first tracer bullet if silver pricing isn't ready in time, rather
than block the whole feature, and enable silver the moment that source
lands.

### Zakatable wealth is computed PER ZAKATPAYER, never pooled

`net_zakatable_wealth(payer) = zakatable_assets(payer) − deductible_near_term_debt(payer)`

For each `ZakatPayer` in the family (defaulting to exactly one, implicitly,
when the household has never created a second one):

`zakatable_assets(payer)` = the sum, over every account, of:

- 100% of the account's zakatable value, when `account.zakatPayerId ==
payer.id` and `zakatJointPayerId` is null, **plus**
- `(100 − zakatJointSharePercent)%` when `account.zakatPayerId ==
payer.id` and it IS jointly held, **plus**
- `zakatJointSharePercent%` when `account.zakatJointPayerId == payer.id`
  (i.e. this payer is the joint co-owner, not the primary).

An account with no `zakatPayerId` set at all is **not silently split or
guessed** — it is excluded from every payer's total and the result screen
lists it under "Needs an owner before it can be included," alongside a
link to tag it. Silently defaulting an untagged account to someone is
exactly the kind of guess this feature exists to eliminate.

**Asset/debt classes counted per payer (Slice 1 scope), otherwise
unchanged from the original design**:

- **Zakatable assets**: cash-like ASSET accounts (`CASH`, `DEPOSITORY`,
  `E_WALLET` — reuses `isLiquidCashAccountType` from
  `src/lib/account-reserve.ts`, PR #341) **plus** `RECEIVABLE`-type
  accounts explicitly tracked as collectible (dayn qawī) in Permoney's
  existing debt/counterparty model (ADR-0049). Investment holdings
  (mutual funds, gold holdings) are explicitly **out of scope for Slice
  1** — jewelry/personal-use-asset zakat carries its own separate madhab
  divergence (Hanafi taxes personal jewelry; Shafi'i/Hanbali/Maliki
  generally don't, and a "worn regularly within customary limits" test
  either way) that deserves its own dedicated design pass, not a rushed
  inclusion here. When investment assets DO get added (Slice 2), the same
  per-`ZakatPayer` attribution fields apply — this is not a one-off,
  it's the general ownership primitive for every future zakatable asset
  class.
- **Deductible debt**: `CREDIT` accounts' full outstanding balance (a
  credit card statement is due within days/weeks — near-term by
  definition) **plus**, for `LOAN` accounts, only the next
  scheduled/imminently-due installment amount — never the full remaining
  principal of a multi-year loan. Debt is attributed to a payer the same
  way as assets (a liability account can itself be tagged
  `zakatPayerId`/joint, e.g. a credit card genuinely opened and owed by
  one spouse only). This requires reading the loan's repayment cadence
  (reuses the same recurring-detection heuristic already shipped for
  `account-recurring.ts`, applied to `loan_payment`-kind transfers, to
  estimate the next due amount when no explicit schedule exists).

### Hawl eligibility — verified from real history, per payer, not self-reported

This is the feature's actual differentiator. Given `hawlStartDate` and
`haulRule`, reconstruct **each payer's own** net zakatable wealth (per
the attribution rule above) on every day from `hawlStartDate` to today,
using the SAME balance-reconstruction primitive the net-worth report and
`buildBalanceSeries` already use (no new historical-data mechanism — this
is a read over data Permoney already durably keeps). A joint account's
history is reconstructed once and split by `zakatJointSharePercent` at
every historical point, not just at today's snapshot — the whole
day-by-day series must reflect the ownership split, or the Hawl-continuity
check would silently reintroduce Scenario A/B through the back door.

- `hanafi_start_end`: check net zakatable wealth ≥ nisab on
  `hawlStartDate` AND on the Hawl-anniversary date only. Dips in between
  are ignored, matching the ruling.
- `jumhur_continuous` (default): check net zakatable wealth stayed ≥
  nisab on **every** reconstructed day in the window. The first date it
  dipped below nisab (if any) is surfaced explicitly and becomes the new
  candidate Hawl start — "Your Hawl reset on {date} because your balance
  dipped below nisab that day; a new year starts counting from there,"
  not a silent wrong number.

The final calculation is a **snapshot at the Hawl-anniversary date**
(current or reconstructed historical balance on that date) × 2.5% — per
the majority scholarly practice (`Hawl Anniversary Method`), never an
average or a minimum-balance calculation. Averaging or using the lowest
point during the year is a common mistake this ADR deliberately avoids.

### Married couples / multiple ZakatPayers — the result screen

Each `ZakatPayer` gets their **own, fully independent** result: own
nisab check, own Hawl status, own owed amount — including the honest
"Rp0, not obligated" outcome when their individually-attributed wealth
never reached nisab, even if a sibling payer in the same household owes a
large amount. A secondary "household total" line is allowed ONLY as a
plain sum of the already-independently-correct per-payer results (never
a re-pooled recalculation) — clearly labeled as an informational total,
not a joint obligation. A note on _wakalah_: the screen may state that
one payer can pay another's amount on their behalf with their consent —
this is a payment-workflow fact about who transfers the money, not a
change to whose wealth the calculation is based on.

### Out of scope, deliberately, for Slice 1

- Investment/gold-holdings assets and jewelry-specific rulings (own
  future ADR amendment) — the per-`ZakatPayer` attribution primitive
  built here already applies to whatever gets added.
- Zakat Fitrah (a completely different, non-wealth-based obligation) —
  not the same feature, not addressed here.
- Automatic Zakat payment/disbursement — this is a **calculator**, not a
  payment product. It tells the user what is owed and why; paying it is
  the user's own action outside Permoney.
- The real multi-user invite/login/"claim my tagged accounts" flow —
  `ZakatPayer.linkedUserId` is deliberately left as a forward-compatible
  hook for it, not built here. Tagging ownership today is done by
  whoever is currently logged in, on behalf of the household.
- Non-Hijri-calendar convenience shortcuts (e.g. approximating with a
  fixed 355-day Gregorian offset) — compute the real Hijri calendar
  conversion; a personal-finance app that gets Islamic dates
  approximately right is worse than one that is silent about them.

### Future direction: auto-detected joint-share from real transaction authorship

`Transaction.userId` already records who personally entered every
transaction (checked directly against `prisma/schema.prisma`). Today
every transaction in a jointly-used account carries the SAME `userId`
(whoever is currently the only person logged in), so `userId` carries no
attribution signal yet and `zakatJointSharePercent` must stay a manual,
editable number (default 50, per the fiqh default). Once the deferred
multi-user login flow ships and a second real person is entering their
own transactions into a shared account under their own login, their
actual contribution becomes directly measurable: sum each `userId`'s net
inflow into the account over the Hawl window and derive the joint share
from real behavior instead of a static guess. This is a natural, additive
upgrade to the SAME `zakatJointSharePercent` field (auto-computed value
with the existing manual entry becoming an explicit override, never
silently discarded) — not a new concept, not a breaking change, and not
built in this slice.

## Sources

- [SS (35) Zakah — AAOIFI official standard](https://aaoifi.com/ss-35-zakah/?lang=en)
- [The AAOIFI Shari'ah Standard on Gold](https://www.gold.org/download/file/18645/The-Shariah-Standard-on-Gold-English.pdf)
- [Zakat on Gold and Silver — IslamQA (Hanafi)](https://islamqa.org/hanafi/qibla-hanafi/42568/zakat-on-gold-and-silver-5/)
- [Zakat Eligibility in the Hanafi Madhhab: Gold or Silver Nisab? — Darul Ma'arif](https://darulmaarif.com/zakat-eligibility-in-the-hanafi-madhhab-gold-or-silver-nisab/)
- [Zakat on Debt and Liabilities — HalalWallet](https://www.halalwallet.us/blog/zakat-on-debt-and-liabilities-2026-what-to-deduct)
- [Liabilities to Deduct in Zakaat — IslamQA (Hanafi)](https://islamqa.org/hanafi/askmufti/44541/liabilities-to-deduct-in-zakaat/)
- [Zakat on Debts Owed to You: Collection Rules — Unessa Foundation](https://unessafoundation.org/zakat-on-debts-owed-to-you-collection-rules/)
- [Hanafi Fiqh: Zakat and Debts](https://hanafilegalrulings.blogspot.com/2017/02/zakat-and-loans.html)
- [FAQ #159: For a husband and wife, how do we pay Zakat? — Islamic Finance Singapore](https://islamicfinance.sg/docs/zakat/faq159/)
- [The Law of Zakat on Joint Property According to Islamic Law — Dompet Dhuafa](https://www.dompetdhuafa.org/en/the-law-of-zakat-on-joint-property-according-to-islamic-law/)
- [How would a couple calculate Zakat on a joint account? — IslamQA (Hanafi)](https://islamqa.org/hanafi/darulfiqh/156574/how-would-a-couple-calculate-zakat-on-a-joint-account/)
- [Neither husband nor wife has to pay Zakah due on the other — IslamWeb](https://www.islamweb.net/en/fatwa/102345/neither-husband-nor-wife-has-to-pay-zakah-due-on-the-other)
- [Is it acceptable to combine spouses' money and pay zakaah together? — IslamQA.info](https://islamqa.info/en/answers/66919/is-it-acceptable-for-him-to-put-his-money-with-his-wifes-money-and-pay-zakaah-together)
- [Zakat Calculator 2026: Precise Wealth Calibration — DeenAtlas](https://deenatlas.com/calculators/zakat)

**Disclaimer this ADR itself is bound by**: this document is a good-faith
engineering synthesis of publicly available Islamic finance research, not
a fatwa. The product must say so too — every Zakat result screen should
carry a visible note that users with specific or unusual situations should
confirm with a qualified local scholar or their national Zakat authority
(e.g. BAZNAS in Indonesia), and that changing the methodology settings is
how they align the calculator with their own school of thought.
