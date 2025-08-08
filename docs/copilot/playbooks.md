Copilot Playbooks for this repo

Use these quick recipes when generating code. Keep patches minimal and follow the repo conventions.

See also: github MCP setup at docs/copilot/github-mcp.md

1) Add a new ViewComponent
- Files:
  - app/components/<name>_component.rb
  - app/components/<name>_component.html.erb
  - Optional: app/components/<name>_component.js (Stimulus if component-specific)
  - Tests: test/components/<name>_component_test.rb (if logic is meaningful)
- Rules:
  - Expose a clear, small API via initializer args and content slots.
  - Use Tailwind classes; keep accessibility in mind (labels, aria-*, roles).
  - If a controller is needed, keep it scoped to the component; do not reuse in app/views unless intended.

2) Add a new page or action (MVC)
- Steps:
  - Route: config/routes.rb (resourceful if possible)
  - Controller: app/controllers/<resource>_controller.rb
    - Keep thin; call model methods or POROs.
  - View: app/views/<resource>/<action>.html.erb
    - Prefer components; avoid heavy logic in ERB.
  - Model: app/models/** for domain logic and validations.
  - Tests: controller/integration/system tests as needed; model tests for logic.

3) Add/modify a Stimulus controller
- Files:
  - Global controller: app/javascript/controllers/<name>_controller.js
  - Component controller: app/components/<component>/<name>_controller.js
- Rules:
  - Declarative usage in ERB: data-controller, data-action, data-*-target/value.
  - Keep under ~7 targets; small public API; avoid domain logic.
  - Pin in config/importmap.rb if adding a new global controller file.

4) Add an API endpoint under /api/v1
- Steps:
  - Controller in app/controllers/api/v1/<resource>_controller.rb inheriting from Api::V1::BaseController.
  - Force JSON; authorize required scope(s) via authorize_scope!("read"|"write").
  - Respect API key rate limiting headers where relevant.
  - Tests under test/controllers/api/v1/**.

5) Add a background job or async task
- Prefer Sidekiq workers under app/jobs or POROs called by existing jobs.
- Keep inputs explicit and idempotent; log with sufficient context.
- Add tests for the job’s behavior; mock external providers.

6) Migrations and schema changes
- Create db/migrate/* with minimal changes.
- Add AR-level validations if they help UX, but enforce null/unique at DB level.
- Backfill data in reversible steps or follow-up migrations when needed.
- Add tests for new validations/behaviors.

7) Provider concept integration
- Add/extend Provided concern under the model’s namespace (e.g., app/models/exchange_rate/provided.rb).
- Register concrete provider under Provider::Registry; return Provider::ProviderResponse.
- Do not call the registry directly from domain code; use the Provided concern.

8) Testing patterns
- Unit tests for models and POROs.
- Controller/integration tests for endpoints; system tests sparingly.
- Use mocha for stubs/mocks; fixtures minimal and representative.
- Avoid testing ActiveRecord internals or trivial getters/setters.

9) Performance hygiene
- Avoid N+1 queries in hot paths and global layouts.
- Paginate with Pagy when lists can grow.
- Push expensive formatting to server and cache if viable.

10) Security & modes
- Consider app_mode (managed vs self_hosted) for feature flags and providers.
- Keep secrets in ENV/credentials (never committed). Tests should use VCR/webmock.
