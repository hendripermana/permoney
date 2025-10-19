# Permoney Development Guide for AI Agents

# 🤖 AI Agents Documentation

## ⚠️ CRITICAL: Development Philosophy & Documentation Policy

### 🚫 NO QUICK FIXES - ONLY PERMANENT SOLUTIONS

**This project requires PROPER, COMPREHENSIVE, and PERMANENT solutions. NO shortcuts!**

#### Core Development Principles:

1. **🎯 PRIORITY: Full latest ruby on rails Ecosystem + Shadcn/UI**
   - ALWAYS use ruby on rails latest stable version
   - ALWAYS use shadcn/ui latest stable version
   - postgresql latest stable version
   - redis latest stable version
   - use latest stable versions of gems
   - always upgrade if you find deprecated gems or anything to latest stable version

2. **🔍 ALWAYS USE CONTEXT7 AND EXA MCP** - Use Context7 MCP tool for up-to-date library documentation
   - Get latest Ruby on Rails component documentation
   - Get latest Shadcn/ui component documentation
   - Verify API changes and best practices
   - Never assume - always verify with official docs
   - If need browsing use exa MCP

3. **🛠️ NO QUICK FIXES** - Every solution must be:
   - ✅ **Proper**: Based on official Ruby on Rails & Shadcn/ui documentation
   - ✅ **Comprehensive**: Addresses root cause, not just symptoms
   - ✅ **Permanent**: Won't break in future or cause new issues
   - ✅ **Well-analyzed**: Thoroughly investigated before implementation
   - ✅ **Tested**: Verified to work correctly
   - ❌ **NOT** a temporary workaround
   - ❌ **NOT** a "quick fix" that creates technical debt
   - **NOT** a Hardcoded - Always use Context7 MCP to verify ruby on rails/Shadcn and other stack in this project docs
   - 

4. **🐛 WHEN FACING BUGS**:
   - ❌ **NEVER** disable features or tools when stuck
   - ❌ **NEVER** give up or suggest "simple fixes"
   - ✅ **ALWAYS** analyze the root cause thoroughly
   - ✅ **ALWAYS** use Context7 MCP to verify ruby on rails/Shadcn and other stack in this project docs
   - ✅ **ALWAYS** improve and optimize until bug is completely resolved
   - ✅ **ALWAYS** be patient and work incrementally
   - ✅ **ALWAYS** test thoroughly after each change

5. **📈 CONTINUOUS IMPROVEMENT**:
   - Work incrementally with small, tested changes
   - Each change should improve the codebase
   - Never leave code in a broken state
   - Always verify changes work before moving on
   - Document complex logic with inline comments
   - Leverage full ruby on rails ecosystem capabilities

6. **🎯 QUALITY OVER SPEED**:
   - Take time to understand the problem deeply
   - Research proper ruby on rails & Shadcn/ui solutions using Context7 and EXA MCP
   - Implement carefully and test thoroughly
   - A proper solution takes longer but saves time in the long run
   - Use ruby on rails ecosystem to its full potential
   - not hardcoded
   - not workarounds
   - not quick fixes
   - not temporary solutions
   - not "quick fixes" that create technical debt
   - not "simple fixes" that don't improve the codebase
   - not "temporary solutions" that don't improve the codebase
   - not create simple version of something when you stuck on something you improve or fix must do PROPER and PERFECT way to achieve that


This document provides comprehensive guidance for AI agents working on the Permoney codebase. It combines essential development patterns, architectural decisions, and best practices.

## Project Overview

Permoney is a personal finance application built with Ruby on Rails that helps users track net worth, manage budgets, and gain financial insights. The application supports both managed hosting and self-hosted deployments.

### Application Modes
- **Managed**: Permoney team operates servers for users (`Rails.application.config.app_mode = "managed"`)
- **Self Hosted**: Users host on their own infrastructure via Docker Compose (`Rails.application.config.app_mode = "self_hosted"`)

## Project Structure & Module Organization
- **Code**: `app/` (Rails MVC, services, jobs, mailers, components), JS in `app/javascript/`, styles/assets in `app/assets/` (Tailwind, images, fonts)
- **Config**: `config/`, environment examples in `.env.local.example` and `.env.test.example`
- **Data**: `db/` (migrations, seeds), fixtures in `test/fixtures/`
- **Tests**: `test/` mirroring `app/` structure (e.g., `test/models/*_test.rb`)
- **Tooling**: `bin/` (project scripts), `docs/` (guides), `public/` (static), `lib/` (shared libs)
- **Components**: `app/components/` (ViewComponents with co-located Stimulus controllers)

