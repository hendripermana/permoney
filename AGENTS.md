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

## Assets, Importmap, and Controllers (Rails 8.1)
- **Asset pipeline**: Propshaft with Importmap (no bundler). Assets are served from:
  - `app/assets/builds` for Tailwind output (`tailwind.css`)
  - `app/javascript` for app code and Stimulus controllers
  - `vendor/javascript` for third‑party ESM files
- **Controller loading** (CRITICAL for Rails 8.1):
  - We pin `@hotwired/stimulus-loading` to a local shim at `app/javascript/stimulus-loading.js` via `config/importmap.rb`
  - Custom loading uses `Promise.all` for proper async controller registration
  - `app/javascript/controllers/index.js` eager‑loads controllers with `await` to ensure all controllers load before app initialization
  - **ALL controllers MUST be in `app/javascript/controllers/`** - subdirectories like `controllers/shadcn/` and `controllers/DS/` are supported
  - Controllers are registered with hyphenated identifiers: `shadcn/tabs_controller.js` → `shadcn--tabs`
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
- **CRITICAL**: ALL Stimulus controllers MUST be in `app/javascript/controllers/` (Rails 8.1 requirement)
- Subdirectories are allowed: `app/javascript/controllers/shadcn/`, `app/javascript/controllers/DS/`
- Pass data via `data-*-value` attributes, not inline JavaScript
- Avoid `event.stopPropagation()` - let events bubble for Turbo navigation

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

### Current Versions (October 31, 2025)
- **Ruby**: 3.4.7 (PRISM parser enabled, CVE-2025-61594 fixed)
- **Bundler**: 2.7.2 (preparing for Bundler 4)
- **RubyGems**: 3.7.2 (IMDSv2 support)
- **Rails**: 8.1.0 (Upgraded October 31, 2025)
- **Node.js**: Latest LTS recommended
- **PostgreSQL**: 18.x (latest stable)
- **Redis**: 7.4.x (latest stable)
- **Turbo**: 2.0.17 (Enhanced frame handling)
- **Stimulus**: 3.x (Improved event binding)

### Rails 8.1 New Features & Changes
- **Active Job Continuations**: Long-running jobs can be broken into discrete steps for better resilience during deployments
- **Structured Event Reporting**: Unified interface for producing structured events for logging and monitoring
- **Schema Format Version 8.1**: Columns now sorted alphabetically in schema dumps by default
- **Enhanced Turbo Integration**: Better frame handling and error recovery
- **Improved Performance**: Optimized query execution and caching strategies

### Rails 8.1 Breaking Changes from 8.0
- **Schema Sorting**: `schema.rb` columns are now sorted alphabetically by default (configure with `config.active_record.schema_format_version`)
- **Event Reporting**: New structured event reporting system for better observability
- **Stimulus Event Binding**: Arrow functions in event handlers must be properly bound to maintain context
- **Turbo Frame Handling**: Enhanced error handling for missing frames requires explicit event listeners

## Turbo Frame Best Practices (Rails 8.1)

### Breaking Out of Turbo Frames

**Problem**: Links inside Turbo Frames try to load responses inside the frame instead of navigating the full page.

**Solution**: Use `data-turbo-frame="_top"` to break out of frames for full page navigation:

```erb
<%# In a component inside a Turbo Frame %>
<%= link_to "Settings", settings_path, data: { turbo_frame: "_top" } %>
```

**When to use `_top`:**
- Menu items that should navigate to new pages
- Links inside frames that need full page navigation
- Any navigation that shouldn't be constrained to the frame

**Automatic Implementation**:
```ruby
# app/components/DS/menu_item.rb automatically adds _top for menu links
def merged_opts
  # ...
  if frame.present?
    data = data.merge(turbo_frame: frame)
  else
    # Default to _top frame for menu items to break out of any parent frames
    data = data.merge(turbo_frame: "_top") if variant == :link
  end
  # ...
end
```

### Turbo Frame Events

Always listen to proper Turbo events for menu/modal close behavior:

```javascript
// ✅ GOOD: Listen to turbo:before-visit for navigation
document.addEventListener("turbo:before-visit", () => {
  if (this.show) this.close();
});

// ❌ BAD: Don't intercept turbo:click - let Turbo handle navigation
// document.addEventListener("turbo:click", (event) => {
//   event.stopPropagation(); // DON'T DO THIS
// });
```

### Rails 8.1 Upgrade Issues & Fixes (October 31, 2025)

