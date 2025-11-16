# Permoney Project Overview

## Project Purpose
Permoney (formerly Maybe Finance) is a **personal finance application** built with Ruby on Rails that helps users:
- Track net worth and account balances
- Manage budgets and expenses
- Categorize transactions
- Gain financial insights and analysis
- Manage investments, crypto, loans, and properties
- Support for Indonesian finance features (Islamic finance, personal lending, Pinjol)

## Application Modes
- **Managed**: Permoney team operates servers for users
- **Self-Hosted**: Users can self-host via Docker Compose

## Core Domain Model
```
User → Family → Accounts → Entries
                         → Transactions
                         → Holdings
                         → Balances
```

### Key Entities
- **User**: Person using the app
- **Family**: Top-level grouping (users, accounts, preferences)
- **Account**: Checking, Savings, Credit Card, Investment, Crypto, Loan, Property, Personal Lending
- **Entry**: Base class for Transactions, Valuations, Trades
- **Transaction**: Income/Expense with Categories and Tags
- **Holdings**: Investment holdings in accounts
- **Balance**: Daily balance snapshots for accounts

## Tech Stack
- **Backend**: Ruby on Rails 8.1.0 (latest stable)
- **Database**: PostgreSQL 18.x
- **Cache/Jobs**: Redis 7.4.x, Sidekiq + Sidekiq-Cron
- **Frontend**: Hotwire (Turbo 2.0.17 + Stimulus 3.x), ViewComponents
- **Styling**: TailwindCSS v4 with custom design system
- **Asset Pipeline**: Importmap + Propshaft
- **Linting**: Biome 2.2.6 (JavaScript/TypeScript/CSS)
- **Testing**: Minitest + fixtures (no RSpec)
- **Monitoring**: Sentry APM, Skylight, Prometheus, Logtail
- **External APIs**: Plaid (bank sync), OpenAI (AI chat), Stripe (payments)

## Authentication
- **Context API**: Use `Current.user` and `Current.family` (NOT `current_user`/`current_family`)
- Session-based for web users
- OAuth2 (Doorkeeper) for external APIs
- API keys with JWT for direct access

## Key Features
- Real-time bank syncing via Plaid
- CSV import with custom field mapping
- AI-powered financial Q&A
- Subscription management via Stripe
- Background processing via Sidekiq
- Support for multiple currencies