## Core Domain Model

The application is built around financial data management with these key relationships:
- **User** → has many **Accounts** → has many **Transactions**
- **Family**: Top-level entity containing users, accounts, and preferences
- **Account** types: checking, savings, credit cards, investments, crypto, loans, properties, personal lending
- **Transaction** → belongs to **Category**, can have **Tags** and **Rules**
- **Investment accounts** → have **Holdings** → track **Securities** via **Trades**
- **Entry**: Base class for transactions, valuations, and trades that modify account balances
- **Balance**: Daily balance snapshots for accounts

### Account Classifications
**Assets**: Depository, Investment, Crypto, Property, Vehicle, Other Asset
**Liabilities**: Credit Card, Loan (Person and Institute), Pay Later/BNPL, Personal Lending (borrowing), Other Liability

### Indonesian Finance Features
- **Islamic Finance**: Sharia-compliant loans, credit cards, transaction types (Zakat, Infaq/Sadaqah)
- **Personal Lending**: Qard Hasan, informal lending with tracking and reminders
- **Fintech Integration**: Pinjol, P2P Lending, PayLater services
- **Local Categories**: Arisan, Indonesian-specific expense categories

## Build, Test, and Development Commands
- **Setup**: `cp .env.local.example .env.local && bin/setup` — install deps, set DB, prepare app
- **Run app**: `bin/dev` — starts Rails server and asset/watchers via `Procfile.dev`
- **Test suite**: `bin/rails test` — run all Minitest tests; add `TEST=test/models/user_test.rb` to target a file
- **Lint Ruby**: `bin/rubocop` — style checks; add `-A` to auto-correct safe cops
- **Lint/format JS/CSS**: `npm run lint` and `npm run format` — uses Biome
- **Security scan**: `bin/brakeman` — static analysis for common Rails issues

### Pre-Pull Request CI Workflow
**ALWAYS run these commands before opening a pull request:**
1. **Tests** (Required): `bin/rails test` — Run all tests (always required)
2. **Linting** (Required): `bin/rubocop -f github -a` — Ruby linting with auto-correct
3. **Security** (Required): `bin/brakeman --no-pager` — Security analysis

Only proceed with pull request creation if ALL checks pass.

## General Development Rules

### Authentication Context
- **Use `Current.user` for the current user. DO NOT use `current_user`**
- **Use `Current.family` for the current family. DO NOT use `current_family`**

### Development Guidelines
- Prior to generating any code, carefully read the project conventions and guidelines
- Ignore i18n methods and files. Hardcode strings in English for now to optimize speed of development
- Do not run `rails server` in your responses
- Do not run `touch tmp/restart.txt`
- Do not run `rails credentials`
- Do not automatically run migrations

### Key Conventions
1. **Minimize Dependencies**: Push Rails to its limits before adding new dependencies
2. **Skinny Controllers, Fat Models**: Business logic in `app/models/`, avoid `app/services/`
3. **Hotwire-First Frontend**: Native HTML preferred over JS components
4. **Optimize for Simplicity**: Prioritize good OOP domain design over performance
5. **Database vs ActiveRecord Validations**: Simple validations in DB, complex logic in ActiveRecord

## Assets, Importmap, and Controllers
- **Asset pipeline**: Propshaft with Importmap (no bundler). Assets are served from:
  - `app/assets/builds` for Tailwind output (`tailwind.css`)
  - `app/javascript` for app code and Stimulus controllers
  - `vendor/javascript` for third‑party ESM files
- **Controller loading**:
  - We pin `@hotwired/stimulus-loading` to a local shim at `app/javascript/stimulus-loading.js` via `config/importmap.rb`
  - `app/javascript/controllers/index.js` eager‑loads controllers under the `controllers/*` importmap namespace
- **After adding controllers or vendor JS**, restart `bin/dev` and consider `bin/rails tmp:cache:clear` if digests look stale

## TailwindCSS Design System

### Design System Rules
- **Always reference `app/assets/tailwind/permoney-design-system.css`** for primitives and tokens
- **Use functional tokens** defined in design system:
  - `text-primary` instead of `text-white`
  - `bg-container` instead of `bg-white`
  - `border border-primary` instead of `border border-gray-200`