**Issue 1: Stimulus Controllers Not Loading from Subdirectories**
- **Problem**: Controllers in `app/components/shadcn/` and `app/components/DS/` were not being loaded by Importmap
- **Root Cause**: `pin_all_from "app/components"` was ineffective for nested directories
- **Solution**: 
  - Moved all Stimulus controllers to `app/javascript/controllers/` following Rails conventions
  - Fixed async loading in `app/javascript/stimulus-loading.js` with `Promise.all` and `await`
  - Updated `app/javascript/controllers/index.js` to properly await controller loading
- **Files Changed**:
  - `config/importmap.rb`: Removed incorrect pin_all_from
  - `app/javascript/stimulus-loading.js`: Fixed async controller registration
  - `app/javascript/controllers/index.js`: Added await for eager loading
  - Moved controllers from `app/components/` to `app/javascript/controllers/`

**Issue 2: Event Propagation Blocking Clicks**
- **Problem**: `event.stopPropagation()` in multiple controllers blocked event bubbling
- **Root Cause**: Overly aggressive event handling prevented Turbo navigation
- **Solution**: Removed `stopPropagation()` from tab and menu controllers, keeping only `preventDefault()` where needed
- **Files Changed**:
  - `app/javascript/controllers/shadcn/tabs_controller.js`
  - `app/javascript/controllers/DS/tabs_controller.js`
  - `app/javascript/application.js`: Removed problematic `turbo:click` handler

**Issue 3: Dropdown Menu Items Not Navigating**
- **Problem**: Menu items inside Turbo Frame couldn't navigate to full pages
- **Root Cause**: User menu wrapped in `turbo_frame_tag` caused Turbo to load responses inside frame instead of full page navigation
- **Solution**: Added `data-turbo-frame="_top"` to menu link items to break out of parent frames
- **Files Changed**:
  - `app/components/DS/menu_item.rb`: Added automatic `_top` frame for link items
  - `app/javascript/controllers/DS/menu_controller.js`: Added `turbo:before-visit` handler for clean menu close

**Key Learnings:**
- Rails 8.1 requires stricter Stimulus controller location conventions
- Turbo Frames need explicit `_top` target to break out for full page navigation
- Event handling must allow proper bubbling for Turbo to work correctly
- Async controller loading must use `Promise.all` to ensure all controllers are registered

### Rails 8 Breaking Changes (from 7.x)
- **RedisCacheStore Configuration**: Connection pool parameters changed from `pool_size:` and `pool_timeout:` to nested `pool: { size:, timeout: }` format
- **Query Log Tags**: `verbose_query_logs` replaced with `query_log_tags_enabled`
- **Puma Worker Boot**: `on_worker_boot` deprecated in favor of `before_worker_boot`

### Stack Components
- **Backend**: Ruby on Rails 8.1.0
- **Database**: PostgreSQL 18.x with UUID primary keys
- **Frontend**: Hotwire (Turbo 2.0.17 + Stimulus 3.x)
- **Styling**: TailwindCSS v4 with custom design system
- **Linting**: Biome 2.2.6 (JavaScript/TypeScript)
- **Testing**: Minitest + fixtures
- **Jobs**: Sidekiq + Redis 7.4.x
- **External APIs**: Plaid, OpenAI, Stripe
- **Deployment**: Docker support for self-hosting

### Key Dependencies
- **aws-sdk-s3**: 1.200.0 (IMDSv2 support)
- **rubyzip**: 3.2 (enhanced security)
- **@biomejs/biome**: 2.2.6 (migrated from 1.9.4)

### Upgrade Policy
- Always use latest stable versions
- Security patches applied immediately
- Major version upgrades documented in AGENTS.md
- Run `bundle outdated` and `npm outdated` regularly

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

## Performance Optimization

### Performance Architecture

Permoney is optimized for blazing-fast performance with comprehensive improvements:

**Runtime Optimization:**
- **YJIT Enabled**: 12-40% performance boost via JIT compilation
- **jemalloc**: 30-40% memory reduction via optimized allocation (system-level, not gem)
- **Ruby GC Tuning**: Optimized garbage collection parameters

**Application Server:**
- **Puma Workers**: 1 per CPU core for true parallelism
- **Thread Pool**: 3-5 threads per worker for optimal throughput
- **Preload App**: Memory efficiency via copy-on-write

