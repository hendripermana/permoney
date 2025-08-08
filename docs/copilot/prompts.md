High-signal prompts for Copilot Chat (paste into Chat to kick off tasks)

- Implement a new read-only page for <resource>
  - Add resourceful route, controller action, and ERB view using existing components. Keep controller skinny and push logic to model.

- Create a reusable ViewComponent for <element> with variants <list>
  - Generate component class, template, and minimal tests. Use Tailwind and accessible attributes. Provide content slots.

- Add a Stimulus controller to <do-thing>
  - Use declarative data-action and targets in ERB. Keep controller lean. Pin in importmap if global.

- Add API endpoint: GET /api/v1/<resource>
  - Inherit from Api::V1::BaseController, authorize_scope!("read"), render JSON with pagination via Pagy.

- Add a model method for <domain logic>
  - Implement in the model or a concern. Write a Minitest that verifies the behavior and mocks boundaries.

- Add a Sidekiq worker to <task>
  - Idempotent perform; log context; unit test with mocha stubs; VCR for HTTP.

- Add DB constraints for <table>
  - Migration with NOT NULL/unique; align AR validations as helpful; tests for constraint behavior.

- Convert <partial> into a ViewComponent
  - Extract to app/components; add initializer args and slots; update views to render the component.
