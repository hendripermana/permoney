
<img width="1190" alt="permoney_hero" src="https://github.com/user-attachments/assets/959f6e9f-2d8a-4f8c-893e-cd3e6eeb4ff2" />

<p align="center">
  <!-- Keep these links. Translations will automatically update with the README. -->
  <a href="https://readme-i18n.com/de/hendripermana/permoney">Deutsch</a> | 
  <a href="https://readme-i18n.com/es/hendripermana/permoney">Español</a> | 
  <a href="https://readme-i18n.com/fr/hendripermana/permoney">Français</a> | 
  <a href="https://readme-i18n.com/ja/hendripermana/permoney">日本語</a> | 
  <a href="https://readme-i18n.com/ko/hendripermana/permoney">한국어</a> | 
  <a href="https://readme-i18n.com/pt/hendripermana/permoney">Português</a> | 
  <a href="https://readme-i18n.com/ru/hendripermana/permoney">Русский</a> | 
  <a href="https://readme-i18n.com/zh/hendripermana/permoney">中文</a>
</p>

# Permoney: The personal finance app for everyone

<b>Get
involved: [Discord](https://discord.gg/36ZGBsxYEK) • [(archived) Website](https://web.archive.org/web/20250715182050/https://maybefinance.com/) • [Issues](https://github.com/hendripermana/permoney/issues)</b>

> [!IMPORTANT]
> **Legal Disclaimer**: Permoney is a fork of the original Maybe Finance application, which is licensed under the GNU Affero General Public License v3.0. This project is not affiliated with, endorsed by, or connected to Maybe Finance Inc. "Maybe" is a trademark of Maybe Finance Inc. and is not used in this project.
> 
> This repository is a community fork of the now-abandoned Maybe Finance project. 
> Learn more in their [final release](https://github.com/maybe-finance/maybe/releases/tag/v0.6.0) doc.

## Backstory

The Maybe Finance team spent most of 2021–2022 building a full-featured personal finance and wealth management app. It even included an "Ask an Advisor" feature that connected users with a real CFP/CFA — all included with your subscription.

The business end of things didn't work out, and so they stopped developing the app in mid-2023.

After spending nearly $1 million on development (employees, contractors, data providers, infra, etc.), the team open-sourced the app. Their goal was to let users self-host it for free — and eventually launch a hosted version for a small fee.

They actually did launch that hosted version … briefly.

That also didn't work out — at least not as a sustainable B2C business — so now here we are: hosting a community-maintained fork to keep the codebase alive and see where this can go next.

Join us!

## Hosting Permoney

Permoney is a fully working personal finance app that can be [self hosted with Docker](docs/hosting/docker.md).

## Borrowed Loans (Personal & Institution)

Added support for borrowed loans under the existing Loan account type without breaking changes:

- Subtypes: `LOAN_PERSONAL` and `LOAN_INSTITUTION` (displayed as “Borrowed (Person)” / “Borrowed (Institution)”).
- Unified form with progressive disclosure for person vs institution fields.
- Optional opening balance on creation continues to use opening anchors; a schedule preview is available (feature‑flagged).
- Planned installments are stored and you can post one installment splitting principal vs interest/profit using existing Transfers and Transactions.

Categories
- System categories are resolved by key with name fallback:
  - `system:interest_expense` → "Interest Expense"
  - `system:islamic_profit_expense` → "Profit Expense"
  - `system:late_fee_expense` → "Late Fee Expense"
  - `system:admin_fee_expense` → "Loan Admin Fee"
  The resolver seeds categories per family on demand and keeps them stable via `categories.key` (nullable) when available.

Idempotency & safety
- Posting an installment runs in a single DB transaction and is protected by a partial unique index on `(account_id, installment_no)` where `status = 'posted'`.
- Regenerating a plan replaces only future rows (>= today or > last posted number); past rows remain intact.

Extra payment (feature-flagged)
- `features.loans.extra_payment` (default: false) adds a service to apply extra payments and recompute future schedule in either reduce-term or reduce-installment modes.

Regenerate schedule (API)
- `POST /api/v1/debt/loans/plan/regenerate` re-generates only future rows (>= today or > last posted) with validation and returns `{regenerated_count, next_due_date}`.

IFRS/EIR (flag only)
- `loans.eir_enabled` (default false) is a future capability hook; preview API accepts `day_count` but does not change math by default.
  - Supported `day_count` values in preview: `30E/360`, `ACT/365`, `ACT/ACT` (validation only; current default behavior is actual/365 style rounding).

Optional: Opening Balance via Journal (adapter)
- Permoney uses an opening anchor (valuation) by default for opening balances — a non‑posting balance anchor that keeps flows simple and idempotent.
- Some accounting systems (e.g., QuickBooks/Xero) prefer a journalized contra entry to Equity ("Opening Balance Equity") for loan openings (Dr Cash/Asset, Cr Loan; or Dr Loan, Cr Equity depending on perspective).
- In the future, a journal adapter could post a concealed Equity contra while preserving current UX. This is out‑of‑scope by default and not enabled.
- References:
  - QuickBooks: Opening Balance Equity guidance
  - Xero: Enter opening balances and contra accounts

Endpoints (API):
- `POST /api/v1/debt/loans/plan/preview` — preview schedule (no persistence)
- `POST /api/v1/debt/loans/installment/post` — post next or specific installment

## Forking and Attribution

This repo is a community fork of the archived Maybe Finance repo, rebranded as **Permoney**. It replaces the discontinued Synth data provider with pluggable alternatives (Twelve Data, Alpha Vantage) to restore market data, exchange rates, and net worth chart functionality.

**Important Legal Notice:**
- Permoney is based on the original Maybe Finance codebase but is completely independent and not affiliated with Maybe Finance Inc.
- This project complies with the AGPLv3 license requirements
- All "Maybe" branding and trademarks have been removed and replaced with "Permoney"
- The original AGPLv3 license is preserved and included in this repository

You're free to fork it under the AGPLv3 license — but we'd love it if you stuck around and contributed here instead.

## Local Development Setup

**If you are trying to _self-host_ the app, [read this guide to get started](docs/hosting/docker.md).**

The instructions below are for developers to get started with contributing to the app.

### Requirements

- See `.ruby-version` file for required Ruby version
- PostgreSQL >9.3 (latest stable version recommended)

### Getting Started
```sh
cd permoney
cp .env.local.example .env.local
bin/setup
bin/dev

# Optionally, load demo data
rake demo_data:default
```

Visit http://localhost:3000 to view the app. You can log in with these demo credentials (from the DB seed):

- Email: `user@permoney.local`
- Password: `password`

For further instructions, see guides below.

### Frontend Tooling

- Assets are served by Propshaft with Importmap (no JS bundler).
- Sources:
  - `app/assets/builds` for Tailwind output (`tailwind.css`)
  - `app/javascript` for application JS and Stimulus controllers
  - `vendor/javascript` for pinned third‑party ESM packages
- Stimulus controllers are auto‑registered via `app/javascript/controllers/index.js` using a local loader shim pinned as `@hotwired/stimulus-loading` → `app/javascript/stimulus-loading.js`.

### Troubleshooting: 404s for assets in development

If you see 404s like `/assets/tailwind-*.css` or `/assets/d3-*.js`:

1. Stop `bin/dev` completely.
2. Clear caches: `bin/rails tmp:cache:clear`.
3. Restart: `bin/dev` and hard‑refresh the browser.
4. Ensure paths are present in `config/initializers/assets.rb`:
   - `app/assets/builds`, `app/javascript`, and `vendor/javascript` are in `config.assets.paths`.
5. If importmap looks stale, bump `Rails.application.config.assets.version` and reload.

### Setup Guides

- [Mac dev setup](https://github.com/hendripermana/permoney/wiki/Mac-Dev-Setup-Guide)
- [Linux dev setup](https://github.com/hendripermana/permoney/wiki/Linux-Dev-Setup-Guide)
- [Windows dev setup](https://github.com/hendripermana/permoney/wiki/Windows-Dev-Setup-Guide)
- Dev containers - visit [this guide](https://code.visualstudio.com/docs/devcontainers/containers)

## License and Trademarks

Permoney is distributed under the [AGPLv3 license](LICENSE), maintaining compliance with the original Maybe Finance licensing terms.

**Trademark Notice:**
- "Maybe" is a trademark of Maybe Finance, Inc. and is not used in this project
- "Permoney" is the independent name for this community fork
- This project is not affiliated with, endorsed by, or connected to Maybe Finance Inc.

**AGPLv3 Compliance:**
- Source code is freely available in this repository
- All modifications are shared under the same license
- Network use triggers source code sharing requirements
- Full license text available in [LICENSE](LICENSE) file

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Support

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/hendripermana/permoney/issues)
- **Discussions**: [GitHub Discussions](https://github.com/hendripermana/permoney/discussions)
- **Discord**: [Join our community](https://discord.gg/36ZGBsxYEK)

## Acknowledgments

- Original Maybe Finance team for open-sourcing this excellent codebase
- Community contributors who keep the project alive
- All the data providers and services that make this app possible
### CI Lint/Security
- Before opening PRs, run:
  - `bin/rails test`
  - `bin/rubocop -f github -a`
  - `bin/brakeman --no-pager`
Audit / Versioning
- Lightweight audit logs record changes to critical fields (Loan and LoanInstallment) without adding external dependencies.
- Tracks: Loan (principal_amount, rate_or_profit, tenor_months, institution_type, lender_name, schedule_method, payment_frequency, start_date), LoanInstallment (due_date, principal_amount, interest_amount, total_amount, status, posted_on, transfer_id).
- Each audit captures user_id and ip address via Current; no sensitive data stored.

Indexing & Performance
- Added concurrent, partial indexes to speed common lookups:
  - `loan_installments(account_id, due_date)` where status='planned' for next-due queries.
  - `loan_installments(account_id, status)` where status='posted' for posted lookups.
  - Optional filters on `loans.institution_type` and `loans.lender_name`.
- Index migrations use `disable_ddl_transaction!` and `algorithm: :concurrently`.

Error Logging & Instrumentation
- Schedule generation, extra payment recomputation, plan regeneration, and posting now emit structured logs (JSON) with timing and context.
- Preview API validates inputs; returns 422 for invalid cases (e.g., balloon > principal) with clear messages.
  - Optional: `EXPLAIN ANALYZE` in staging to verify index usage on installment queries
## Sentry Observability

Borrowed Loans integrates with Sentry for error monitoring and tracing (add‑only, off by default locally):

- Initialization: `config/initializers/sentry.rb` enables Sentry in `production` and `staging`.
- Tracing: `config.traces_sample_rate` (default 0.2) and a `traces_sampler` that samples 100% for `/api/v1/debt/loans*` endpoints.
- Profiling: `config.profiles_sample_rate` (default 0.0) via ENV.
- Custom spans and measurements:
  - Schedule generation (`loan.schedule.generate`) sets `loan.schedule.ms`.
  - Plan builder (`loan.plan.build`) sets `loan.plan.ms` and `loan.plan.created`.
  - Installment post (`loan.installment.post`) sets `loan.installment.ms` and `loan.installment.total_amount`.
  - Extra payment (`loan.extra_payment.apply`) sets `loan.extra.ms` and `loan.extra.created`.
- Breadcrumbs & context: services add breadcrumbs and scope tags/context (loan subtype, feature flags, identifiers) with payload hygiene.
- Staging: enable via `config/environments/staging.rb` and set `SENTRY_DSN` (and optional tracing envs) in your staging environment.
- Env file: see `.env.example` for sample Sentry and feature flag variables.
- Notifications: `permoney.loan.installment.posted` emits after posting; `config/initializers/instrumentation_sentry.rb` bridges to a Sentry span.
  - Additional notifications:
    - `permoney.loan.schedule.generate` → Sentry span `loan.schedule.generate`
    - `permoney.loan.plan.regenerate` → Sentry span `loan.plan.regenerate`
    - `permoney.loan.extra_payment.applied` → Sentry span `loan.extra_payment.applied`
- Optional OpenTelemetry: set `SENTRY_USE_OTEL=true` with compatible gems available to export OTEL traces to Sentry (tracing only).

Environment variables:
- `SENTRY_TRACES_SAMPLE_RATE` (default `0.2`) — traces_sampler takes precedence over sample rate.
- `SENTRY_PROFILES_SAMPLE_RATE` (default `0.0`) — profiling requires tracing.
- `SENTRY_USE_OTEL` (default `false`) — enables OpenTelemetry bridge when gems are present.
