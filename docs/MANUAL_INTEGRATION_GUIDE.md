# Manual Integration Guide - Upstream Sync v0.6.4

This guide provides detailed instructions for manually integrating upstream changes that cannot be automatically cherry-picked.

## Table of Contents
1. [Design System Integration](#design-system-integration)
2. [Configuration Files](#configuration-files)
3. [Documentation Updates](#documentation-updates)
4. [View/Layout Updates](#viewlayout-updates)
5. [Dependency Updates](#dependency-updates)

---

## Design System Integration

### Objective
Adopt improvements from upstream's `maybe-design-system.css` while maintaining Permoney branding.

### Files to Review
- **Upstream:** `app/assets/tailwind/maybe-design-system.css`
- **Local:** `app/assets/tailwind/permoney-design-system.css`

### Steps

1. **Compare design systems:**
```bash
git show upstream/main:app/assets/tailwind/maybe-design-system.css > /tmp/maybe-design-system.css
diff app/assets/tailwind/permoney-design-system.css /tmp/maybe-design-system.css
```

2. **Look for improvements in:**
   - Color utilities (text, background, border)
   - Component utilities (buttons, cards, forms)
   - Accessibility improvements
   - New utility classes

3. **Apply improvements while keeping:**
   - Permoney color palette
   - Permoney branding tokens
   - Custom Permoney components

4. **Test changes:**
```bash
bin/rails assets:precompile
# Visual inspection of UI components
```

### Checklist
- [ ] Review color utility improvements
- [ ] Review component utility improvements
- [ ] Apply non-branding improvements
- [ ] Keep all Permoney-specific tokens
- [ ] Test UI components visually
- [ ] Verify dark mode still works

---

## Configuration Files

### 1. Environment Variables (.env.local.example)

**New variables from upstream:**
```bash
# Langfuse AI Tracking (from commit cbc653a6, 72738789)
LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com

# AI Debug Mode (from commit 53adc4f2)
AI_DEBUG_MODE=false

# Plaid Configuration (from commit 617876f1)
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
```

**Action:**
```bash
# Add these to .env.local.example
cat >> .env.local.example << 'EOF'

# Langfuse AI Tracking (Optional - for AI session tracking)
LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com

# AI Debug Mode
AI_DEBUG_MODE=false

# Plaid Configuration (Required for bank sync)
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
EOF
```

### 2. Gemfile Updates

**Review upstream Gemfile for:**
- Security updates (rexml 3.4.2)
- New dependencies (Langfuse gem if any)
- Version bumps

**Steps:**
```bash
# Compare Gemfiles
git show upstream/main:Gemfile > /tmp/upstream-Gemfile
diff Gemfile /tmp/upstream-Gemfile

# Review changes carefully
# Update only security-critical gems
# Test after each update
```

**Checklist:**
- [ ] Review gem version changes
- [ ] Update security-critical gems
- [ ] Run `bundle install`
- [ ] Run `bin/rails test` after updates
- [ ] Check for deprecation warnings

### 3. Package.json Updates

**Review upstream package.json for:**
- JavaScript dependency updates
- New packages
- Security fixes

**Steps:**
```bash
# Compare package.json
git show upstream/main:package.json > /tmp/upstream-package.json
diff package.json /tmp/upstream-package.json

# Update carefully
npm install
npm audit fix
```

**Checklist:**
- [ ] Review JS dependency changes
- [ ] Update security-critical packages
- [ ] Run `npm install`
- [ ] Test frontend functionality
- [ ] Check for console errors

### 4. Initializers

**Files to review:**
- `config/initializers/sentry.rb` (updated in upstream)
- `config/initializers/sidekiq.rb`
- Any new initializers

**Steps:**
```bash
# List upstream initializers
git ls-tree -r upstream/main --name-only config/initializers/

# Compare each relevant file
git show upstream/main:config/initializers/sentry.rb > /tmp/sentry.rb
diff config/initializers/sentry.rb /tmp/sentry.rb
```

**Checklist:**
- [ ] Review Sentry configuration changes
- [ ] Review Sidekiq configuration changes
- [ ] Check for new initializers
- [ ] Test configuration changes

---

## Documentation Updates

### 1. AGENTS.md

**Upstream changes:**
- LLM context cleanup (commit 7245dd79)
- Codex instructions (commit 60f54f9b)

**Strategy:**
- Keep all Permoney-specific development rules
- Adopt upstream improvements for general Rails/AI guidance
- Merge carefully to avoid losing local enhancements

**Steps:**
```bash
# Review upstream AGENTS.md
git show upstream/main:AGENTS.md > /tmp/upstream-AGENTS.md

# Manual merge:
# 1. Keep Permoney header and philosophy
# 2. Adopt improved Rails patterns
# 3. Keep Indonesian finance documentation
# 4. Keep loan/personal lending documentation
```

**Checklist:**
- [ ] Keep Permoney development philosophy
- [ ] Adopt improved Rails patterns
- [ ] Keep all feature-specific documentation
- [ ] Keep Indonesian finance guidelines
- [ ] Test AI agent understanding

### 2. GitHub Copilot Instructions

**File:** `.github/copilot-instructions.md`

**Steps:**
```bash
# Review upstream copilot instructions
git show upstream/main:.github/copilot-instructions.md > /tmp/copilot-instructions.md
diff .github/copilot-instructions.md /tmp/copilot-instructions.md
```

**Checklist:**
- [ ] Review upstream improvements
- [ ] Keep Permoney-specific instructions
- [ ] Merge general improvements
- [ ] Test with GitHub Copilot

### 3. README.md

**Review for:**
- Installation instructions updates
- New feature documentation
- Configuration changes

**Checklist:**
- [ ] Update if installation steps changed
- [ ] Document new Langfuse integration
- [ ] Keep Permoney-specific features documented
- [ ] Update screenshots if UI changed

---

## View/Layout Updates

### 1. Dark Mode Check (NEW FILE)

**File:** `app/views/layouts/_dark_mode_check.html.erb`

**From commit:** 2716fad7

**Action:**
```bash
# Copy from upstream
git show upstream/main:app/views/layouts/_dark_mode_check.html.erb > app/views/layouts/_dark_mode_check.html.erb

# Add to application layout if not already included
```

**Content:**
```erb
<script>
  // Check theme preference on page load
  (function() {
    const theme = localStorage.getItem('theme') || 'light';
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    }
  })();
</script>
```

**Checklist:**
- [ ] Create file
- [ ] Include in application layout
- [ ] Test theme switching
- [ ] Verify no flash of wrong theme

### 2. Password Reset Back Button

**File:** `app/views/password_resets/new.html.erb`

**From commits:** 730330ab, b45f96e4

**Changes:**
- Add back button to password reset form
- Improve UX

**Steps:**
```bash
# Review upstream version
git show upstream/main:app/views/password_resets/new.html.erb > /tmp/password_reset.erb
diff app/views/password_resets/new.html.erb /tmp/password_reset.erb
```

**Checklist:**
- [ ] Add back button
- [ ] Test navigation flow
- [ ] Verify styling matches design system

### 3. Invite Codes Delete Functionality

**File:** `app/views/invite_codes/_invite_code.html.erb`

**From commit:** f3fecc40

**Changes:**
- Add delete button for invite codes
- Update controller action

**Steps:**
```bash
# Review upstream changes
git show upstream/main:app/views/invite_codes/_invite_code.html.erb > /tmp/invite_code.erb
diff app/views/invite_codes/_invite_code.html.erb /tmp/invite_code.erb

# Also check controller
git show upstream/main:app/controllers/invite_codes_controller.rb > /tmp/invite_codes_controller.rb
diff app/controllers/invite_codes_controller.rb /tmp/invite_codes_controller.rb
```

**Checklist:**
- [ ] Add delete button to view
- [ ] Add destroy action to controller
- [ ] Add route for delete
- [ ] Test delete functionality
- [ ] Add confirmation dialog

---

## Dependency Updates

### Ruby Gems

**Critical updates:**
```ruby
# From commit 24cf830c
gem 'rexml', '~> 3.4.2'  # Security update
```

**Steps:**
```bash
# Update Gemfile
bundle update rexml

# Run tests
bin/rails test

# Check for deprecation warnings
bin/rails runner "puts 'Ruby version: ' + RUBY_VERSION"
```

### JavaScript Packages

**Review for:**
- Security updates
- Breaking changes
- New features

**Steps:**
```bash
# Check for outdated packages
npm outdated

# Update carefully
npm update

# Run tests
npm run lint
npm run format
```

---

## Testing Checklist

After all manual integrations:

### Automated Tests
- [ ] `bin/rails test` - All tests pass
- [ ] `bin/rubocop -A` - No linting errors
- [ ] `bin/brakeman --no-pager` - No security issues

### Feature Testing
- [ ] Loan management features work
- [ ] Personal lending features work
- [ ] Pay later features work
- [ ] Indonesian finance features work
- [ ] New Langfuse integration works (if configured)
- [ ] Password reset with back button works
- [ ] Account reset with sample data works
- [ ] Theme switching works without flash
- [ ] Invite code deletion works

### UI Testing
- [ ] Design system looks correct
- [ ] Dark mode works properly
- [ ] All pages render correctly
- [ ] No console errors
- [ ] Mobile responsive still works

### Integration Testing
- [ ] Bank sync still works
- [ ] API endpoints still work
- [ ] Background jobs still work
- [ ] Email sending still works

---

## Rollback Procedures

If something goes wrong:

### Rollback Single File
```bash
# Restore from backup branch
git checkout backup/pre-upstream-sync-TIMESTAMP -- path/to/file
```

### Rollback Entire Integration
```bash
# Return to backup
git checkout backup/pre-upstream-sync-TIMESTAMP
git branch -D feature/upstream-sync-v0.6.4
```

### Rollback Specific Commit
```bash
# Revert a cherry-picked commit
git revert <commit-sha>
```

---

## Completion Checklist

- [ ] All design system improvements applied
- [ ] All configuration files updated
- [ ] All documentation updated
- [ ] All view/layout updates applied
- [ ] All dependencies updated
- [ ] All automated tests pass
- [ ] All features manually tested
- [ ] No regressions found
- [ ] CHANGELOG.md updated
- [ ] PR created for review

---

## Support

If you encounter issues:
1. Check the rollback procedures above
2. Review the UPSTREAM_SYNC_STRATEGY.md document
3. Test in isolation (create test branch)
4. Document any conflicts or issues
5. Seek review before merging to main
