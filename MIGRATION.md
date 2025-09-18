Borrowed Loans Migration Notes

Summary
- Additive changes only: new nullable metadata columns on `loans`, a new `loan_installments` table, and a feature flag initializer.

What Changed
- loans: added columns for principal_amount, start_date, tenor_months, payment_frequency, schedule_method, rate_or_profit, installment_amount, early_repayment_policy, late_fee_rule (jsonb), collateral_desc, initial_balance_override, initial_balance_date, linked_contact_id (uuid, no FK), lender_name, institution_name, institution_type, product_type, notes, extra (jsonb).
- loan_installments: planned installment rows linked to `accounts` (Loan accounts). Columns include installment_no, due_date, principal_amount, interest_amount, total_amount, status, posted_on, transfer_id.
- Feature flag: `config/initializers/features.rb` enables `loans.borrowed.enabled`.
- Partial unique index: `idx_loan_installments_posted_once` on `(account_id, installment_no)` when `status='posted'` (prevents double-posting).
- Category keys: added nullable column `categories.key` with unique index per family (used to seed/resolve system categories).
- Day count method: added nullable `loans.day_count` to persist preview param for future IFRS/EIR support.
- EIR flag: added `loans.eir_enabled` boolean (default false) as future capability hook.
- Audit logs: created `audit_logs` table (uuid) to store minimal changesets and context for Loan and LoanInstallment updates.
- Performance indexes: added concurrent, partial indexes optimized for next planned installment and posted lookups.

Rollforward
1. Run migrations: `bin/rails db:migrate`.
2. Optional: seed loan plan rows using the new plan builder service in console.

Rollback
1. `bin/rails db:rollback STEP=1` — drops only the new columns and `loan_installments` table.

Compatibility
- No existing models, controllers, or flows are removed or renamed.
- All new columns are nullable and default-safe.
- Schedule preview and posting are additive features; UI is gated by a feature flag.
