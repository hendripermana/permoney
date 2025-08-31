# PayLater Multi-Currency Enhancements

This document summarizes additive changes enabling multi-currency PayLater accounts, IDR conversion, and schedule metadata.

## Data Model

- `pay_laters` (new columns): `currency_code`, `exchange_rate_to_idr`, `approved_date`, `expiry_date`, `max_tenor`, `status`, `notes`, `auto_update_rate`, `contract_url`, `grace_days`, `is_compound`, `early_settlement_allowed`, `early_settlement_fee`, `updated_by`.
- `exchange_rate_histories` (new): daily rate rows (`currency_code`, `rate_to_idr`, `effective_date`).
- `pay_later_installments` (extended): `applied_rate`, `total_cost` (TCO stored on first row of each schedule).

All changes are additive and do not modify existing tables or flows.

## ExchangeRateService

`ExchangeRateService.get_latest_rate(code, on: Date.current)` returns latest rate to IDR, 1.0 for IDR. PayLater flows use this for conversion; the rest of the app remains unchanged.

## BNPL Flow Updates

- `PayLater::RecordExpense` now:
  - Converts original expense currency to account currency via IDR rates (uses override if provided on params).
  - Chooses `applied_rate` via provider rates or the account’s `interest_rate_table` (with category overrides) if `auto_update_rate=false`.
  - Supports `is_compound` monthly interest and `free_interest_months`.
  - Stores `applied_rate` on each installment and schedule `total_cost` on the first row.
  - Audits original/converted amounts via `DataEnrichment`.

- `PayLater::PayInstallment` now:
  - Applies grace days before late-fee tiers.
  - Supports early payoff (`early_payoff: true`), cancelling remaining installments and adjusting available credit.

## API

New endpoints (under `/api/v1/debt/paylater`): create, expense, installment/pay. See controller `app/controllers/api/v1/debt/pay_later_controller.rb` for param lists including new fields.

## UI Notes

- PayLater account form includes currency, rate overrides, max tenor, status, grace days, compound interest, early-settlement flags, and notes. Transaction form mock-ups should display tenor, applied rate, and estimated TCO.

