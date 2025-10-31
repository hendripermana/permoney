# Upstream Cherry-Pick Strategy

## Status

**Last cherry-picked commit:** `4ae02eeb49545f570f078bde9bd446730a5f5c4d` - "Tag latest image on release (#162)"

**Upstream repository:** https://github.com/we-promise/sure

**Total commits to cherry-pick:** 66 commits

**Date:** October 31, 2025

## CI/CD Configuration

### Current Setup
- **Repository:** `ghcr.io/hendripermana/permoney`
- **Workflow:** Uses `DOCKER_IMAGE_NAME` GitHub variable to override image name
- **Status:** ✅ Already configured correctly in `.github/workflows/publish.yml`

### Important Notes
- Our workflow is MORE ADVANCED than upstream (we have `PUBLISH_IMAGE` support)
- When cherry-picking workflow commits, **DO NOT** replace our workflow
- Always verify that workflow changes maintain `ghcr.io/hendripermana/permoney` target
- Check `.github/workflows/publish.yml` line 40: `PUBLISH_IMAGE: ${{ vars.DOCKER_IMAGE_NAME || github.repository }}`

## Cherry-Pick Priority

### Phase 1: Low Risk - Bugfixes & Security (✅ Start Here)

These commits are safe to cherry-pick directly:

1. **369ae8a6** - Fix "invisible" merchants (#262)
   - ⚠️ **CONFLICT DETECTED**: File `app/models/simplefin_entry/processor.rb` exists locally but not in git
   - **Action**: Manual merge needed - file already has similar code, verify changes match
   
2. **b24b1026** - Fix rounding issue (#226)
   - File: `app/models/transaction/search.rb`
   - Risk: LOW
   
3. **4ba8f323** - Fix production OIDC regression
   - File: `config/initializers/omniauth.rb` (1 line removal)
   - Risk: LOW
   
4. **d51ba515** - Fix Twelve Data API parsing errors (#224)
   - Risk: LOW
   
5. **a8f318c3** - Fix "Messages is invalid" error for Ollama/custom LLM providers (#225)
   - Risk: LOW
   
6. **4cd737b5** - Fix SimpleFin investment holdings (#104)
   - Risk: LOW
   
7. **eaa17fe9** - Bump rack from 3.1.16 to 3.1.18 (#198)
   - Risk: LOW (security update)
   
8. **24cf830c** - Bump rexml from 3.4.1 to 3.4.2 (#148)
   - Risk: LOW (security update)
   
9. **2716fad7** - Fix theme preference check during page load (#156)
   - Risk: LOW

### Phase 2: Medium Risk - Features (Test One by One)

10. **96713ee8** - Add support for dynamic config UI (#256)
    - Risk: MEDIUM
    - May affect settings/system configuration
    
11. **9fefe57d** - Feature/yahoo finance (#123)
    - Risk: MEDIUM
    - New feature integration
    
12. **768e85ce** - Add OpenID Connect login support (#77)
    - Risk: MEDIUM
    - Authentication changes
    
13. **49994090** - Implement an outflows section (#220)
    - Risk: MEDIUM
    - UI/UX changes
    
14. **192a3b68** - Implement a filter for category (#215)
    - Risk: MEDIUM
    
15. **8cd109a5** - Implement support for generic OpenAI api (#213)
    - Risk: MEDIUM
    
16. **0b393a0d** - Add custom S3 support storage config option (#239)
    - Risk: MEDIUM
    - Configuration changes

### Phase 3: High Risk - Manual Merge Required

17. **ed99a4dc** - Tag latest image on release (#162)
    - ⚠️ **ALREADY APPLIED** - This is our base commit!
    - **Action**: SKIP
    
18. **7c5ddd67** - Make branding configurable (#173)
    - Risk: HIGH
    - May affect our branding configuration
    - Check `app/models/setting.rb` and branding-related code

### Phase 4: Documentation & Minor Updates

19. **3f4330ee** - Update AI assistant documentation with version caution
20. **962ddd15** - Refresh README with new logo and LLM conversation
21. **60f54f9b** - doc: added copilot instructions (#130)

### Phase 5: Environment & Configuration

22. **0fc70e90** - Add runServices for db and redis in devcontainer
23. **53adc4f2** - Expose AI_DEBUG_MODE in .env.local.example
24. **617876f1** - Add dummy PLAID_CLIENT_ID and PLAID_SECRET to env (#165)

## Conflict Resolution Strategy

### Known Conflicts

1. **SimpleFin Processor** (`app/models/simplefin_entry/processor.rb`)
   - Status: File exists locally but not in git history
   - Upstream change: Uses `import_adapter.find_or_create_merchant`
   - Local status: Already has similar code
   - Action: Verify methods match, manually apply if different

2. **Workflow Files** (`.github/workflows/*.yml`)
   - Status: Our workflows are more advanced
   - Action: **DO NOT** replace entire files
   - Action: Manually merge only relevant changes
   - **CRITICAL**: Always preserve `PUBLISH_IMAGE: ${{ vars.DOCKER_IMAGE_NAME || github.repository }}`

3. **Branding Configuration**
   - Status: We use `Permoney` branding
   - Action: Skip or carefully merge branding-related commits

## Cherry-Pick Execution Plan

### Step 1: Create Branch
```bash
git checkout -b cherry-pick-upstream-$(date +%Y%m%d)
```

### Step 2: Cherry-Pick Phase 1 (Low Risk)
```bash
# Skip 369ae8a6 (manual merge needed)
git cherry-pick b24b1026  # Fix rounding
git cherry-pick 4ba8f323  # Fix OIDC
git cherry-pick d51ba515  # Fix Twelve Data
git cherry-pick a8f318c3  # Fix Ollama
git cherry-pick 4cd737b5  # Fix SimpleFin
git cherry-pick eaa17fe9  # Bump rack
git cherry-pick 24cf830c  # Bump rexml
git cherry-pick 2716fad7  # Fix theme
```

### Step 3: Test After Phase 1
```bash
bin/rails test
bin/rubocop -f github -a
```

### Step 4: Cherry-Pick Phase 2 (Features) - One at a time
```bash
git cherry-pick 96713ee8  # Dynamic config UI
# Test, commit, then continue...
```

### Step 5: Manual Merge Phase 3
- Review each commit manually
- Merge only relevant parts
- Skip workflow changes if they don't improve our setup

## Verification Checklist

After each phase, verify:

- [ ] All tests pass: `bin/rails test`
- [ ] Linting passes: `bin/rubocop -f github -a`
- [ ] Security scan passes: `bin/brakeman --no-pager`
- [ ] Workflow still targets `ghcr.io/hendripermana/permoney`
- [ ] No breaking changes to existing features
- [ ] CI/CD workflows are functional

## Important Files to Monitor

1. `.github/workflows/publish.yml` - Must preserve PUBLISH_IMAGE configuration
2. `app/models/setting.rb` - Branding configuration
3. `config/initializers/*.rb` - Configuration changes
4. `.env.local.example` - Environment variable changes

## Post-Cherry-Pick Actions

1. Create PR from cherry-pick branch
2. Run full test suite
3. Verify CI/CD runs successfully
4. Check that Docker image publishes to correct registry
5. Merge to main after all checks pass

## Notes

- Upstream uses "Sure" branding, we use "Permoney"
- Upstream workflow is simpler than ours
- Our CI/CD setup is more advanced (supports cross-namespace pushes)
- Always prefer our workflow implementation over upstream if there's conflict
