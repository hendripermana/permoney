# Changelog

## [0.2.1](https://github.com/hendripermana/permoney/compare/v0.2.0...v0.2.1) (2025-09-09)


### Bug Fixes

* correct Rails route recognition parameter ([ad68c14](https://github.com/hendripermana/permoney/commit/ad68c14ffb320d338f8bd000e19a37b3b9656650))
* enhance security measures ([9dc9ad9](https://github.com/hendripermana/permoney/commit/9dc9ad91c1349a9776b24693f39680b18273d304))

## [0.2.0](https://github.com/hendripermana/permoney/compare/v0.1.0...v0.2.0) (2025-09-09)


### Features

* Add "amount type" configuration column for CSV imports ([#1947](https://github.com/hendripermana/permoney/issues/1947)) ([c88fe2e](https://github.com/hendripermana/permoney/commit/c88fe2e3b25693432864445002324798329698ea))
* Add Brand Fetch logo link for logos (see [#43](https://github.com/hendripermana/permoney/issues/43)) ([#99](https://github.com/hendripermana/permoney/issues/99)) ([dd0cb60](https://github.com/hendripermana/permoney/commit/dd0cb60b56844e35a64dc7ef13886e70a2867efd))
* Add comprehensive BNPL/PayLater debt account management system ([142f289](https://github.com/hendripermana/permoney/commit/142f28995cee5a735a4ba427e053f0a26c71dbbb))
* Add comprehensive personal lending improvements with Syariah compliance ([b9a634e](https://github.com/hendripermana/permoney/commit/b9a634e98ab2ef2d1a3cbbab7f18017b120b6047))
* Add Indonesian and Sharia-compliant debt management features ([7196102](https://github.com/hendripermana/permoney/commit/7196102c6635dc70fa04f10386b144c70721450b))
* Add New Relic monitoring setup ([6ee2346](https://github.com/hendripermana/permoney/commit/6ee2346548bb5a8d98303914a577e382b32bbebb))
* Add Twelve Data provider for exchange rates and securities ([#2](https://github.com/hendripermana/permoney/issues/2)) ([5bdefe6](https://github.com/hendripermana/permoney/commit/5bdefe6e63d571bc6c56de1a4724e42c95a0fe1e))
* **assistant:** improve chat functionality and update tests - refactor configurable model, update OpenAI provider, enhance chat form UI, and improve test coverage ([#2316](https://github.com/hendripermana/permoney/issues/2316)) ([4f5068e](https://github.com/hendripermana/permoney/commit/4f5068e7e52a3bd1b38d2621cb63b05b23e2a395))
* Complete Permoney rebranding from Maybe/Sure to Permoney ([87b6f5c](https://github.com/hendripermana/permoney/commit/87b6f5c9e1c88ca3df518abbee11002e00face8b))
* **dark mode:** misc design fixes ([#2215](https://github.com/hendripermana/permoney/issues/2215)) ([fb7107d](https://github.com/hendripermana/permoney/commit/fb7107d614c09190bbff060fd9ead023b829f059))
* **devcontainer:** upgrade dev environment with better prompts, extensions, and configs ([#95](https://github.com/hendripermana/permoney/issues/95)) ([1ae9e3e](https://github.com/hendripermana/permoney/commit/1ae9e3e8fb7c875b71ccb75e7242c565f515c7a8))
* implement CI/CD improvements and security enhancements ([f2014a9](https://github.com/hendripermana/permoney/commit/f2014a93f35fb8917a4460bc6b394a4b34cdb55e))
* Implement comprehensive rebranding configuration system ([e3d0698](https://github.com/hendripermana/permoney/commit/e3d06982c56b5ce904b053fea90fe6330d80012b))
* implement critical security and reliability improvements ([7ed3687](https://github.com/hendripermana/permoney/commit/7ed3687c73823d9f0084ba24affbff4663797259))
* Implement Mobile Responsiveness ([#2092](https://github.com/hendripermana/permoney/issues/2092)) ([65e1bc6](https://github.com/hendripermana/permoney/commit/65e1bc6eddd30018f3f7b5778ce107119e84f236))
* introduce multi-arch build matrix and OCI-compliant multi-arch images ([#46](https://github.com/hendripermana/permoney/issues/46)) ([a14b053](https://github.com/hendripermana/permoney/commit/a14b0535ece8629feb9a352ae853854bf9342438))
* **loans:** add debt origination fields and UI; wire disbursement account; improve feedback and app version UI\n\n- Migration: add debt_kind, counterparty_type, counterparty_name, disbursement_account_id (FK to accounts), origination_date to loans; add indexes\n- Model: validations and associations for new fields; service object for origination data\n- Controller: permit new params; integrate DebtOriginationService\n- Views: extend loan form for counterparty + disbursement account; small polish for feedback page, app version, and user menu\n- Misc: remove obsolete lib/maybe.rb; keep backups/ out of git\n\nNotes:\n- Backfilled handling is safe; fields are optional and nullable\n- No behavior change for existing loans until edited; migration is additive\n- Tested locally with Minitest pages_controller tests and manual form submissions ([e257b18](https://github.com/hendripermana/permoney/commit/e257b18124ea9f71ad3c8611dd33fcb2e1ce558e))
* **loans:** add debt origination fields and UI; wire disbursement account; improve feedback and app version UI\n\n- Migration: add debt_kind, counterparty_type, counterparty_name, disbursement_account_id (FK to accounts), origination_date to loans; add indexes\n- Model: validations and associations for new fields; service object for origination data\n- Controller: permit new params; integrate DebtOriginationService\n- Views: extend loan form for counterparty + disbursement account; small polish for feedback page, app version, and user menu\n- Misc: remove obsolete lib/maybe.rb; keep backups/ out of git\n\nNotes:\n- Backfilled handling is safe; fields are optional and nullable\n- No behavior change for existing loans until edited; migration is additive\n- Tested locally with Minitest pages_controller tests and manual form submissions ([0faaa8a](https://github.com/hendripermana/permoney/commit/0faaa8a365f8b0f1b5efdb725288c579d752f7ea))
* Major PayLater enhancements - Multi-currency support, compound interest, and advanced features ([27a43f7](https://github.com/hendripermana/permoney/commit/27a43f7acea86bd50a03edeebbaa42735261eb1e))
* Mobile Settings menu with preserve scroll + scroll on connect ([#2278](https://github.com/hendripermana/permoney/issues/2278)) ([092350f](https://github.com/hendripermana/permoney/commit/092350f1f8d21e88a2e9c4ee73c5b68eee029591))
* Only show active accounts for transaction form ([#2484](https://github.com/hendripermana/permoney/issues/2484)) ([347c0a7](https://github.com/hendripermana/permoney/commit/347c0a790693031fdd3b32792b5b6792693d1805))
* rebrand design system from Maybe to Permoney ([8725550](https://github.com/hendripermana/permoney/commit/8725550059c3c175d0a320a99008f0aa941d2369))
* Setup GitHub security and automation best practices ([a81f194](https://github.com/hendripermana/permoney/commit/a81f1949b835ce5a8fb641cb41e0fb62f7ff98d6))
* Show total balance in family currency in accounts ([#2283](https://github.com/hendripermana/permoney/issues/2283)) ([e1b81ef](https://github.com/hendripermana/permoney/commit/e1b81ef879d21658dab0766bc7cc10bb06519ce6))
* sort accounts by name in main page ([#19](https://github.com/hendripermana/permoney/issues/19)) ([aca1da1](https://github.com/hendripermana/permoney/commit/aca1da146f3d44cd3241190eb0a8a93742b8ad1b))
* split provider check and remove hardcoded synth check ([#45](https://github.com/hendripermana/permoney/issues/45)) ([d04c874](https://github.com/hendripermana/permoney/commit/d04c87449d4430e9b3c1060e4986029a7c5a7bcb))


### Bug Fixes

* [#1645](https://github.com/hendripermana/permoney/issues/1645). ([f181ba9](https://github.com/hendripermana/permoney/commit/f181ba941f88d644226da7b469f3600f2b6cdf11))
* add color-mix fallback for browser compatibility ([a27dbbb](https://github.com/hendripermana/permoney/commit/a27dbbb23a35f90f4d31b0b64f54f9ac6f617756))
* add dark mode overlay fallback for cross-browser compatibility ([3acc039](https://github.com/hendripermana/permoney/commit/3acc0399f7e44f490397ee02a5d96f42a5e73f83))
* additional reviewer suggestions ([36e3a80](https://github.com/hendripermana/permoney/commit/36e3a8077ac0dfbf9ecb7842559709265217cfea))
* Address critical Docker and CI workflow issues ([a9c63cf](https://github.com/hendripermana/permoney/commit/a9c63cff68c62f486e5531126ec4f425865aa062))
* address critical reviewer feedback for redirect loop prevention ([45c360d](https://github.com/hendripermana/permoney/commit/45c360dec7dfb3329a0b61b4b527413935074d18))
* address reviewer suggestions ([f682b6c](https://github.com/hendripermana/permoney/commit/f682b6ccfd0b42d3132f421e8f10ba889faa652c))
* apply critical reviewer suggestions for redirect loop prevention ([f1c2c26](https://github.com/hendripermana/permoney/commit/f1c2c26aca23e44e47a78ebcc91ea0ddc7e76f41))
* Changing apply button text to respect theme so it is visible ([#2117](https://github.com/hendripermana/permoney/issues/2117)) ([d22a16d](https://github.com/hendripermana/permoney/commit/d22a16d8dee357308a3b871d9cd4d09c7f3857c9))
* Complete sankey chart responsive design and fullscreen functionality ([ca625cc](https://github.com/hendripermana/permoney/commit/ca625cc0008f62720b87163bc7d931a0c5d7e50d))
* Complete sankey chart responsive design and fullscreen functionality ([e5fbaa3](https://github.com/hendripermana/permoney/commit/e5fbaa3f6036e1c4323f5f49de767021dad2e1a1))
* correct some dark mode ui issues ([#52](https://github.com/hendripermana/permoney/issues/52)) ([66a87c8](https://github.com/hendripermana/permoney/commit/66a87c852c7c703fdd3cc60118d3d808365e6fd6))
* dark mode ui issue for transaction header ([#64](https://github.com/hendripermana/permoney/issues/64)) ([46c31e1](https://github.com/hendripermana/permoney/commit/46c31e19379c2183dc76d41fcea8cf0957acd73f))
* enable onboarding flow for self-hosted users ([af9b3cc](https://github.com/hendripermana/permoney/commit/af9b3ccd37867819ef429f0f8c89eaf23cd4b877))
* Filter categories by transaction type in forms ([#2082](https://github.com/hendripermana/permoney/issues/2082)) ([71bc51c](https://github.com/hendripermana/permoney/commit/71bc51ca157a62a85ef02630252808642c38f13e))
* Fix incorrect entry sorting in activity view ([#2006](https://github.com/hendripermana/permoney/issues/2006)) ([5a8074c](https://github.com/hendripermana/permoney/commit/5a8074c7eeb3847dfdbe8b9526d2911dc5d9e33e))
* Fix unalble to reject automatched transfers ([#2102](https://github.com/hendripermana/permoney/issues/2102)) ([f235697](https://github.com/hendripermana/permoney/commit/f23569717825dea426c515c79580bd15c6d06ddb))
* implement critical suggestions for shim safety and cross-browser compatibility ([d532066](https://github.com/hendripermana/permoney/commit/d532066f70850e0046bced16c090acde44bc4554))
* implement final reviewer suggestions for CSS robustness ([e829362](https://github.com/hendripermana/permoney/commit/e8293629466f2bced43754e78777cd75c5ec5117))
* implement incremental suggestions for fallback robustness ([6fabef1](https://github.com/hendripermana/permoney/commit/6fabef10aeb4b2c9e7a6821e7f01e380fa7ab049))
* implement reviewer suggestions for design system rebranding ([c68c71f](https://github.com/hendripermana/permoney/commit/c68c71f5c4581e17b76388313edee94c513e520f))
* implement robust redirect loop prevention with circuit breaker pattern ([3590868](https://github.com/hendripermana/permoney/commit/3590868630660886179089bc8469609dc323a213))
* improve documentation clarity and shim resilience ([297bc79](https://github.com/hendripermana/permoney/commit/297bc797c0866522781fa5f8094b2a2adf0b72f6))
* mobile responsive category color picker ([#2280](https://github.com/hendripermana/permoney/issues/2280)) ([857436d](https://github.com/hendripermana/permoney/commit/857436d89428f57e51b4096b52449c83bb762a97))
* **models:** use self.id ([#2410](https://github.com/hendripermana/permoney/issues/2410)) ([cea49d5](https://github.com/hendripermana/permoney/commit/cea49d5038ae5d4d4b5ea1a297051243563ccf77))
* No comma when locality is empty (small fix) ([#2111](https://github.com/hendripermana/permoney/issues/2111)) ([6a21f26](https://github.com/hendripermana/permoney/commit/6a21f26d2d006d8f2bd628a870cde87ab806b079))
* remove transaction form controller ([#2279](https://github.com/hendripermana/permoney/issues/2279)) ([2fbd6cb](https://github.com/hendripermana/permoney/commit/2fbd6cbc5d339141b3ea64567fd01d4d1de49e86))
* Resolve CI workflow package manager and CodeQL issues ([4461c50](https://github.com/hendripermana/permoney/commit/4461c508330b66c49fd8c6244f56cfb5f88ea401))
* resolve migration errors and rubocop issues ([6147771](https://github.com/hendripermana/permoney/commit/61477712730ab5066de72c818b9c03bf95e96043))
* resolve redirect loop in managed mode onboarding ([0d0b923](https://github.com/hendripermana/permoney/commit/0d0b923a5a02ab5314d1fc7b2b6266a8a5f149d8))
* Rule notification should not be triggered when category is unassigned ([#2214](https://github.com/hendripermana/permoney/issues/2214)) ([470b753](https://github.com/hendripermana/permoney/commit/470b75383328248780fb95bf97091c921de67c85))
* show user small picture and fallback when loading ([#63](https://github.com/hendripermana/permoney/issues/63)) ([b3af64d](https://github.com/hendripermana/permoney/commit/b3af64dce1662a14f5adfe303abfb29937d33733))
* ticker combobox background and text color ([#2370](https://github.com/hendripermana/permoney/issues/2370)) ([b900cc9](https://github.com/hendripermana/permoney/commit/b900cc927209e3c80f41ccbcbaaed17f0b4b307f))
* **ui:** chart view selector bg color ([#2303](https://github.com/hendripermana/permoney/issues/2303)) ([151bf25](https://github.com/hendripermana/permoney/commit/151bf25d2731aaec8616dab1d15d2c4ae85607e2))
* **ui:** mfa backup codes dark mode ([#2323](https://github.com/hendripermana/permoney/issues/2323)) ([0063921](https://github.com/hendripermana/permoney/commit/0063921de9fb70cd42a76f96c4a9ea3c8c7349dd))
* update account sidebar tab ([#81](https://github.com/hendripermana/permoney/issues/81)) ([ef7d736](https://github.com/hendripermana/permoney/commit/ef7d736409879b01efd62023a5242d7994e7e1b1))


### Performance Improvements

* Add index to sync status ([#2337](https://github.com/hendripermana/permoney/issues/2337)) ([1d2e7fc](https://github.com/hendripermana/permoney/commit/1d2e7fcae0966cb818d0d5d42a34b17d21252ef2))
* **imports:** Bulk import CSV trades ([#2040](https://github.com/hendripermana/permoney/issues/2040)) ([0a17b84](https://github.com/hendripermana/permoney/commit/0a17b84566a962aa13e8894134ba8647d1ba487c))
* **income statement:** cache income statement queries ([#2371](https://github.com/hendripermana/permoney/issues/2371)) ([a5f1677](https://github.com/hendripermana/permoney/commit/a5f1677f60f887aa81fda5027efbac90e3a06c7f))
* **transactions:** add `kind` to `Transaction` model and remove expensive Transfer joins in aggregations ([#2388](https://github.com/hendripermana/permoney/issues/2388)) ([1aae00f](https://github.com/hendripermana/permoney/commit/1aae00f5868fcca439386a5c0881bbacd2ecec89))

## 2025-09-03 [*](https://github.com/hendripermana/permoney/pull/1)

### Added
- Sharia-compliant debt management for loans and credit cards, including Islamic products and validations
- Personal lending account type for informal borrowing/lending with due tracking
- Indonesian-specific categories and Islamic finance transaction types
- Enum and model updates, routes, and migrations supporting new debt and fintech features
