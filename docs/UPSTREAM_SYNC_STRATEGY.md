# Upstream Sync Strategy - we-promise/sure v0.6.4

**Date:** October 20, 2025  
**Local Version:** Permoney v0.5.0  
**Upstream Version:** we-promise/sure v0.6.4  
**Status:** Planning Phase

## Executive Summary

The upstream repository (we-promise/sure) has undergone significant simplification by removing many advanced features that have been developed and enhanced in the Permoney fork. This document outlines a safe integration strategy to adopt upstream improvements while preserving all local enhancements.

## Critical Situation Analysis

### Upstream Changes (22 commits ahead)

**REMOVED Features in Upstream (MUST PRESERVE in Permoney):**
1. **Comprehensive Loan Management System** (~5,000+ lines)
   - Loan wizard component (861 lines)
   - Enhanced loan form component (1,593 lines)
   - Loan::Payable concern (309 lines)
   - Loan::Providable concern (220 lines)
   - All loan services (calculator, payment, schedule generator, insights)
   - Loan installments and audit logs
   - Backdated payment handling
   - Schedule preview and management
   - API endpoints for loan management

2. **Personal Lending System** (~2,000+ lines)
   - Personal lending model and associations
   - Qard Hasan (Islamic lending) support
   - Global lending/payment flows
   - Personal lending services
   - Controllers and views

3. **Pay Later/BNPL System** (~1,500+ lines)
   - Pay later accounts and installments
   - Pay later rates and calculations
   - Multi-currency support
   - Services for expense recording and payments

4. **Indonesian Finance Features** (~3,000+ lines)
   - Sharia compliance fields and validations
   - Indonesian transaction types (Zakat, Infaq/Sadaqah)
   - IDR demo data generator
   - Indonesian localization

5. **Enhanced Design System**
   - Permoney branding (vs Sure branding)
   - Custom design tokens
   - Enhanced UI components

6. **API Endpoints**
   - `/api/v1/debt/loans` - Loan management API
   - `/api/v1/debt/pay_later` - Pay later API

**NEW Features in Upstream (SHOULD INTEGRATE):**
1. ✅ Langfuse integration (AI session/user tracking) - Commits: cbc653a6, 72738789
2. ✅ Password reset improvements (back button) - Commits: b45f96e4, 730330ab
3. ✅ Account reset with sample data preload - Commit: dfd467cc
4. ✅ Theme preference fixes (page load) - Commit: 2716fad7
5. ✅ Invite codes deletion feature - Commit: f3fecc40
6. ✅ Color styles adjustments - Commit: b4aa5194
7. ✅ New date format and 10-year period - Commit: 5f97f2fc
8. ✅ Orphaned assets cleanup - Commit: c1480f80
9. ✅ Security updates (rexml 3.4.1 → 3.4.2) - Commit: 24cf830c
10. ✅ Docker image tagging on release - Commit: ed99a4dc
11. ✅ Plaid configuration improvements - Commit: 617876f1
12. ✅ AI_DEBUG_MODE exposure - Commit: 53adc4f2
13. ✅ LLM context files cleanup - Commit: 7245dd79
14. ✅ Codex environment script - Commit: 2892ebb2

## Integration Strategy

### Phase 1: Preparation (Current)
- [x] Analyze upstream changes
- [x] Identify safe commits to cherry-pick
- [x] Document features to preserve
- [ ] Create integration branch
- [ ] Backup current state

### Phase 2: Selective Cherry-Pick (Safe Commits)
Cherry-pick these commits in order:

```bash
# Security updates
git cherry-pick 24cf830c  # Bump rexml from 3.4.1 to 3.4.2

# Theme and UI improvements
git cherry-pick 2716fad7  # fix: Check user's theme preference during page load
git cherry-pick b4aa5194  # Adjust color styles for checkboxes and text utilities

# Feature additions
git cherry-pick f3fecc40  # Add ability to delete invite codes
git cherry-pick 5f97f2fc  # Add new date format and 10-year period option
git cherry-pick dfd467cc  # Add "Reset account" followed by sample data preload

# Password reset improvements
git cherry-pick 730330ab  # Add back button to password reset page
git cherry-pick b45f96e4  # Password reset back button also after confirmation

# AI/Langfuse integration
git cherry-pick 72738789  # Langfuse config ENV vars
git cherry-pick cbc653a6  # Track Langfuse sessions and users

# Configuration improvements
git cherry-pick 53adc4f2  # Expose AI_DEBUG_MODE in .env.local.example
git cherry-pick 617876f1  # Add dummy PLAID_CLIENT_ID and PLAID_SECRET to env

# Documentation and cleanup
git cherry-pick 7245dd79  # LLM context files cleanup
git cherry-pick 2892ebb2  # Codex environment script
git cherry-pick c1480f80  # Removing orphaned assets

# Docker improvements
git cherry-pick ed99a4dc  # Tag latest image on release
```

