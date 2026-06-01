# Account Taxonomy

Permoney accounts use a three-layer taxonomy:

1. `accountClass`: the normal-balance class that controls sign semantics.
2. `accountType`: the stable ledger capability family.
3. `accountSubtype`: the product family label. This is intentionally flexible
   so new account products can be added without rewriting ledger semantics.

This document is the public schema/API contract for account classification. It
extends the core domain boundary in
[`ADR-0008`](./adr/0008-core-domain-model-and-ledger-boundaries.md). Liability
payment, borrowing, interest, and fee semantics live in
[`docs/liability-semantics.md`](./liability-semantics.md).

## Schema Fields

| Field               | Required | Purpose                                                                 |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `accountClass`      | Yes      | Normal-balance class: `ASSET` or `LIABILITY`.                           |
| `accountType`       | Yes      | Ledger capability family such as `DEPOSITORY`, `CREDIT`, or `LOAN`.     |
| `accountSubtype`    | Yes      | Product family label such as `checking`, `bnpl`, `mortgage`, or `gold`. |
| `institutionName`   | No       | Human-readable bank, lender, broker, provider, or custodian name.       |
| `externalProvider`  | No       | Integration provider key, for example a future bank API connector.      |
| `externalAccountId` | No       | Provider-side account identifier.                                       |
| `mask`              | No       | Non-sensitive account mask, such as the final 4 digits.                 |
| `isImportable`      | Yes      | Whether this account may receive provider/import feed data.             |
| `creditLimit`       | No       | Product limit in minor units for cards, BNPL, or credit lines.          |
| `statementDay`      | No       | Statement cycle day, 1 through 31.                                      |
| `dueDay`            | No       | Payment due day, 1 through 31.                                          |
| `interestRateBps`   | No       | Interest rate in basis points.                                          |
| `archivedAt`        | No       | Archive timestamp. If present, `status` must be `closed`.               |

Provider and capability metadata never changes ledger semantics by itself. It
helps imports, reminders, reconciliation, and UI workflows decide what the
account can do.

## Account Classes

| `accountClass` | Normal balance | Balance sign rule | Use for                               |
| -------------- | -------------- | ----------------- | ------------------------------------- |
| `ASSET`        | Debit          | `balance >= 0`    | Cash, deposits, wallets, investments. |
| `LIABILITY`    | Credit         | `balance <= 0`    | Credit cards, BNPL, loans, mortgages. |

`EQUITY` and `TRACKING` are intentionally not in the M2.5 schema. Tracked real
assets still use `ASSET` with `accountType = TRACKED_ASSET`. Future equity or
off-ledger tracking classes require a separate ADR because they would change
normal-balance and reporting semantics.

## Account Types

| `accountType`   | `accountClass` | Default subtype | Ledger meaning                                     |
| --------------- | -------------- | --------------- | -------------------------------------------------- |
| `CASH`          | `ASSET`        | `cash`          | Physical cash or petty-cash wallet.                |
| `DEPOSITORY`    | `ASSET`        | `checking`      | Bank deposit accounts: checking, savings, payroll. |
| `E_WALLET`      | `ASSET`        | `cash`          | Stored-value wallets and payment apps.             |
| `CREDIT`        | `LIABILITY`    | `credit_card`   | Revolving credit products and credit cards.        |
| `LOAN`          | `LIABILITY`    | `personal_loan` | Installment debt: BNPL, KPR, bank loans, pinjol.   |
| `INVESTMENT`    | `ASSET`        | `brokerage`     | Brokerage, retirement, crypto custody accounts.    |
| `RECEIVABLE`    | `ASSET`        | `receivable`    | Money owed to the family by another party.         |
| `TRACKED_ASSET` | `ASSET`        | `generic_asset` | Gold, silver, vehicles, real estate, collectibles. |

New products should usually be modeled as a new `accountSubtype` or capability
field under one of these `accountType` values. Add a new `accountType` only when
the product needs different ledger capabilities or normal-balance rules.

## Subtypes

Known subtypes in code are:

- `cash`
- `checking`
- `savings`
- `payroll`
- `credit_card`
- `bnpl`
- `mortgage`
- `personal_loan`
- `payday_loan`
- `brokerage`
- `retirement`
- `crypto_wallet`
- `receivable`
- `gold`
- `silver`
- `vehicle`
- `real_estate`
- `generic_asset`

The database enforces subtype shape as lowercase snake case. It does not enforce
a closed subtype enum. This is deliberate: adding `student_loan`, `term_deposit`,
or `kpr_subsidized` should not require a ledger migration as long as the product
fits an existing `accountType`.

## Normal-Balance Examples

### Checking account

```text
accountClass    ASSET
accountType     DEPOSITORY
accountSubtype  checking
balance         >= 0
```

Expenses decrease the balance. Income increases it.

### Credit card

```text
accountClass    LIABILITY
accountType     CREDIT
accountSubtype  credit_card
balance         <= 0
```

Card spending makes the balance more negative. Payments toward the card move it
toward zero. Transfers into a `CREDIT` account are classified as `cc_payment`.

### BNPL or mortgage

```text
accountClass    LIABILITY
accountType     LOAN
accountSubtype  bnpl | mortgage
balance         <= 0
```

Payments toward the loan move the balance toward zero. Transfers into a `LOAN`
account are classified as `loan_payment`. New borrowing from a loan into an
asset account is classified as `liability_draw`. Interest and fees are separate
expense rows with `liability_interest` or `liability_fee` and `toAccountId`
pointing at the loan.

### Gold, vehicle, or real estate tracking

```text
accountClass    ASSET
accountType     TRACKED_ASSET
accountSubtype  gold | vehicle | real_estate
balance         >= 0
```

The account balance represents the tracked ledger value in minor units. Market
price movement belongs in future valuation snapshots unless a realized
transaction occurs.

## Implementation Contract

- Server and client code should use `accountClass`, `accountType`, and
  `accountSubtype`. Do not add new writes to the old `type` name.
- `src/lib/accounts.ts` is the TypeScript source for taxonomy constants,
  default subtypes, class/type mapping, and normal-balance helpers.
- The database is the backstop: class domain, type domain, class/type
  consistency, normal-balance sign, subtype shape, due-day ranges, credit-limit
  sign, and archive/status consistency are enforced by checks.
- Liability semantics are part of the ledger contract. Credit-card payments and
  loan principal payments are transfer kinds, not ordinary spending. Interest
  and fees are expense kinds linked to the liability account.
- Import providers and AI enrichment may suggest institution metadata,
  provider IDs, masks, limits, rates, and subtype refinements. The final account
  write still uses the canonical account API and database constraints.
