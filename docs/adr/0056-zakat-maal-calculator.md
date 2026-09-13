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
- A "strong debt" (*dayn qawī* — a loan or trade-goods receivable owed by a
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
   need) — Yusuf al-Qaradawi's *Fiqh az-Zakat*, the most widely cited
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
4. **Married couples' wealth.** Individually owned wealth is calculated
   and paid separately by default (Islam's default is separation of
   marital property — there is no fiqh concept of automatic "joint
   property"). Combining a couple's money and paying Zakat on the
   commingled total is explicitly permitted **with mutual consent**
   (the rate doesn't change whether combined or separate). A spouse may
   pay on behalf of the other as their *wakīl* (representative) with
   consent; the underlying obligation still belongs to the wealth's true
   owner.

### A real architectural gap this surfaces

Permoney's `Account` model is scoped only to `familyId` — there is no
per-member ownership field distinguishing which `FamilyMember` owns a given
account (checked directly against `prisma/schema.prisma`; `FamilyMember`
exists per ADR-0036, but `Account` carries no `ownerId`/`familyMemberId`).
Building strictly-correct **per-individual** Zakat (husband and wife
calculated separately from the same family's accounts) needs that
ownership concept, and the creator's own spouse cannot even log in to this
family yet. Per the research above, computing Zakat on the family's total
pooled wealth (with mutual consent) is an explicitly valid fiqh position,
not a shortcut against correctness — so Slice 1 computes at the family
level and documents per-individual attribution as a named future slice,
rather than blocking on a schema change unrelated to the religious
calculation itself.

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
Islamic scholarly practice (being transparent about *khilaf*, differences
of opinion), not just a UX nicety.

### Nisab value

`nisab_value = nisab_grams(nisabBasis) × current_market_price_per_gram`.
Gold price is already tracked (existing market-data gold source/worker).
Silver price is **not** currently tracked — adding a silver price source
is required before the silver option can be offered; ship gold-only in the
very first tracer bullet if silver pricing isn't ready in time, rather
than block the whole feature, and enable silver the moment that source
lands.

### Zakatable wealth (Slice 1 scope)

`net_zakatable_wealth = zakatable_assets − deductible_near_term_debt`

- **Zakatable assets (Slice 1)**: cash-like ASSET accounts (`CASH`,
  `DEPOSITORY`, `E_WALLET` — reuses `isLiquidCashAccountType` from
  `src/lib/account-reserve.ts`, PR #341) **plus** `RECEIVABLE`-type
  accounts explicitly tracked as collectible (dayn qawī) in Permoney's
  existing debt/counterparty model (ADR-0049). Investment holdings
  (mutual funds, gold holdings) are explicitly **out of scope for Slice
  1** — jewelry/personal-use-asset zakat carries its own separate madhab
  divergence (Hanafi taxes personal jewelry; Shafi'i/Hanbali/Maliki
  generally don't) that deserves its own dedicated design pass, not a
  rushed inclusion here.
- **Deductible debt (Slice 1)**: `CREDIT` accounts' full outstanding
  balance (a credit card statement is due within days/weeks — near-term by
  definition) **plus**, for `LOAN` accounts, only the next
  scheduled/imminently-due installment amount — never the full remaining
  principal of a multi-year loan. This requires reading the loan's
  repayment cadence (reuses the same recurring-detection heuristic already
  shipped for `account-recurring.ts`, applied to `loan_payment`-kind
  transfers, to estimate the next due amount when no explicit schedule
  exists).

### Hawl eligibility — verified from real history, not self-reported

This is the feature's actual differentiator. Given `hawlStartDate` and
`haulRule`, reconstruct the family's net zakatable wealth on every day
from `hawlStartDate` to today using the SAME balance-reconstruction
primitive the net-worth report and `buildBalanceSeries` already use (no
new historical-data mechanism — this is a read over data Permoney already
durably keeps).

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

### Married couples / multiple family members

Slice 1 computes at the **family (pooled)** level, labeled explicitly as
such ("This treats your household's tracked wealth as one pool, which is
permitted with mutual consent — Zakat is normally an individual
obligation"). Per-individual attribution (separate Zakat per
`FamilyMember`, once a spouse or other member can log in and own specific
accounts) is an explicit, named future slice, gated on adding real
per-account ownership to the `Account` model — a genuine schema change,
not a quick toggle, and deliberately not conflated with this ADR's scope.

### Out of scope, deliberately, for Slice 1

- Investment/gold-holdings assets and jewelry-specific rulings (own
  future ADR amendment).
- Zakat Fitrah (a completely different, non-wealth-based obligation) —
  not the same feature, not addressed here.
- Automatic Zakat payment/disbursement — this is a **calculator**, not a
  payment product. It tells the user what is owed and why; paying it is
  the user's own action outside Permoney.
- Per-individual (non-pooled) calculation — needs the `Account` ownership
  schema change noted above.
- Non-Hijri-calendar convenience shortcuts (e.g. approximating with a
  fixed 355-day Gregorian offset) — compute the real Hijri calendar
  conversion; a personal-finance app that gets Islamic dates
  approximately right is worse than one that is silent about them.

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