- **NEVER create new styles** in design system files without permission
- **Always generate semantic HTML**
- **Always use `icon` helper** in `application_helper.rb`, NEVER `lucide_icon` directly

## Component Architecture

### ViewComponent vs Partials Decision Making
**Use ViewComponents when:**
- Element has complex logic or styling patterns
- Element will be reused across multiple views/contexts
- Element needs structured styling with variants/sizes
- Element requires interactive behavior or Stimulus controllers
- Element has configurable slots or complex APIs
- Element needs accessibility features or ARIA support

**Use Partials when:**
- Element is primarily static HTML with minimal logic
- Element is used in only one or few specific contexts
- Element is simple template content
- Element doesn't need variants, sizes, or complex configuration
- Element is more about content organization than reusable functionality

### Stimulus Controller Guidelines
**Declarative Actions (Required):**
```erb
<!-- GOOD: Declarative - HTML declares what happens -->
<div data-controller="toggle">
  <button data-action="click->toggle#toggle" data-toggle-target="button">Show</button>
  <div data-toggle-target="content" class="hidden">Hello World!</div>
</div>
```

**Controller Best Practices:**
- Keep controllers lightweight and simple (< 7 targets)
- Use private methods and expose clear public API
- Single responsibility or highly related responsibilities
- Component controllers stay in component directory, global controllers in `app/javascript/controllers/`
- Pass data via `data-*-value` attributes, not inline JavaScript

## Coding Style & Naming Conventions
- **Ruby**: 2-space indent, `snake_case` for methods/vars, `CamelCase` for classes/modules. Follow Rails conventions for folders and file names
- **Views**: ERB checked by `erb-lint` (see `.erb_lint.yml`). Avoid heavy logic in views; prefer helpers/components
- **JavaScript**: `lowerCamelCase` for vars/functions, `PascalCase` for classes/components. Let Biome format code
- **Commit**: Small, cohesive changes; keep diffs focused

## Testing Philosophy

### General Testing Rules
- **ALWAYS use Minitest + fixtures** (NEVER RSpec or factories)
- Keep fixtures minimal (2-3 per model for base cases)
- Create edge cases on-the-fly within test context
- Use Rails helpers for large fixture creation needs

### Test Quality Guidelines
- **Write minimal, effective tests** - system tests sparingly
- **Only test critical and important code paths**
- **Test boundaries correctly:**
  - Commands: test they were called with correct params
  - Queries: test output
  - Don't test implementation details of other classes

### Testing Examples
```ruby
# GOOD - Testing critical domain business logic
test "syncs balances" do
  Holding::Syncer.any_instance.expects(:sync_holdings).returns([]).once
  assert_difference "@account.balances.count", 2 do
    Balance::Syncer.new(@account, strategy: :forward).sync_balances
  end
end

# BAD - Testing ActiveRecord functionality
test "saves balance" do 
  balance_record = Balance.new(balance: 100, currency: "USD")
  assert balance_record.save
end
```

### Stubs and Mocks
- Use `mocha` gem
- Prefer `OpenStruct` for mock instances
- Only mock what's necessary

### Test Structure
- **Framework**: Minitest (Rails). Name files `*_test.rb` and mirror `app/` structure
- **Run**: `bin/rails test` locally and ensure green before pushing
- **Fixtures/VCR**: Use `test/fixtures` and existing VCR cassettes for HTTP. Prefer unit tests plus focused integration tests

## Background Processing

Sidekiq handles asynchronous tasks:
- **Account syncing** (`SyncAccountsJob`)
- **Import processing** (`ImportDataJob`)
- **AI chat responses** (`CreateChatResponseJob`)
- **Scheduled maintenance** via sidekiq-cron
- **Market data imports** (`ImportMarketDataJob`)

### Job Configuration
- **Queues**: `scheduled`, `high_priority`, `medium_priority`, `low_priority`, `default`
- **Cron jobs**: Defined in `config/schedule.yml`
- **Redis**: Required for Sidekiq operation
- **Monitoring**: Available at `/sidekiq` (production auth required)

## API Architecture

