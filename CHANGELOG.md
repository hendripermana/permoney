# Changelog

## [0.3.0](https://github.com/hendripermana/permoney/compare/v0.2.1...v0.3.0) (2025-09-18)


### Features

* Comprehensive Borrowed Loans Enhancement with Schedule Management ([89942f3](https://github.com/hendripermana/permoney/commit/89942f399b5810d979426f7805c5de49722ead34))
* Comprehensive Borrowed Loans Enhancement with Schedule Management ([4bbe830](https://github.com/hendripermana/permoney/commit/4bbe8308365061b38c3f9844e83fcfbcec6e4e2d))
* Enhance loan management with accurate balance calculations and improved UX ([426ed05](https://github.com/hendripermana/permoney/commit/426ed05b5efad74ef98eab9b4d93f6f316806558))
* **loan:** create transfer-driven entries and adjust tests ([f9ea6d9](https://github.com/hendripermana/permoney/commit/f9ea6d9881dc68f8418e26c56b50ca261eb37837))
* **loans:** add balloon support and normalize rates; improve posting ([e28c596](https://github.com/hendripermana/permoney/commit/e28c596af4b54e274c3d465f1af625904d516a98))
* **loans:** enhance schedule preview UI and loan form behavior ([1272e0f](https://github.com/hendripermana/permoney/commit/1272e0f3db70f6859c4fed4b0bf4ea358e476210))


### Bug Fixes

* Add defensive programming to API controller ([d6d12f0](https://github.com/hendripermana/permoney/commit/d6d12f067378d599beac95a688af8cbc8f6df2e3))
* Address all PR code review suggestions ([a951bdb](https://github.com/hendripermana/permoney/commit/a951bdbf6b5474f35b3718e3de370e5142964ab6))
* Address all PR code suggestions for improved robustness ([6ba7ced](https://github.com/hendripermana/permoney/commit/6ba7cedc7b40e4d5eeba2d66a46c34390a52dae0))
* Address all PR code suggestions for improved robustness ([d49491b](https://github.com/hendripermana/permoney/commit/d49491b9039a934237e8f9a871e2cd3636f85e60))
* Address HTTP verb confusion warning ([8a998c2](https://github.com/hendripermana/permoney/commit/8a998c23b96df835d020cb8480cef956c4400a6e))
* Correct borrowing transaction amount for proper balance calculation ([c97af3d](https://github.com/hendripermana/permoney/commit/c97af3d14ffb2a033ebbb04a4fb64c1981ab9c66))
* Force synchronous account sync for immediate balance update ([3e45c0f](https://github.com/hendripermana/permoney/commit/3e45c0f829cbbfbe9b6589f2aaf77bdee7f6bca4))
* Resolve loan creation test failures ([f4516ca](https://github.com/hendripermana/permoney/commit/f4516ca14756948292d84ebc40ebc8bf325049f4))
* Resolve test failures and route issues ([c586fa0](https://github.com/hendripermana/permoney/commit/c586fa0c412782ef0f677acc7fabd843a5cc91ff))
* **schema:** normalize array literal in virtual column expression ([bf0f0b8](https://github.com/hendripermana/permoney/commit/bf0f0b84183b22f3eac8ea4ab48f9ba631198c64))
* Update loan principal amount when additional borrowing occurs ([d50c2ef](https://github.com/hendripermana/permoney/commit/d50c2ef4e4db9bc5b4fb0dc80a968ebb2c53a81f))

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
