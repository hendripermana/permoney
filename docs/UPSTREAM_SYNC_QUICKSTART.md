# Upstream Sync Quick Start Guide

**Goal:** Keep Permoney up-to-date with upstream (we-promise/sure) improvements while preserving all local enhancements.

## TL;DR

```bash
# 1. Run interactive sync helper
bin/upstream-sync

# 2. Or do it manually:
git fetch upstream
git checkout -b feature/upstream-sync-v0.6.4
git cherry-pick <safe-commits>  # See list below

# 3. Manual integration (see MANUAL_INTEGRATION_GUIDE.md)
# 4. Test everything
bin/rails test
bin/rubocop -A
bin/brakeman --no-pager

# 5. Create PR
```

## What's Happening?

**Upstream (we-promise/sure) has:**
- ✅ Added new features (Langfuse, password reset improvements, etc.)
- ❌ Removed many features we need (loans, personal lending, pay later, Indonesian features)
- ❌ Changed branding back to "Sure" (we're "Permoney")

**Our Strategy:**
- ✅ Cherry-pick safe improvements
- ❌ Ignore feature removals
- 📝 Manually integrate configuration/design updates

## Safe Commits to Cherry-Pick

These 16 commits are safe to integrate automatically:

```bash
# Security (MUST DO)
git cherry-pick 24cf830c  # Bump rexml 3.4.1 → 3.4.2

# UI/UX Improvements
git cherry-pick 2716fad7  # Fix theme preference on page load
git cherry-pick b4aa5194  # Adjust color styles for checkboxes
git cherry-pick 730330ab  # Add back button to password reset
git cherry-pick b45f96e4  # Password reset back button (confirmation)

# New Features
git cherry-pick f3fecc40  # Add invite codes deletion
git cherry-pick 5f97f2fc  # Add new date format and 10-year period
git cherry-pick dfd467cc  # Add account reset with sample data

# AI/Langfuse Integration
git cherry-pick 72738789  # Langfuse config ENV vars
git cherry-pick cbc653a6  # Track Langfuse sessions and users

# Configuration
git cherry-pick 53adc4f2  # Expose AI_DEBUG_MODE
git cherry-pick 617876f1  # Add Plaid dummy credentials

# Cleanup
git cherry-pick 7245dd79  # LLM context files cleanup
git cherry-pick 2892ebb2  # Codex environment script
git cherry-pick c1480f80  # Remove orphaned assets

# Docker
git cherry-pick ed99a4dc  # Tag latest image on release
```

## Manual Integration Required

After cherry-picking, manually integrate:

1. **Design System** - Review `maybe-design-system.css`, apply improvements to `permoney-design-system.css`
2. **Environment Variables** - Add Langfuse and AI_DEBUG_MODE to `.env.local.example`
3. **Documentation** - Merge AGENTS.md improvements
4. **Views** - Add dark mode check, update password reset view

See `docs/MANUAL_INTEGRATION_GUIDE.md` for detailed instructions.

## Using the Interactive Helper

```bash
bin/upstream-sync
```

This script provides:
- Automated cherry-picking
- Protected features check
- Test running
- Manual task checklist

## Quick Commands

```bash
# Analyze upstream commits in detail
bin/analyze-upstream-commits

# Check what's different
git fetch upstream
git log main..upstream/main --oneline

# See file changes
git diff main upstream/main --stat

# Check protected features
ls -la app/models/loan.rb
ls -la app/models/personal_lending.rb
ls -la app/models/pay_later.rb
```

## Testing Checklist

After integration:

```bash
# Automated tests
bin/rails test
bin/rubocop -A
bin/brakeman --no-pager

# Manual testing
# - Loan management features
# - Personal lending features
# - Pay later features
# - Indonesian finance features
# - New upstream features (Langfuse, password reset, etc.)
```

## Rollback

If something goes wrong:

```bash
# Abort current cherry-pick
git cherry-pick --abort

# Delete integration branch and start over
git checkout main
git branch -D feature/upstream-sync-v0.6.4

# Restore from backup
git checkout backup/pre-upstream-sync-TIMESTAMP
```

## Timeline

- **Automated cherry-picking:** 30 minutes
- **Manual integration:** 2-3 hours
- **Testing:** 1-2 hours
- **Total:** 4-6 hours

## Need Help?

1. Read `docs/UPSTREAM_SYNC_STRATEGY.md` for full strategy
2. Read `docs/MANUAL_INTEGRATION_GUIDE.md` for detailed steps
3. Run `bin/upstream-sync` for interactive help
4. Run `bin/analyze-upstream-commits` for commit analysis

## Important Notes

⚠️ **DO NOT merge upstream/main directly** - It will delete all our features!

✅ **DO cherry-pick selectively** - Only safe commits

📝 **DO manual integration** - For design system and config files

🧪 **DO test thoroughly** - All features must work after integration

## Next Steps

1. Review this guide and the strategy document
2. Run `bin/analyze-upstream-commits` to see detailed analysis
3. Create integration branch
4. Start cherry-picking safe commits
5. Do manual integration
6. Test everything
7. Create PR for review