### Phase 3: Manual Integration (Requires Careful Merge)

**Files requiring manual review and selective merge:**

1. **Design System** (Keep Permoney branding, adopt improvements)
   - `app/assets/tailwind/maybe-design-system.css` → Review improvements, apply to `permoney-design-system.css`
   - Keep all Permoney-specific tokens and branding

2. **Configuration Files**
   - `.env.local.example` - Merge new variables (Langfuse, AI_DEBUG_MODE)
   - `Gemfile` / `Gemfile.lock` - Update dependencies carefully
   - `package.json` / `package-lock.json` - Update JS dependencies
   - `config/initializers/*` - Review and merge improvements

3. **Documentation**
   - `AGENTS.md` - Merge upstream improvements while keeping Permoney-specific rules
   - `.github/copilot-instructions.md` - Merge improvements

4. **Views/Layouts**
   - `app/views/layouts/_dark_mode_check.html.erb` - New file, adopt
   - `app/views/password_resets/new.html.erb` - Merge back button
   - `app/views/invite_codes/_invite_code.html.erb` - Merge delete functionality

### Phase 4: Testing & Validation
- [ ] Run full test suite: `bin/rails test`
- [ ] Test loan management features
- [ ] Test personal lending features
- [ ] Test pay later features
- [ ] Test Indonesian finance features
- [ ] Test new upstream features (Langfuse, password reset, etc.)
- [ ] Manual UI testing
- [ ] Security scan: `bin/brakeman`
- [ ] Linting: `bin/rubocop -A`

### Phase 5: Documentation Update
- [ ] Update CHANGELOG.md with integrated features
- [ ] Update README.md if needed
- [ ] Document new Langfuse integration
- [ ] Update AGENTS.md with new patterns

## Commits to AVOID (Will Remove Local Features)

**DO NOT cherry-pick these commits:**
- Any commit that removes loan-related files
- Any commit that removes personal_lending files
- Any commit that removes pay_later files
- Any commit that changes branding from Permoney to Sure/Maybe
- Any commit that removes Indonesian features
- Any commit that removes API endpoints

## Risk Assessment

### Low Risk (Safe to integrate)
- Security updates (rexml)
- Theme preference fixes
- Password reset improvements
- New date formats
- Langfuse integration (new feature, no conflicts)

### Medium Risk (Requires testing)
- Design system updates (branding conflicts)
- Configuration file updates (merge conflicts possible)
- Dependency updates (compatibility issues possible)

### High Risk (DO NOT integrate)
- Any commit removing loan features
- Any commit removing personal lending
- Any commit removing pay later
- Any commit removing Indonesian features
- Branding changes back to Sure/Maybe

## Success Criteria

✅ All local features remain functional:
- Loan management with all enhancements
- Personal lending system
- Pay later/BNPL system
- Indonesian finance features
- Permoney branding intact

✅ New upstream features integrated:
- Langfuse AI tracking
- Password reset improvements
- Account reset functionality
- Theme preference fixes
- Invite codes deletion
- Security updates

✅ All tests passing
✅ No regressions in existing features
✅ Documentation updated

## Rollback Plan

If integration causes issues:
```bash
# Return to current state
git checkout main
git branch -D feature/upstream-sync-v0.6.4

# Or reset the integration branch
git checkout feature/upstream-sync-v0.6.4
git reset --hard main
```

## Timeline

- **Phase 1 (Preparation):** 1 hour - CURRENT
- **Phase 2 (Cherry-pick):** 2-3 hours
- **Phase 3 (Manual integration):** 3-4 hours
- **Phase 4 (Testing):** 2-3 hours
- **Phase 5 (Documentation):** 1 hour

**Total estimated time:** 9-12 hours

## Next Steps

1. Create integration branch: `feature/upstream-sync-v0.6.4`
2. Begin Phase 2: Selective cherry-picking
3. Resolve any conflicts carefully
4. Test thoroughly before merging to main

## Notes

- This is a SELECTIVE integration, not a full merge
- Upstream has simplified by removing features we need
- We maintain our enhanced feature set while adopting their improvements
- Future syncs will follow the same pattern
- Consider maintaining a fork relationship with selective pulls
