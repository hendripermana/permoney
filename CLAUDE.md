# Permoney Codebase Guide for Claude

This document provides Claude with essential information about the Permoney codebase to help with development tasks.

## Project Overview

Permoney is a personal finance application built with Ruby on Rails. It helps users track their net worth, manage budgets, and gain insights into their financial health.

## Key Architecture

### Development Server
- `bin/dev` - Start development server (Rails, Sidekiq, Tailwind CSS watcher)
- `bin/rails server` - Start Rails server only
- `bin/rails console` - Open Rails console
### Testing
- `bin/rails test` - Run all tests
- `bin/rails test:db` - Run tests with database reset
- `bin/rails test:system` - Run system tests only (use sparingly - they take longer)
- `bin/rails test test/models/account_test.rb` - Run specific test file
- `bin/rails test test/models/account_test.rb:42` - Run specific test at line
### Linting & Formatting
- `bin/rubocop` - Run Ruby linter
- `npm run lint` - Check JavaScript/TypeScript code
- `npm run lint:fix` - Fix JavaScript/TypeScript issues
- `npm run format` - Format JavaScript/TypeScript code
- `bin/brakeman` - Run security analysis
### Database
- `bin/rails db:prepare` - Create and migrate database
- `bin/rails db:migrate` - Run pending migrations
- `bin/rails db:rollback` - Rollback last migration
- `bin/rails db:seed` - Load seed data
### Setup
- `bin/setup` - Initial project setup (installs dependencies, prepares database)
## Pre-Pull Request CI Workflow
ALWAYS run these commands before opening a pull request:
1. **Tests** (Required):
   - `bin/rails test` - Run all tests (always required)
   - `bin/rails test:system` - Run system tests (only when applicable, they take longer)
2. **Linting** (Required):
   - `bin/rubocop -f github -a` - Ruby linting with auto-correct
   - `bundle exec erb_lint ./app/**/*.erb -a` - ERB linting with auto-correct
3. **Security** (Required):
   - `bin/brakeman --no-pager` - Security analysis
Only proceed with pull request creation if ALL checks pass.
## General Development Rules
### Authentication Context
- Use `Current.user` for the current user. Do NOT use `current_user`.
- Use `Current.family` for the current family. Do NOT use `current_family`.
### Development Guidelines
- Prior to generating any code, carefully read the project conventions and guidelines
- Ignore i18n methods and files. Hardcode strings in English for now to optimize speed of development
- Do not run `rails server` in your responses
- Do not run `touch tmp/restart.txt`
- Do not run `rails credentials`
- Do not automatically run migrations
## High-Level Architecture
### Application Modes
The Maybe app runs in two distinct modes:
- **Managed**: The Maybe team operates and manages servers for users (Rails.application.config.app_mode = "managed")
- **Self Hosted**: Users host the Maybe app on their own infrastructure, typically through Docker Compose (Rails.application.
config.app_mode = "self_hosted")
### Core Domain Model
The application is built around financial data management with these key relationships:
- **User** → has many **Accounts** → has many **Transactions**
- **Account** types: checking, savings, credit cards, investments, crypto, loans, properties
- **Transaction** → belongs to **Category**, can have **Tags** and **Rules**
- **Investment accounts** → have **Holdings** → track **Securities** via **Trades**
### API Architecture
The application provides both internal and external APIs:
- Internal API: Controllers serve JSON via Turbo for SPA-like interactions
- External API: `/api/v1/` namespace with Doorkeeper OAuth and API key authentication
- API responses use Jbuilder templates for JSON rendering
- Rate limiting via Rack Attack with configurable limits per API key
### Sync & Import System
Two primary data ingestion methods:
1. **Plaid Integration**: Real-time bank account syncing
   - `PlaidItem` manages connections
   - `Sync` tracks sync operations
   - Background jobs handle data updates
2. **CSV Import**: Manual data import with mapping
   - `Import` manages import sessions
   - Supports transaction and balance imports
   - Custom field mapping with transformation rules
### Background Processing
Sidekiq handles asynchronous tasks:
- Account syncing (`SyncAccountsJob`)
- Import processing (`ImportDataJob`)
- AI chat responses (`CreateChatResponseJob`)
- Scheduled maintenance via sidekiq-cron
### Frontend Architecture
- **Hotwire Stack**: Turbo + Stimulus for reactive UI without heavy JavaScript
- **ViewComponents**: Reusable UI components in `app/components/`
- **Stimulus Controllers**: Handle interactivity, organized alongside components
- **Charts**: D3.js for financial visualizations (time series, donut, sankey)
- **Styling**: Tailwind CSS v4.x with custom design system
  - Design system defined in `app/assets/tailwind/maybe-design-system.css`
  - Always use functional tokens (e.g., `text-primary` not `text-white`)
  - Prefer semantic HTML elements over JS components
  - Use `icon` helper for icons, never `lucide_icon` directly
  
