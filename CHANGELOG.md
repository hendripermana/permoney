# Changelog

## [0.7.0](https://github.com/hendripermana/permoney/compare/v0.6.0...v0.7.0) (2025-10-31)


### Features

* implement comprehensive performance optimization ([a1d0b3c](https://github.com/hendripermana/permoney/commit/a1d0b3ca1cc1f0263d4b25a9d8984ff2bd988dec))


### Bug Fixes

* resolve Rails 8 compatibility issues ([7de44e7](https://github.com/hendripermana/permoney/commit/7de44e792b747ebfd4d8b9a290cfbe109780fc18))
* use Puma single mode in development to avoid macOS fork issues ([3a5f2df](https://github.com/hendripermana/permoney/commit/3a5f2dffe4647c60620e2027650c08b1f4822d69))
* use system jemalloc instead of deprecated gem ([bf15343](https://github.com/hendripermana/permoney/commit/bf15343f2df1a8c39ab2fcb9ee482e637f7fdf37))

## [0.6.0](https://github.com/hendripermana/permoney/compare/v0.5.0...v0.6.0) (2025-10-19)


### Features

* add database restore script and documentation ([29e6991](https://github.com/hendripermana/permoney/commit/29e6991a82bac3e3fd1daba8e9a308ab781a0947))


### Bug Fixes

* Check user's theme preference during page load ([#156](https://github.com/hendripermana/permoney/issues/156)) ([6a5c85f](https://github.com/hendripermana/permoney/commit/6a5c85f109939368a0a22588526df3c61819c72b))

## [Unreleased]

### Added - Upstream Sync v0.6.4

- **Langfuse AI Tracking Integration** - Track AI chat sessions and users for better monitoring
- **Account Reset with Sample Data** - Quick demo setup and testing workflow
- **Invite Codes Deletion** - Ability to delete unused invite codes
- **New Date Format Options** - Added 10-year period view and new date formats
- **AI Debug Mode** - Exposed AI_DEBUG_MODE for better development experience
- **Codex Environment Script** - Added bin/codex-env for Codex integration
- **Docker Image Tagging** - Tag latest image on release for better versioning

### Improved - Upstream Sync v0.6.4

- **Password Reset UX** - Added back button for better user flow
- **Theme Preference** - Fixed theme check on page load to prevent flash
- **Selection Bar Styles** - Improved contrast and semantic token usage
- **Plaid Configuration** - Added dummy credentials for better onboarding
- **LLM Context** - Cleaned up cursor rules for better AI context

### Security - Upstream Sync v0.6.4

- **rexml** - Bumped from 3.4.1 to 3.4.2 (security vulnerability patch)

### Documentation - Upstream Sync v0.6.4

- **Upstream Sync Strategy** - Comprehensive integration documentation
- **Interactive Tools** - Added bin/upstream-sync and bin/analyze-upstream-commits
- **Integration Guides** - Detailed manual integration and quick start guides
- **Completion Report** - Full analysis and results documentation

### Maintenance - Upstream Sync v0.6.4

- **Code Quality** - Auto-fixed 414 rubocop offenses
- **Orphaned Assets** - Removed unused SVG assets for cleaner repository

### Notes

This release integrates 16 upstream improvements from we-promise/sure (v0.6.4) while preserving ALL Permoney features:

- ✅ Loan Management System (fully preserved)
- ✅ Personal Lending System (fully preserved)
- ✅ Pay Later/BNPL System (fully preserved)
- ✅ Indonesian Finance Features (fully preserved)
- ✅ Permoney Branding (fully preserved)

See `docs/UPSTREAM_SYNC_COMPLETION_REPORT.md` for detailed integration report.

## [0.5.0](https://github.com/hendripermana/permoney/compare/v0.4.1...v0.5.0) (2025-10-19)

### Features

- add loan reminders job and enhance loan schedule options in forms ([f1624c7](https://github.com/hendripermana/permoney/commit/f1624c771b5bd44d8827fd74e779a5b04a6ca139))
- add rate suggestion text and logic for display based on sharia, personal, or institutional modes ([cfe82d2](https://github.com/hendripermana/permoney/commit/cfe82d28347c1f03cd1b3d9f56560dc95662a7f4))
- add tooltips and helper for loan form fields, and existing loan toggle in the form component. ([fbb209d](https://github.com/hendripermana/permoney/commit/fbb209dd0e3e07a628800e2c5e57456b294e393c))
- enhance loan feature with comprehensive improvements ([4fc6631](https://github.com/hendripermana/permoney/commit/4fc66311f587f4604592ac71d61d2b71071a14a4))
- enhance loan form with smart UX improvements ([939d7e6](https://github.com/hendripermana/permoney/commit/939d7e6069c87ee6bcc837b691910eb5b8d151bf))
- enhance select and collection_select methods with better config handling and include_blank support ([ef622d8](https://github.com/hendripermana/permoney/commit/ef622d8676fe69957fe63dcef3f689ef1a069de8))

### Bug Fixes

- correct data-action attribute in loan form ([09460c1](https://github.com/hendripermana/permoney/commit/09460c12729f1a4c56c0ff3f9ced23923e0fac76))
- show rate suggestion only on 'terms' step ([ef98463](https://github.com/hendripermana/permoney/commit/ef98463bf1a4c463fae0dc1abef3fff2b20ca220))
- update loan form tooltips and modify loan wizard behavior to streamline next/submit actions. ([0d39ef2](https://github.com/hendripermana/permoney/commit/0d39ef23359efa5c1f794c432202e5435cca0730))

## [0.4.1](https://github.com/hendripermana/permoney/compare/v0.4.0...v0.4.1) (2025-09-20)

### Bug Fixes

- **data_cleaner:** remove when cleaning demo data ([1213da1](https://github.com/hendripermana/permoney/commit/1213da1c16f70b5efad825dc5d067f84805012bc))
- **data_cleaner:** remove when cleaning demo data ([6286ff0](https://github.com/hendripermana/permoney/commit/6286ff04d3229763a3aa44e558da72acdeeb10ab))

## [0.4.0](https://github.com/hendripermana/permoney/compare/v0.3.1...v0.4.0) (2025-09-20)

### Features

- adding IDR demo data ([47e4c40](https://github.com/hendripermana/permoney/commit/47e4c40af994caa8ba67b99294b0d5796893ccab))
- adding IDR demo data ([a26b1b9](https://github.com/hendripermana/permoney/commit/a26b1b9b3e3149355a771c12fa9e00a96059e315))
- **demo:** add loan proceeds, use transfers for investments, ([2eed0b2](https://github.com/hendripermana/permoney/commit/2eed0b276f23448ad46029e546d09c579e13265a))
- **demo:** generate realistic IDR demo data and fix amounts ([dcc81d5](https://github.com/hendripermana/permoney/commit/dcc81d50e3eb559ce9f106b754b9a373c876460d))

### Bug Fixes

- **demo:** use transfers for loan originations and improve data cleanup ([12a6693](https://github.com/hendripermana/permoney/commit/12a6693f1f3190a322442bda8b57ca35be9cec59))

## [0.3.1](https://github.com/hendripermana/permoney/compare/v0.3.0...v0.3.1) (2025-09-19)

### Bug Fixes

- **auth:** remove redundant redirect-loop checks in auth controllers ([6045193](https://github.com/hendripermana/permoney/commit/60451935d542925d36cbc0db06dc002b67a1298f))
- **onboarding:** prevent redirect loops and tidy ([ba47c90](https://github.com/hendripermana/permoney/commit/ba47c90be7c3bc1534e48bbd311bed0e706cdc95))
- **onboarding:** prevent redirect loops and tidy ([daced15](https://github.com/hendripermana/permoney/commit/daced1526399d86af3cf0ddf8d5aed278a9f5266))

## [0.3.0](https://github.com/hendripermana/permoney/compare/v0.2.1...v0.3.0) (2025-09-18)

### Features

- Comprehensive Borrowed Loans Enhancement with Schedule Management ([89942f3](https://github.com/hendripermana/permoney/commit/89942f399b5810d979426f7805c5de49722ead34))
- Comprehensive Borrowed Loans Enhancement with Schedule Management ([4bbe830](https://github.com/hendripermana/permoney/commit/4bbe8308365061b38c3f9844e83fcfbcec6e4e2d))
- Enhance loan management with accurate balance calculations and improved UX ([426ed05](https://github.com/hendripermana/permoney/commit/426ed05b5efad74ef98eab9b4d93f6f316806558))
- **loan:** create transfer-driven entries and adjust tests ([f9ea6d9](https://github.com/hendripermana/permoney/commit/f9ea6d9881dc68f8418e26c56b50ca261eb37837))
- **loans:** add balloon support and normalize rates; improve posting ([e28c596](https://github.com/hendripermana/permoney/commit/e28c596af4b54e274c3d465f1af625904d516a98))
- **loans:** enhance schedule preview UI and loan form behavior ([1272e0f](https://github.com/hendripermana/permoney/commit/1272e0f3db70f6859c4fed4b0bf4ea358e476210))

### Bug Fixes

- Add defensive programming to API controller ([d6d12f0](https://github.com/hendripermana/permoney/commit/d6d12f067378d599beac95a688af8cbc8f6df2e3))
- Address all PR code review suggestions ([a951bdb](https://github.com/hendripermana/permoney/commit/a951bdbf6b5474f35b3718e3de370e5142964ab6))
- Address all PR code suggestions for improved robustness ([6ba7ced](https://github.com/hendripermana/permoney/commit/6ba7cedc7b40e4d5eeba2d66a46c34390a52dae0))
- Address all PR code suggestions for improved robustness ([d49491b](https://github.com/hendripermana/permoney/commit/d49491b9039a934237e8f9a871e2cd3636f85e60))
- Address HTTP verb confusion warning ([8a998c2](https://github.com/hendripermana/permoney/commit/8a998c23b96df835d020cb8480cef956c4400a6e))
- Correct borrowing transaction amount for proper balance calculation ([c97af3d](https://github.com/hendripermana/permoney/commit/c97af3d14ffb2a033ebbb04a4fb64c1981ab9c66))
- Force synchronous account sync for immediate balance update ([3e45c0f](https://github.com/hendripermana/permoney/commit/3e45c0f829cbbfbe9b6589f2aaf77bdee7f6bca4))
- Resolve loan creation test failures ([f4516ca](https://github.com/hendripermana/permoney/commit/f4516ca14756948292d84ebc40ebc8bf325049f4))
- Resolve test failures and route issues ([c586fa0](https://github.com/hendripermana/permoney/commit/c586fa0c412782ef0f677acc7fabd843a5cc91ff))
- **schema:** normalize array literal in virtual column expression ([bf0f0b8](https://github.com/hendripermana/permoney/commit/bf0f0b84183b22f3eac8ea4ab48f9ba631198c64))
- Update loan principal amount when additional borrowing occurs ([d50c2ef](https://github.com/hendripermana/permoney/commit/d50c2ef4e4db9bc5b4fb0dc80a968ebb2c53a81f))

## Unreleased

Added

- Borrowed Loans improvements:
  - New Loan subtypes: LOAN_PERSONAL and LOAN_INSTITUTION (display labels: Borrowed (Person) / Borrowed (Institution)).
  - Add-only loan metadata fields (principal, tenor, frequency, method, rate/profit, institution/contact details, notes, JSON extras).
  - Schedule preview endpoint and UI (feature-flagged).
  - Planned installments table with posting service that splits principal vs interest/profit using existing Transfer/Transaction engine.
  - System categories by key with fallback to name, seeded on demand.
  - Partial unique index preventing double-posting installments; plan regeneration replaces only future rows.
  - Optional extra payment service behind feature flag to recompute future schedule.
  - Late Fee/Admin Fee category keys and optional late fee posting support.
  - API endpoint to safely regenerate future schedule with concise payload.