**Database Layer:**
- **Connection Pooling**: Sized for (workers × threads) + Sidekiq + buffer
- **Query Timeouts**: Statement (15s), connect (5s), lock (10s)
- **Prepared Statements**: Enabled for better query performance
- **Slow Query Monitoring**: Automatic detection and alerting

**Caching Strategy:**
- **Redis Cache Store**: Distributed caching with compression
- **Fragment Caching**: For expensive views and calculations
- **Cache Monitoring**: Hit/miss rates, slow operations
- **Namespace Isolation**: Multi-tenant cache separation

**Background Processing:**
- **Sidekiq Concurrency**: 10-25 threads for optimal throughput
- **Weighted Queues**: Priority-based job processing
- **Job Monitoring**: Queue depths, slow jobs, retries

**Comprehensive Monitoring:**
- **Sentry APM**: 50% sampling (100% for critical paths)
- **Database Monitoring**: Slow queries, connection pool usage
- **Cache Monitoring**: Hit rates, slow operations
- **External API Monitoring**: Plaid, OpenAI, Stripe performance
- **Memory Profiling**: Leak detection, GC performance
- **Background Job Tracking**: Queue depths, slow jobs

### Performance Guidelines

**Database Queries:**
```ruby
# ❌ AVOID: N+1 queries
@accounts.each { |a| a.entries.count }

# ✅ USE: Eager loading
@accounts = Account.includes(:entries)

# ✅ USE: Counter caches
@accounts.each { |a| a.entries_count }

# ✅ USE: Efficient loading concern
@accounts = Account.for_list.with_common_associations
```

**Caching:**
```ruby
# ✅ USE: Fragment caching for expensive operations
Rails.cache.fetch("key", expires_in: 1.hour) do
  expensive_calculation
end

# ✅ USE: Model-level caching helpers
Account.fetch_cached("balance_series") do
  calculate_balance_series
end
```

**Background Jobs:**
```ruby
# ❌ AVOID: Inline processing of slow operations
def create
  @account.sync_transactions  # Slow!
end

# ✅ USE: Background jobs
def create
  SyncAccountJob.perform_later(@account.id)
end

# ✅ USE: Batch processing
Account.in_efficient_batches(batch_size: 1000) do |account|
  process(account)
end
```

**Memory Management:**
```ruby
# ❌ AVOID: Loading all records
Account.all.each { |a| process(a) }

# ✅ USE: Batch iteration
Account.find_each(batch_size: 1000) { |a| process(a) }

# ✅ USE: Pluck for simple data
Account.pluck(:id)  # Not Account.all.map(&:id)
```

### Performance Monitoring

**Key Metrics:**
- Response time: Target <200ms p95
- Throughput: Requests per second
- Memory usage: Per process
- Database pool: Connection usage
- Cache hit rate: Target >80%
- Background jobs: Queue depths

**Monitoring Tools:**
- Sentry: Performance traces, errors, custom metrics
- Sidekiq Dashboard: `/sidekiq` for job monitoring
- Rails logs: Query logs, cache logs
- PostgreSQL: Slow query logs

### Performance Testing

```bash
# Load testing
hey -n 1000 -c 50 http://localhost:3000/accounts

# Benchmarking
bundle exec derailed bundle:mem
bundle exec derailed exec perf:test
```

### Configuration Files

- `.env.local.example`: All performance environment variables
- `config/puma.rb`: Application server configuration
- `config/sidekiq.yml`: Background job configuration
- `config/database.yml`: Database connection pooling
- `config/environments/production.rb`: Redis cache store
- `config/initializers/sentry.rb`: Comprehensive monitoring
- `docs/PERFORMANCE_GUIDE.md`: Complete performance documentation

### Expected Results

- **Response Time**: 50-70% reduction
- **Throughput**: 3-5x increase
- **Memory Usage**: 30-40% reduction
- **Database Load**: 40-60% reduction
- **Background Jobs**: 3-5x faster processing

## ActiveStorage Best Practices (Rails 8.1)

### Preprocessed Variants for Blazing Fast Performance

**Always use preprocessed variants for frequently accessed images:**

```ruby
# app/models/user.rb
has_one_attached :profile_image do |attachable|
  # Preprocessed = generated immediately after upload for instant display
  attachable.variant :small, resize_to_fill: [72, 72], 
    convert: :webp, 
    saver: { quality: 85, strip: true }, 
    preprocessed: true
    
  attachable.variant :medium, resize_to_fill: [200, 200], 
    convert: :webp, 
    saver: { quality: 85, strip: true }, 
    preprocessed: true
end
```

