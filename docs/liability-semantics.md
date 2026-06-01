# Liability Semantics

Permoney stores liabilities as normal credit-balance accounts:

```text
accountClass = LIABILITY
balance <= 0
```

The negative stored balance is the debt principal outstanding. Product metadata
such as `creditLimit`, `statementDay`, `dueDay`, and `interestRateBps` helps
reminders, import matching, and UI display, but it does not change ledger
semantics by itself.

This document extends the account taxonomy contract in
[`docs/account-taxonomy.md`](./account-taxonomy.md).

## Transaction Kinds

| `Transaction.kind`   | Type           | Meaning                                      | Ordinary spending? |
| -------------------- | -------------- | -------------------------------------------- | ------------------ |
| `standard`           | expense/income | Normal purchase, refund, income, adjustment. | Expense only.      |
| `funds_movement`     | transfer       | Asset-to-asset transfer.                     | No.                |
| `cc_payment`         | transfer       | Principal payment into a `CREDIT` account.   | No.                |
| `loan_payment`       | transfer       | Principal payment into a `LOAN` account.     | No.                |
| `liability_draw`     | transfer       | New borrowing from a liability into asset.   | No.                |
| `liability_interest` | expense        | Interest cost linked to a liability account. | Finance cost.      |
| `liability_fee`      | expense        | Fee cost linked to a liability account.      | Finance cost.      |

`src/lib/liability-semantics.ts` is the TypeScript source for this vocabulary,
transfer-kind derivation, and ordinary-spending classification.

## Payments vs Borrowing

### Credit-Card Spending

A card purchase is an expense posted on the credit account.

```text
accountId = credit card
type      = expense
kind      = standard
amount    = -50_000
```

The credit account balance becomes more negative. The transaction remains
ordinary spending because the family consumed goods or services.

### Credit-Card Payment

A card payment is a transfer from an asset account into a `CREDIT` account.

```text
outflow account = checking
inflow account  = credit card
type            = transfer
kind            = cc_payment
```

The checking account decreases and the credit balance moves toward zero. This
is principal repayment, not another expense, so reporting must not count it as
ordinary spending.

### Loan Draw Or Cash Advance

New borrowing is a transfer out of a liability account into an asset account.

```text
outflow account = loan or credit line
inflow account  = checking
type            = transfer
kind            = liability_draw
```

The liability balance becomes more negative and the asset balance increases.
This is not income; it is borrowed principal that must later be repaid.

## Principal, Interest, And Fees

A complete loan payment can contain three different financial facts:

1. Principal repayment: transfer from cash to the loan account with
   `kind = loan_payment`.
2. Interest cost: expense from the payment account with
   `kind = liability_interest` and `toAccountId` pointing at the loan.
3. Fee cost: expense from the payment account with `kind = liability_fee` and
   `toAccountId` pointing at the loan.

Only the principal transfer changes the liability principal balance. Interest
and fees are real costs, but they do not reduce principal; they are linked to
the liability through `toAccountId` for reporting and reconciliation.

This supports BNPL, KPR/mortgage, personal loans, payday loans, and bank loans
without special tables per product. Product shape lives in
`Account.accountSubtype` and metadata; realized money movement remains in
canonical `Transaction` rows.

## UI Display Sign

Database sign remains authoritative:

- liability balance is stored as zero or negative;
- payments move the stored balance toward zero;
- borrowing and card spending move the stored balance more negative.

UI may display debt as a positive magnitude such as "Rp 300,000 owed", but it
must not write positive liability balances to the database.

## Database Backstops

The database enforces:

- `Transaction.kind` domain values;
- allowed `type`/`kind` combinations;
- liability interest/fee rows must point at a liability account;
- transfer legs must share the same derived transfer kind;
- transfer direction determines `funds_movement`, `cc_payment`,
  `loan_payment`, or `liability_draw`.

Application code still validates first for clearer errors. Database constraints
remain the final guard for raw SQL, future import workers, AI enrichment, and
bank-sync paths.