The application provides both internal and external APIs:
- **Internal API**: Controllers serve JSON via Turbo for SPA-like interactions
- **External API**: `/api/v1/` namespace with Doorkeeper OAuth and API key authentication
- **API responses**: Use Jbuilder templates for JSON rendering
- **Rate limiting**: Via Rack Attack with configurable limits per API key
- **Authentication**: Session-based for web, OAuth2/API keys for external access

### API Development Guidelines
- Inherit from `Api::V1::BaseController`
- Use `authorize_scope!("read"|"write")` for permissions
- Respect API key rate limiting headers
- Force JSON responses
- Add comprehensive tests under `test/controllers/api/v1/`

## External Services Integration

### Plaid Integration
- **Bank account syncing**: Real-time transaction and balance updates
- **Transaction import**: Automatic categorization and processing
- **PlaidItem**: Manages connections and sync operations
- **Background jobs**: Handle data updates asynchronously

### OpenAI Integration
- **AI chat functionality**: Financial Q&A and insights
- **Transaction categorization**: Automatic expense/income classification
- **Financial insights**: Spending analysis and recommendations
- **Assistant functions**: Structured data queries (balance sheet, income statement)

### Stripe Integration
- **Subscription management**: Billing for managed hosting
- **Payment processing**: Secure payment handling
- **Webhook handling**: Real-time subscription updates

## Technology Stack

- **Backend**: Ruby on Rails 7
- **Database**: PostgreSQL with UUID primary keys
- **Frontend**: Hotwire (Turbo + Stimulus)
- **Styling**: TailwindCSS v4 with custom design system
- **Testing**: Minitest + fixtures
- **Jobs**: Sidekiq + Redis
- **External APIs**: Plaid, OpenAI, Stripe
- **Deployment**: Docker support for self-hosting

## Sync & Import System

Two primary data ingestion methods:
1. **Plaid Integration**: Real-time bank account syncing
   - `PlaidItem` manages connections
   - `Sync` tracks sync operations
   - Background jobs handle data updates
2. **CSV Import**: Manual data import with mapping
   - `Import` manages import sessions
   - Supports transaction and balance imports
   - Custom field mapping with transformation rules

## Commit & Pull Request Guidelines
- **Commits**: Imperative subject ≤ 72 chars (e.g., "Add account balance validation"). Include rationale in body and reference issues (`#123`)
- **PRs**: Clear description, linked issues, screenshots for UI changes, and migration notes if applicable. Ensure CI passes, tests added/updated, and `rubocop`/Biome are clean

## Security & Authentication

### Security Best Practices
- **Never commit secrets**: Use `.env.local` for development, environment variables for production
- **Session-based auth**: For web users with CSRF protection
- **API authentication**: OAuth2 (Doorkeeper) for third-party apps, API keys with JWT for direct access
- **Scoped permissions**: System for API access control
- **Strong parameters**: Throughout application with CSRF protection
- **Security scanning**: Run `bin/brakeman` before major PRs

