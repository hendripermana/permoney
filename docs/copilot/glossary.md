Project glossary for Copilot

- Account: Delegated type representing an asset or liability with balances and entries.
- Entry: Delegated type that mutates an account (Transaction, Trade, Valuation). Amount sign semantics matter.
- Transfer: Matched pair of transactions moving funds between accounts; special handling for debt payments.
- Balance: Daily account valuation; source-of-truth for charts and summaries.
- Holding/Security: Investment positions and instruments; daily calc rolls into Balance.
- Provided concept: Abstraction for pluggable data providers via Provider::Registry and Provided concerns.
- App modes: managed vs self_hosted; feature toggles and provider access differ.
- Current: Thread-local user/family/session context; use Current.user/Current.family in app code.