### Assets & Importmap
- Importmap + Propshaft serve JS/CSS without a bundler.
- Sources: `app/assets/builds` (Tailwind output), `app/javascript` (app/controllers), `vendor/javascript` (ESM vendor files).
- Stimulus loader shim: `@hotwired/stimulus-loading` is pinned to `app/javascript/stimulus-loading.js` (local), which 
eager‑registers controllers under the `controllers/*` namespace.
- When adding controllers or vendor JS, restart `bin/dev`; if assets 404, run `bin/rails tmp:cache:clear` and hard refresh.
### Multi-Currency Support
- All monetary values stored in base currency (user's primary currency)
- `Money` objects handle currency conversion and formatting
- Historical exchange rates for accurate reporting
### Security & Authentication
- Session-based auth for web users
- API authentication via:
  - OAuth2 (Doorkeeper) for third-party apps
  - API keys with JWT tokens for direct API access
- Scoped permissions system for API access
- Strong parameters and CSRF protection throughout
### Testing Philosophy
- Comprehensive test coverage using Rails' built-in Minitest
- Fixtures for test data (avoid FactoryBot)
- Keep fixtures minimal (2-3 per model for base cases)
- VCR for external API testing
- System tests for critical user flows (use sparingly)
- Test helpers in `test/support/` for common scenarios
- Only test critical code paths that significantly increase confidence
- Write tests as you go, when required
### Performance Considerations
- Database queries optimized with proper indexes
- N+1 queries prevented via includes/joins
- Background jobs for heavy operations
- Caching strategies for expensive calculations
- Turbo Frames for partial page updates
### Development Workflow
- Feature branches merged to `main`
- Docker support for consistent environments
- Environment variables via `.env` files
- Lookbook for component development (`/lookbook`)
- Letter Opener for email preview in development
### Troubleshooting Assets in Dev
- 404s for `/assets/*.js` or `/assets/*.css` can be due to stale digests or missing paths.
- Ensure `config/initializers/assets.rb` includes `app/assets/builds`, `app/javascript`, and `vendor/javascript`.
- Clear caches: `bin/rails tmp:cache:clear` → restart `bin/dev` → hard refresh.
## Project Conventions
### Convention 1: Minimize Dependencies
- Push Rails to its limits before adding new dependencies
- Strong technical/business reason required for new dependencies
- Favor old and reliable over new and flashy
### Convention 2: Skinny Controllers, Fat Models
- Business logic in `app/models/` folder, avoid `app/services/`
- Use Rails concerns and POROs for organization
- Models should answer questions about themselves: `account.balance_series` not `AccountSeries.new(account).call`
### Convention 3: Hotwire-First Frontend
- **Native HTML preferred over JS components**
  - Use `<dialog>` for modals, `<details><summary>` for disclosures
- **Leverage Turbo frames** for page sections over client-side solutions
- **Query params for state** over localStorage/sessions
- **Server-side formatting** for currencies, numbers, dates
- **Always use `icon` helper** in `application_helper.rb`, NEVER `lucide_icon` directly
### Convention 4: Optimize for Simplicity
- Prioritize good OOP domain design over performance
- Focus performance only on critical/global areas (avoid N+1 queries, mindful of global layouts)
### Convention 5: Database vs ActiveRecord Validations
- Simple validations (null checks, unique indexes) in DB
- ActiveRecord validations for convenience in forms (prefer client-side when possible)
- Complex validations and business logic in ActiveRecord
## TailwindCSS Design System
### Design System Rules
- **Always reference `app/assets/tailwind/maybe-design-system.css`** for primitives and tokens
- **Use functional tokens** defined in design system:
  - `text-primary` instead of `text-white`
  - `bg-container` instead of `bg-white`
  - `border border-primary` instead of `border border-gray-200`
- **NEVER create new styles** in design system files without permission
- **Always generate semantic HTML**
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
**Component Guidelines:**
- Prefer components over partials when available
- Keep domain logic OUT of view templates
- Logic belongs in component files, not template files
### Stimulus Controller Guidelines
**Declarative Actions (Required):**
```erb
<!-- GOOD: Declarative - HTML declares what happens -->
<div data-controller="toggle">
  <button data-action="click->toggle#toggle" data-toggle-target="button">Show</button>
  <div data-toggle-target="content" class="hidden">Hello World!</div>
</div>
**Controller Best Practices:**
- Keep controllers lightweight and simple (< 7 targets)
- Use private methods and expose clear public API
- Single responsibility or highly related responsibilities
- Component controllers stay in component directory, global controllers in `app/javascript/controllers/`
- Pass data via `data-*-value` attributes, not inline JavaScript
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


### App Modes

The Permoney app runs in two distinct modes:
- **Managed**: The Permoney team operates and manages servers for users (Rails.application.config.app_mode = "managed")
- **Self Hosted**: Users host the Permoney app on their own infrastructure, typically through Docker Compose (Rails.application.config.app_mode = "self_hosted")

### Core Domain Models

- **Family**: Top-level entity containing users, accounts, and preferences
- **User**: Belongs to a Family, can be admin or member
- **Account**: Financial accounts (checking, savings, investments, etc.)
- **Entry**: Transactions, valuations, and trades that modify account balances
- **Balance**: Daily balance snapshots for accounts
- **Holding**: Investment holdings within accounts

### Account Types

**Assets:**
- Depository (checking/savings)
- Investment (brokerage, 401k)
- Crypto
- Property
- Vehicle
- Other Asset

**Liabilities:**
- Credit Card
- Loan
- Other Liability

## Technology Stack

- **Backend**: Ruby on Rails 7
- **Database**: PostgreSQL
- **Frontend**: Hotwire (Turbo + Stimulus)
- **Styling**: TailwindCSS v4
- **Testing**: Minitest + fixtures
- **Jobs**: Sidekiq + Redis
- **External APIs**: Plaid, OpenAI, Stripe

## Development Setup

### Prerequisites
- Ruby (see .ruby-version)
- PostgreSQL
- Node.js (for frontend tooling)

### Quick Start
```bash
git clone https://github.com/hendripermana/permoney.git
cd permoney
cp .env.local.example .env.local
bin/setup
bin/dev
```

Visit http://localhost:3000

## Key Conventions

### Code Organization
- **Models**: Business logic goes in models, not services
- **Concerns**: Use for shared functionality
- **Controllers**: Keep thin, delegate to models
- **Views**: Use ViewComponents for complex UI, partials for simple content

### Styling
- **Design system**: Defined in `app/assets/tailwind/maybe-design-system.css`
- **Always reference `app/assets/tailwind/maybe-design-system.css`** for primitives and tokens
- **Use functional tokens**: `text-primary`, `bg-container`, etc.
- **Semantic HTML**: Prefer native elements over custom components

### Testing
- **Framework**: Minitest (not RSpec)
- **Fixtures**: Use for test data, keep minimal
- **System tests**: Use sparingly for critical user flows
- **VCR**: For external API calls

### Hotwire Patterns
- **Turbo Frames**: Break up pages into components
- **Turbo Streams**: Real-time updates
- **Stimulus**: Client-side interactions
- **Native HTML**: Use `<dialog>`, `<details>`, etc.

## Common Tasks

### Adding a New Feature
1. Create model with validations and associations
2. Add controller actions
3. Create views using ViewComponents or partials
4. Add routes
5. Write tests
6. Update documentation

### Database Changes
1. Create migration
2. Update model validations
3. Update fixtures if needed
4. Test the migration

### Frontend Changes
1. Use TailwindCSS tokens from design system
2. Prefer ViewComponents for complex UI
3. Use Stimulus for interactions
4. Test with system tests if critical

## Important Files

### Configuration
- `config/routes.rb`: Application routes
- `config/database.yml`: Database configuration
- `config/application.rb`: Rails configuration
- `config/importmap.rb`: JavaScript imports

### Models
- `app/models/family.rb`: Family entity
- `app/models/user.rb`: User entity
- `app/models/account.rb`: Account base class
- `app/models/entry.rb`: Entry base class

### Views
- `app/views/layouts/application.html.erb`: Main layout
- `app/components/`: ViewComponents
- `app/helpers/application_helper.rb`: Global helpers

### Assets
- `app/assets/tailwind/maybe-design-system.css`: Design tokens
- `app/javascript/controllers/`: Stimulus controllers
- `app/javascript/application.js`: Main JS entry point

## Testing

### Running Tests
```bash
# All tests
bin/rails test

# Specific file
bin/rails test test/models/user_test.rb

# Specific test
bin/rails test test/models/user_test.rb:25
```

### Test Structure
- `test/models/`: Model tests
- `test/controllers/`: Controller tests
- `test/system/`: System tests
- `test/fixtures/`: Test data

## Deployment

### Self-Hosted
- Docker Compose setup
- Environment variables in `.env`
- PostgreSQL and Redis required

### Managed
- Rails application
- Sidekiq for background jobs
- External service integrations

## External Services

### Plaid Integration
- Bank account syncing
- Transaction import
- Balance updates

### OpenAI Integration
- AI chat functionality
- Transaction categorization
- Financial insights

### Stripe Integration
- Subscription management
- Payment processing

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

## Troubleshooting

### Common Issues
1. **Asset 404s**: Clear cache with `bin/rails tmp:cache:clear`
2. **Database issues**: Check `config/database.yml`
3. **Importmap issues**: Restart `bin/dev`
4. **Test failures**: Check fixtures and test data

### Debugging
- Use `Rails.logger.debug` for logging
- Check `log/development.log`
- Use `binding.pry` for debugging
- Monitor Sidekiq dashboard for job issues

## Resources

- **Documentation**: `docs/` directory
- **Issues**: GitHub Issues
- **Discussions**: GitHub Discussions
- **Discord**: Community chat

## Notes for Claude

When working on this codebase:
1. **Always check existing patterns** before implementing new features
2. **Use the design system** for styling
3. **Follow Rails conventions** for file organization
4. **Write tests** for new functionality
5. **Update documentation** when adding features
6. **Consider both managed and self-hosted modes**
7. **Respect the AGPLv3 license** and attribution requirements
8. **DO NOT create new .md files** after completing tasks unless explicitly requested
9. **Update existing docs** instead of creating new documentation files
10. **Avoid creating** summary reports, completion reports, or task-specific documentation