### Use .processed.url for Immediate Variant Generation

**Always use `.processed.url` instead of `.url` for variants:**

```erb
<%# ❌ BAD: May not display if variant not yet processed %>
<%= image_tag user.profile_image.variant(:small).url %>

<%# ✅ GOOD: Uses preprocessed variant with immediate URL generation %>
<% avatar_url = user.profile_image.attached? ? user.profile_image.variant(:small).processed.url : nil %>
<%= image_tag avatar_url %>
```

### Prevent N+1 Queries with Eager Loading

**Eager load variant records in controllers:**

```ruby
# app/controllers/users_controller.rb
def set_user
  @user = Current.user
  @user.profile_image.attachment&.blob&.variant_records&.load if @user.profile_image.attached?
end
```

### Performance Optimization Tips

- **Use WebP format**: Smaller file size, better compression
- **Enable strip: true**: Remove metadata for smaller files
- **Use preprocessed: true**: For instant display without delays
- **Lazy loading**: Use `loading: "lazy"` for offscreen images
- **Async decoding**: Use `decoding: "async"` for non-blocking image decode

### Memory Management in JavaScript

**Always cleanup blob URLs to prevent memory leaks:**

```javascript
// app/javascript/controllers/profile_image_preview_controller.js
#currentBlobUrl = null;

disconnect() {
  this.#revokeBlobUrl();
}

#revokeBlobUrl() {
  if (this.#currentBlobUrl) {
    URL.revokeObjectURL(this.#currentBlobUrl);
    this.#currentBlobUrl = null;
  }
}
```

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

### ⚠️ CRITICAL: NO NEW DOCUMENTATION FILES

**NEVER create new .md files after completing tasks!**

- ❌ **NEVER** create summary reports, completion reports, or task-specific .md files
- ❌ **NEVER** create UPGRADE_GUIDE.md, CHANGELOG_*.md, or similar files
- ❌ **NEVER** create documentation for completed work
- ✅ **ALWAYS** update existing files only (AGENTS.md, README.md, existing docs/)
- ✅ **ONLY** create new docs when explicitly requested by user for NEW features

**After completing ANY task:**
1. Update AGENTS.md if it affects development workflow
2. Update README.md if it affects setup/usage
3. Update inline code comments for complex logic
4. **DO NOT** create any summary or completion documents

**Exception:** Only create new documentation when:
- User explicitly says "create documentation for X"
- Adding entirely new features that require user guidance
- Creating API documentation for new endpoints (when requested)

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

## Box Carousel Component

A modern 3D carousel component built with Stimulus and Framer Motion for interactive content display.

### Usage

```erb
<%= render BoxCarouselComponent.new(
  items: [
    { id: "1", type: "image", src: "image-url.jpg", alt: "Description" },
    { id: "2", type: "video", src: "video-url.mp4", poster: "poster.jpg" }
  ],
  width: 400,
  height: 300,
  direction: "right",  # "left", "right", "top", "bottom"
  auto_play: true,
  auto_play_interval: 3000,
  enable_drag: true,
  perspective: 1000
) %>
```

### Features
- **3D Rotation**: Smooth cube rotation with 4 visible faces
- **Drag Support**: Mouse and touch drag interactions
- **Keyboard Navigation**: Arrow keys for navigation
- **Auto-play Mode**: Automatic progression through items
- **Mixed Media**: Supports both images and videos
- **Responsive**: Adapts to different screen sizes
- **Accessible**: ARIA labels and keyboard support

### Demo
Visit `/carousel-demo` to see the component in action.

## Variable Font Hover By Letter

An interactive text animation component that animates font variation settings on hover, letter by letter.

### Usage

```erb
<h1 
  data-controller="variable-font-hover"
  data-variable-font-hover-from-value="'wght' 400"
  data-variable-font-hover-to-value="'wght' 700"
  data-variable-font-hover-stagger-duration-value="30"
  data-variable-font-hover-duration-value="500"
  data-action="mouseenter->variable-font-hover#mouseenter mouseleave->variable-font-hover#mouseleave">
  Your Text Here
</h1>
```

### Features
- **Variable Font Animation**: Animates font-variation-settings on hover
- **Stagger Effect**: Letters animate in sequence with configurable delay
- **Customizable**: Control animation duration, stagger timing, and font settings
- **Smooth Transitions**: Uses native CSS transitions for optimal performance
- **Lightweight**: No external animation libraries required

