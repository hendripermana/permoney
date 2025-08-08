Repo-specific instructions for GitHub Copilot

Purpose
- Make Copilot generate code that fits this Rails app’s architecture, conventions, and tooling.
- Keep outputs small, practical, and production-minded. Prefer editing files directly and validating with tests when possible.

Quick profile of this repo
- Framework: Ruby on Rails 7.2 (propshaft, importmap, Hotwire: Turbo + Stimulus, TailwindCSS)
- Ruby: 3.4.4; DB: PostgreSQL; Jobs: Sidekiq + Redis
- Testing: Minitest + fixtures (no RSpec; no factories)
- Frontend: ViewComponent components + ERB views; native HTML elements; Stimulus controllers
- App modes: managed and self_hosted (config.app_mode)
- Key providers: Stripe, Plaid; AI: OpenAI

Global conventions Copilot must follow
1) Authentication/current context
   - Use Current.user and Current.family. Do NOT use current_user/current_family helpers.
   - API controllers live under Api::V1 and have custom auth in Api::V1::BaseController. Respect OAuth and API key flows and scopes.

2) Keep Rails vanilla and simple
   - Minimize new dependencies. Prefer POROs and concerns over service objects. If you must add a gem, justify it and prefer mature, widely used options.
   - Organize business logic primarily in app/models (including concerns). Avoid sprinkling logic into controllers or views.

3) Views, Components, and Stimulus
   - Prefer ViewComponents for reusable or interactive UI; partials for simple, local markup.
   - Use native HTML (dialog, details/summary) and Hotwire patterns. Use Turbo frames/streams where they fit naturally.
   - Stimulus: favor declarative actions/targets in ERB; keep controllers lightweight and single-purpose. Component-scoped controllers (in app/components) should only be used by their component.

4) Testing
   - Use Minitest with fixtures. No RSpec. No factories. Keep fixtures minimal; create edge-case records inline in tests.
   - Test critical paths and domain logic; avoid testing Rails internals or trivial AR behavior. Use mocha for mocks/stubs.

5) Data and providers
   - Use Provided concerns (e.g., ExchangeRate::Provided) and Provider::Registry for “concept” data. Avoid direct registry calls from domain models—go through the model’s Provided concern.

6) i18n and strings
   - For now, hardcode English strings in code you generate. Do not wire up i18n unless explicitly requested.

7) Prohibited/avoid
   - Don’t introduce RSpec/factory_bot. Don’t generate scaffolds that violate conventions. Don’t run rails credentials or auto-run migrations in automated steps. Don’t add client-side single-page frameworks.

Frontend specifics Copilot must honor
- Importmap is used; pin new JS under config/importmap.rb as needed.
- TailwindCSS classes for styling; prefer semantic, accessible markup.
- Use the icon helper (not lucide_icon directly) when adding icons in views.
- Keep Stimulus controllers small (<~7 targets ideally); pass server-computed data via data-* attributes.

Routing & controllers
- Web routes in config/routes.rb are conventional resourceful routes; API under /api/v1 uses JSON and custom auth/scopes.
- Controllers should be skinny. Push domain logic to models/concerns.

Background jobs & rate limiting
- Sidekiq is present. For API keys, see ApiRateLimiter; add X-RateLimit-* headers where appropriate.

Testing checklist Copilot should apply to new code
- Create/extend Minitest tests in test/**/*_test.rb.
- Use fixtures judiciously; add only when broadly reusable.
- Use mocha for mocking boundaries; avoid asserting on irrelevant internal details of collaborators.

Security & data handling
- Mind app_mode (managed vs. self_hosted). Conditional features and provider usage must respect mode.
- Keep credentials and API tokens out of code. Respect VCR/webmock in tests. Use ENV for provider keys.

Performance & safety
- Watch for N+1s around global layouts and frequently-hit pages. Paginate large queries with Pagy when needed.
- Prefer server computations (currency/formatting) and pass results to the frontend.

Directory heuristics for Copilot
- Models, concerns, domain POROs: app/models/**
- Components (ViewComponent): app/components/** with matching templates
- Stimulus controllers: app/javascript/controllers/** (global) and app/components/** for component-scoped ones
- Services: minimal use; present under app/services/** only when necessary
- Tests: test/** mirrors app/** structure

When adding features, follow these playbooks
- See docs/copilot/playbooks.md for task-oriented recipes (models/controllers/views, components, Stimulus, migrations, tests, API endpoints, background jobs).

Local dev quickstart (for reference)
- See README for full steps. Typical: bin/setup, bin/dev, optional rake demo_data:default.

Non-negotiable rules (repeat)
- Use Current.user/Current.family. No RSpec/factories. Keep business logic in models/concerns. Prefer components over partials for reusable UI. Stimulus is declarative. Keep i18n out of generated code unless asked.

Helpful links inside this repo
- Conventions and design: .cursor/rules/* (project-conventions.mdc, project-design.mdc, view_conventions.mdc, stimulus_conventions.mdc, testing.mdc)
- Routes: config/routes.rb; API base: app/controllers/api/v1/base_controller.rb
- Components: app/components/**; Stimulus: app/javascript/controllers/**
