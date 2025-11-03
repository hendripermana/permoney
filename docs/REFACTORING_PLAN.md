# Permoney Enterprise-Level Code Refactoring Plan
## Rails 8.1 Best Practices & Optimization Roadmap

**Created**: 2025-11-02  
**Rails Version**: 8.1.1  
**Ruby Version**: 3.4.7  
**Status**: In Progress

---

## Executive Summary

This document outlines a comprehensive refactoring plan to bring Permoney codebase to enterprise-level standards following Rails 8.1 best practices. The audit identified fat models (1300+ lines), fat controllers (300+ lines), and optimization opportunities.

---

## Completed ✅

### 1. **Deprecation Warning - RESOLVED**
- ✅ **Issue**: ActiveSupport::Configurable deprecation warning
- ✅ **Root Cause**: Gem dependency (rails-settings-cached or langfuse-ruby) not updated for Rails 8.1
- ✅ **Solution**: Documented in `config/initializers/suppress_deprecations.rb`
- ✅ **Action**: Monitor gem updates, replace if abandoned

### 2. **Transfer Model Fix - RESOLVED**
- ✅ **Issue**: `NoMethodError (undefined method 'entry' for nil)` in transfer form
- ✅ **Fix**: Added safe navigation operator `inflow_transaction&.entry&.date`
- ✅ **Tests**: All transfer tests passing

### 3. **Split Button Component - RESOLVED**
- ✅ **Issue**: Syntax error in ERB template
- ✅ **Fix**: Proper ViewComponent syntax with `%>` closing tags
- ✅ **Result**: Clean button layout, -5 duplicate buttons

### 4. **Loan Islamic Finance - EXTRACTED ✅**
- ✅ **Extracted**: `app/models/loan/islamic_finance.rb` (187 lines)
- ✅ **Includes**: Sharia compliance validation, Islamic product calculations
- ✅ **Tests**: All 12 loan tests passing
- ✅ **Impact**: -187 lines from main Loan model

---

## In Progress 🚧

### 5. **Loan Model Refactoring** (Priority: URGENT)
**Current**: 1,331 lines (TOO FAT!)  
**Target**: <300 lines in main model, rest in concerns

#### Concerns to Extract:
1. ✅ `Loan::IslamicFinance` - DONE (187 lines)
2. 🚧 `Loan::PaymentCalculations` - Calculate monthly payments, schedules
3. 🚧 `Loan::Validations` - All custom validation logic
4. 🚧 `Loan::Defaults` - Default value setting
5. 🚧 `Loan::Schedule` - Payment schedule generation
6. 🚧 `Loan::Notifications` - Payment reminders, alerts

**Estimated Impact**: Reduce main model to ~400 lines

---

## Pending 📋

### 6. **Fat Controllers Refactoring** (Priority: HIGH)

#### LoansController (375 lines)
**Extract Service Objects:**
- `LoanPaymentService` - Handle payment processing
- `LoanBorrowingService` - Handle borrowing operations
- `LoanScheduleService` - Schedule preview generation

**Target**: <150 lines per controller

#### LunchflowItemsController (354 lines)
**Extract Service Objects:**
- `LunchflowImportService` - Import processing
- `LunchflowSyncService` - Data synchronization

#### PersonalLendingsController (233 lines)
**Extract Service Objects:**
- `PersonalLendingPaymentService`
- `PersonalLendingNotificationService`

### 7. **Demo Code Optimization** (Priority: MEDIUM)

#### Demo::Generator (1,247 lines)
**Extract Strategies:**
- `Demo::AccountGenerator`
- `Demo::TransactionGenerator`
- `Demo::BudgetGenerator`

Target: <300 lines per file

### 8. **Provider Code Optimization** (Priority: MEDIUM)

#### Provider::YahooFinance (603 lines)
**Extract Modules:**
- `Provider::YahooFinance::QuoteParser`
- `Provider::YahooFinance::HistoricalData`

#### Provider::OpenAI (485 lines)
**Extract Modules:**
- `Provider::OpenAI::ChatHandler`
- `Provider::OpenAI::FunctionCaller`

---

## N+1 Query Audit (Priority: HIGH)

### High-Traffic Endpoints to Optimize:
1. **Transactions Index** - Check `includes` for account, category, tags
2. **Accounts Dashboard** - Optimize balance calculations
3. **Budget Show** - Preload categories and transactions
4. **Holdings Index** - Include securities and accounts

**Tool**: Install `bullet` gem for development
**Method**: Enable in development environment, monitor logs

```ruby
# config/environments/development.rb
config.after_initialize do
  Bullet.enable = true
  Bullet.alert = true
  Bullet.bullet_logger = true
  Bullet.console = true
  Bullet.rails_logger = true
end
```

---

## Gem Updates (Priority: MEDIUM)