### Multi-Currency Support
- All monetary values stored in base currency (user's primary currency)
- `Money` objects handle currency conversion and formatting
- Historical exchange rates for accurate reporting
- Indonesian Rupiah (IDR) support with proper formatting

## Performance Considerations

- **Database queries**: Optimized with proper indexes
- **N+1 queries**: Prevented via includes/joins
- **Background jobs**: For heavy operations
- **Caching strategies**: For expensive calculations
- **Turbo Frames**: For partial page updates
- **Focus performance**: Only on critical/global areas

## Common Patterns

### Account Balance Calculation
```ruby
# Daily balances calculated from entries
account.balances.order(:date)

# Current balance
account.current_balance

# Balance on specific date
account.balance_on(date)
```

### Entry Management
```ruby
# Create transaction
account.transactions.create!(
  amount: -100, # Negative for expense
  currency: "USD",
  date: Date.current
)

# Create transfer
Transfer.create!(
  from_account: checking,
  to_account: savings,
  amount: 500
)
```

### Family Management
```ruby
# Current family context
Current.family

# Family members
family.users

# Family accounts
family.accounts
```

### Indonesian Finance Examples
```ruby
# Islamic finance transaction
transaction.update!(kind: "zakat_payment", is_sharia_compliant: true)

# Personal lending
personal_lending = PersonalLending.create!(
  counterparty_name: "Ahmad",
  lending_direction: "lending_out",
  lending_type: "qard_hasan",
  relationship: "friend"
)

# Pinjol loan
loan = Loan.create!(
  compliance_type: "conventional",
  fintech_type: "pinjol",
  counterparty_name: "Kredivo"
)
```

## Documentation Guidelines
- **DO NOT create new .md files** after completing tasks unless explicitly requested by the user
- **Update existing documentation** when your changes affect existing features or configurations
- **Only create documentation** when:
  - User explicitly requests new documentation
  - Adding entirely new features that require user guidance
  - Creating API documentation for new endpoints
- **Preferred approach**: Update existing files in `docs/`, `README.md`, or inline code comments
- **Avoid**: Creating summary reports, completion reports, or task-specific .md files

## Troubleshooting

### Common Issues
1. **Asset 404s**: Clear cache with `bin/rails tmp:cache:clear`
2. **Database issues**: Check `config/database.yml`
3. **Importmap issues**: Restart `bin/dev`
4. **Test failures**: Check fixtures and test data
5. **Redis issues**: Ensure Redis is running for Sidekiq

### Debugging
- Use `Rails.logger.debug` for logging
- Check `log/development.log`
- Use `binding.pry` for debugging
- Monitor Sidekiq dashboard for job issues
- VCR cassettes for external API testing

## Important Files

### Configuration
- `config/routes.rb`: Application routes
- `config/database.yml`: Database configuration
- `config/application.rb`: Rails configuration
- `config/importmap.rb`: JavaScript imports
- `config/schedule.yml`: Sidekiq cron jobs
- `config/sidekiq.yml`: Queue configuration

### Models
- `app/models/family.rb`: Family entity (top-level)
- `app/models/user.rb`: User entity
- `app/models/account.rb`: Account base class
- `app/models/entry.rb`: Entry base class
- `app/models/transaction.rb`: Transaction model with Indonesian types
- `app/models/personal_lending.rb`: Personal lending/borrowing
- `app/models/loan.rb`: Institutional loans with Islamic finance

### Views & Components
- `app/views/layouts/application.html.erb`: Main layout
- `app/components/`: ViewComponents (prefer over partials)
- `app/helpers/application_helper.rb`: Global helpers (icon helper)

### Assets
- `app/assets/tailwind/permoney-design-system.css`: Design tokens (ALWAYS reference)
- `app/javascript/controllers/`: Stimulus controllers
- `app/javascript/application.js`: Main JS entry point

### Testing
- `test/models/`: Model tests
- `test/controllers/`: Controller tests
- `test/system/`: System tests (use sparingly)
- `test/fixtures/`: Test data (keep minimal)

## Notes for AI Agents

When working on this codebase:

1. **Always check existing patterns** before implementing new features
2. **Use the design system** (`app/assets/tailwind/permoney-design-system.css`) for styling
3. **Follow Rails conventions** for file organization
4. **Write tests** for new functionality using Minitest + fixtures
5. **Update documentation** when adding features (update existing files, don't create new ones)
6. **Consider both managed and self-hosted modes** in your implementations
7. **Respect the AGPLv3 license** and attribution requirements
8. **Use `Current.user` and `Current.family`** instead of `current_user`/`current_family`
9. **Prioritize Indonesian finance features** when relevant (Islamic finance, personal lending, local categories)
10. **Always use `icon` helper** instead of `lucide_icon` directly
11. **Keep controllers skinny** - business logic belongs in models
12. **Use ViewComponents** for complex UI, partials for simple content
13. **Prefer semantic HTML** over custom JavaScript components
14. **Test critical paths only** - don't test ActiveRecord functionality
15. **Run pre-PR checks**: tests, linting, security scan

### Quick Reference Commands
```bash
# Setup and run
cp .env.local.example .env.local && bin/setup
bin/dev

# Testing and quality
bin/rails test
bin/rubocop -f github -a
bin/brakeman --no-pager

# Debugging
bin/rails console
bin/rails tmp:cache:clear
```

### Indonesian Finance Context
When working with Indonesian finance features, remember:
- **Islamic compliance** is important (Sharia vs conventional)
- **Personal lending** is common (family, friends, informal agreements)
- **Fintech integration** (Pinjol, P2P lending, e-wallets)
- **Cultural sensitivity** in reminders and communications
- **Local categories** (Arisan, Zakat, Infaq/Sadaqah)
- **Multi-currency support** with IDR formatting