### Data Attributes
- `data-variable-font-hover-from-value`: Initial font variation settings (default: "'wght' 400")
- `data-variable-font-hover-to-value`: Target font variation settings on hover (default: "'wght' 700")
- `data-variable-font-hover-stagger-duration-value`: Delay between each letter in milliseconds (default: 30)
- `data-variable-font-hover-duration-value`: Animation duration in milliseconds (default: 500)

### Requirements
- Works only with variable fonts (e.g., Geist, Inter Variable, etc.)
- Uses native CSS transitions for optimal performance
- No external animation libraries required

## Time-Based Greeting Helper

A helper method that returns appropriate greeting based on current time.

### Usage

```erb
<%= time_based_greeting %>, <%= Current.user.first_name %>!
```

### Returns
- "Good morning" (5:00 AM - 11:59 AM)
- "Good afternoon" (12:00 PM - 5:59 PM)
- "Good evening" (6:00 PM - 4:59 AM)

### Implementation
Uses `Time.current` to respect application timezone settings.

## Realtime Clock Component

A Stimulus controller that displays current date and time with smooth anime.js animations.

### Usage

```erb
<div data-controller="realtime-clock">
  <div data-realtime-clock-target="date">Loading...</div>
  <div data-realtime-clock-target="time">--:--:--</div>
</div>
```

### Features
- **Realtime Updates**: Updates every second automatically
- **Smooth Animations**: Uses native CSS transitions for fade in/out effects
- **Date Format**: Displays full date (e.g., "Monday, October 20, 2025")
- **Time Format**: 24-hour format with seconds (HH:MM:SS)
- **Auto Cleanup**: Properly clears interval on disconnect
- **Smart Updates**: Only animates when values actually change

### Targets
- `date`: Element to display formatted date
- `time`: Element to display formatted time

### Animation
- Fade out with upward translation (300ms)
- Text update
- Fade in with downward translation (300ms)
- Uses CSS `ease-out` timing function for smooth transitions

### Requirements
- No external animation libraries required
- Uses native CSS transitions for optimal performance
- Updates automatically every second
- Respects browser's locale for date formatting

## Floating Chat Component

A modern floating AI chat widget that provides access to the AI assistant from anywhere in the application.

### Usage

```erb
<%= render FloatingChatComponent.new(user: Current.user) %>
```

### Features
- **Floating Button**: Fixed position button at bottom-right corner
- **Responsive Design**: Full-screen on mobile, popover on desktop
- **PWA Optimized**: Handles safe area insets for notched devices
- **Smooth Animations**: CSS transitions for open/close states
- **Keyboard Navigation**: Escape key to close, auto-focus on input
- **Turbo Integration**: Uses Turbo Frames for chat content
- **AI Consent**: Shows consent screen if AI not enabled
- **Accessible**: ARIA labels, keyboard support, screen reader friendly
- **Dark Mode**: Fully supports dark theme

### Component Structure
- `FloatingChatComponent` - ViewComponent for the widget
- `floating_chat_controller.js` - Stimulus controller for UI state
- `floating_show.html.erb` - Chat view for existing conversations
- `floating_new.html.erb` - Chat view for new conversations
- `floating_ai_consent.html.erb` - Consent screen partial

### Stimulus Controller
- **Targets**: `panel`, `backdrop`, `trigger`, `badge`
- **Values**: `open` (Boolean)
- **Actions**: `toggle`, `open`, `close`
- **Features**: Body scroll lock on mobile, escape key handling, smooth animations

### Styling
- Uses design system tokens from `permoney-design-system.css`
- Custom styles in `app/assets/stylesheets/components/floating_chat.css`
- Responsive breakpoints: Mobile (< 1024px), Desktop (≥ 1024px)
- PWA-specific styles for standalone mode
- Reduced motion support for accessibility

### Mobile Behavior
- Full-screen overlay with backdrop
- Body scroll disabled when open
- Touch-optimized button size (56px)
- Safe area insets for notched devices

### Desktop Behavior
- Fixed popover (400px × 600px)
- Bottom-right positioning
- Smooth scale animation
- No backdrop (non-modal)

### Integration
- Automatically added to `application.html.erb` layout
- Replaces previous right sidebar AI chat
- Works with existing Chat model and controllers
- Supports both new and existing conversations

### PWA Considerations
- Handles `display-mode: standalone`
- Respects `safe-area-inset-*` for notched devices
- Touch-friendly button sizing
- Optimized for mobile performance
- Works offline with cached chat history