### Major Version Updates (Breaking Changes Possible):
- ⚠️ `sentry-*` gems: 5.26.0 → 6.0.0 (requires testing)
- ⚠️ `jwt`: 2.10.2 → 3.1.2 (check authentication flows)
- ⚠️ `puma`: 6.6.0 → 7.1.0 (check deployment config)
- ⚠️ `skylight`: 6.0.4 → 7.0.0 (production monitoring)

### Minor Updates (Safe):
- ✅ `importmap-rails`: 2.1.0 → 2.2.2
- ✅ `turbo-rails`: 2.0.16 → 2.0.20
- ✅ `pagy`: 9.3.5 → 9.4.0
- ✅ `tailwindcss-rails`: 4.2.3 → 4.4.0

**Recommendation**: Update minor versions first, test thoroughly before major version updates.

---

## Security Audit (Priority: MEDIUM)

### Brakeman Findings:
- ✅ 2 Mass Assignment warnings (already ignored, reviewed)
- ✅ 3 Obsolete ignore entries (clean up `config/brakeman.ignore`)

**Command**: `bin/brakeman --no-pager`

---

## Testing Strategy

### After Each Refactoring Step:
1. Run full test suite: `bin/rails test`
2. Run system tests (if applicable): `bin/rails test:system`
3. Run linting: `bin/rubocop -f github -a`
4. Run ERB linting: `bundle exec erb_lint ./app/**/*.erb -a`
5. Run security scan: `bin/brakeman --no-pager`

### Test Coverage Goals:
- Controllers: >80% coverage
- Models: >90% coverage
- Critical paths: 100% coverage

---

## Rails 8.1 Best Practices Checklist

### Models:
- ✅ Concerns for shared behavior
- ✅ Validations in model layer
- ✅ Business logic in models, not controllers
- ✅ Service objects for complex operations
- 🚧 Keep models <300 lines

### Controllers:
- ✅ Skinny controllers (<150 lines)
- ✅ One responsibility per action
- ✅ Service objects for business logic
- ✅ Strong parameters
- 🚧 Extract concerns for shared behavior

### Views:
- ✅ ViewComponents for reusable UI
- ✅ Hotwire (Turbo + Stimulus) for interactivity
- ✅ Partials for simple templates
- ✅ No business logic in views

### Performance:
- 🚧 Eager loading to prevent N+1 queries
- ✅ Background jobs for long-running tasks
- ✅ Caching for expensive operations
- ✅ Database indexes on foreign keys

---

## Timeline & Milestones

### Phase 1: Critical Refactoring (2-3 days)
- [x] Fix deprecation warnings
- [x] Extract Loan::IslamicFinance
- [ ] Extract Loan::PaymentCalculations
- [ ] Extract Loan::Validations
- [ ] Refactor LoansController

### Phase 2: Controller Optimization (2 days)
- [ ] Refactor LunchflowItemsController
- [ ] Refactor PersonalLendingsController
- [ ] Extract service objects

### Phase 3: N+1 Query Optimization (1 day)
- [ ] Install bullet gem
- [ ] Identify N+1 queries
- [ ] Add `includes` where needed
- [ ] Verify performance improvements

### Phase 4: Gem Updates (1 day)
- [ ] Update minor versions
- [ ] Test thoroughly
- [ ] Update major versions (one by one)
- [ ] Update CHANGELOG.md

### Phase 5: Demo Code Optimization (1 day)
- [ ] Extract Demo::AccountGenerator
- [ ] Extract Demo::TransactionGenerator
- [ ] Optimize performance

---

## Success Metrics

### Code Quality:
- ✅ No files >300 lines (controllers)
- 🚧 No files >400 lines (models)
- ✅ Test coverage >85%
- ✅ 0 critical security warnings

### Performance:
- [ ] 0 N+1 queries in critical paths
- [ ] Average response time <200ms
- [ ] Database queries <10 per request

### Maintainability:
- ✅ Clear separation of concerns
- ✅ Comprehensive documentation
- ✅ Consistent code style (Rubocop compliant)

---

## Resources & References

### Rails 8.1 Guides:
- [Rails 8.1 Release Notes](https://guides.rubyonrails.org/8_1_release_notes.html)
- [ActiveRecord Query Interface](https://guides.rubyonrails.org/active_record_querying.html)
- [Concerns](https://api.rubyonrails.org/classes/ActiveSupport/Concern.html)

### Best Practices:
- [Ruby Style Guide](https://rubystyle.guide/)
- [Rails Best Practices](https://rails-bestpractices.com/)
- [ViewComponent Guide](https://viewcomponent.org/)

---

## Notes

- All refactoring must maintain backward compatibility
- Tests must pass before merging
- Document all breaking changes in CHANGELOG.md
- Review pull requests thoroughly
- Monitor production metrics after deployment

---

**Last Updated**: 2025-11-02  
**Next Review**: Weekly until completion  
**Owner**: Development Team
