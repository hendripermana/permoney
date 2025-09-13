## Unreleased

Added
- Borrowed Loans improvements:
  - New Loan subtypes: LOAN_PERSONAL and LOAN_INSTITUTION (display labels: Borrowed (Person) / Borrowed (Institution)).
  - Add-only loan metadata fields (principal, tenor, frequency, method, rate/profit, institution/contact details, notes, JSON extras).
  - Schedule preview endpoint and UI (feature-flagged).
  - Planned installments table with posting service that splits principal vs interest/profit using existing Transfer/Transaction engine.
  - System categories by key with fallback to name, seeded on demand.
  - Partial unique index preventing double-posting installments; plan regeneration replaces only future rows.
  - Optional extra payment service behind feature flag to recompute future schedule.
  - Late Fee/Admin Fee category keys and optional late fee posting support.
  - API endpoint to safely regenerate future schedule with concise payload.
