# Testing

Permoney splits tests by blast radius so ledger work can prove correctness
without slowing down every local feedback loop.

## Commands

```bash
vp test run                  # default unit suite
vp run test:unit             # explicit unit suite
vp run test:unit:coverage    # unit suite plus M2 finance-domain coverage gate
vp run test:integration      # real Postgres integration suite
vp run test:e2e              # Playwright browser E2E suite
vp run test:ci               # CI-safe unit + integration gate
```

Unit tests must keep importing Vitest utilities from `vite-plus/test`.
Integration tests use their own config at `vitest.integration.config.ts` and
live under `tests/integration/**/*.integration.ts`, so `vp test run` remains
the fast default unit path. The default suite is intentionally scoped to
`src/**/*.test.*` and `scripts/**/*.test.mjs`; local agent/cache worktrees such
as `.kilo/**` and `.kilocode/**` are excluded.

## Test Stack Roles

Each layer has a different source-of-truth boundary:

- Vite+/Vitest unit tests cover fast pure logic and finance-domain helpers.
- Real Postgres integration tests cover ledger, RLS, idempotency, balance,
  audit, and database-constraint invariants.
- Playwright covers deterministic browser E2E flows: routing, auth,
  onboarding, hydration, TanStack DB preload, and browser-bundle safety.
- TestSprite, or an equivalent AI test generator, is supplemental exploratory
  automation. It may discover regression candidates, but it is not a coverage
  gate and is not proof that Permoney is correct.

Generated or exploratory test output must never replace the deterministic
tests above. A PR may cite TestSprite findings as discovery evidence, but the
merge-blocking evidence must be a committed unit, integration, or Playwright
test that reviewers can run with Vite+.

## Coverage Gates

Vitest coverage runs through Vite+ with the V8 provider:

```bash
vp run test:unit:coverage
```

The unit coverage gate is intentionally narrow. It measures pure finance-domain
logic where a regression can corrupt balances or user-visible money semantics:

- `src/lib/currency.ts`
- `src/lib/money.ts`
- `src/lib/split-parity.ts`
- `src/lib/transaction-filters.ts`

These files must keep at least 90% line coverage and 90% branch coverage. This
is a real invariant gate, not a vanity whole-app percentage. Generated code,
test helpers, scripts, Playwright tests, integration fixtures, and the generated
route tree (`src/routeTree.gen.ts`) are excluded so they cannot inflate the
number.

UI components are not line-coverage gated for M2. Browser safety is covered by
deterministic Playwright flows instead. Server ledger paths such as
`src/server/transactions.ts`, RLS helpers, idempotency, and audit behavior must
be covered by real Postgres integration tests before M2 closes; mocked Prisma
does not prove those invariants.

Any M2 PR that touches ledger mutation, balance updates, RLS, idempotency,
audit logging, or auth guards must include deterministic tests in the relevant
suite. If an existing test already covers the change, the PR must explicitly
name that test and explain the invariant it proves.

## Browser E2E Baseline

Playwright is the deterministic browser E2E runner for M2 route safety. The
suite lives in `tests/e2e/**/*.e2e.ts` and starts the app through
`playwright.config.ts` on `http://127.0.0.1:3010` by default. It creates an
isolated real Postgres database through the same harness used by integration
tests, applies migrations, runs the app with the non-superuser runtime role,
and drops the database during teardown.

First-time local browser install:

```bash
vp exec playwright install chromium
```

Local workflow:

```bash
vp run db:up
PERMONEY_TEST_ADMIN_PASSWORD=<local docker password> vp run test:e2e
```

Supported E2E environment variables:

- `PERMONEY_E2E_PORT`: override the managed app port. Defaults to `3010`.
- `PERMONEY_E2E_BASE_URL`: run tests against an already-running app instead of
  starting the managed Playwright web server.
- `PERMONEY_TEST_*`: same database harness variables documented below for
  integration tests.

The E2E gate must not depend on manual browser setup. Tests create users through
the UI and verify the canonical onboarding contract: signup creates an
authenticated user without a family, guided onboarding creates the family, and
protected routes redirect until onboarding is complete.

The suite fails if the browser emits console/page errors containing known
server-client boundary regressions such as `SECURITY BREACH`,
`PrismaClient is unable to run in this browser`, `renderRouterToString`,
`node:stream/web`, `react-dom/server.browser.js`, or
`Calling 'require' for '.prisma/client/index-browser'`.

## Postgres Integration Harness

Ledger, RLS, idempotency, balance, and audit tests must use the real Postgres
harness in `tests/integration/support/database.ts`. Mocked Prisma is not valid
for ledger correctness.

Local workflow:

```bash
vp run db:up
PERMONEY_TEST_ADMIN_PASSWORD=<local docker password> vp run test:integration
```

The harness creates a fresh database named `permoney_test_*`, applies Prisma
migrations through the local Prisma CLI with an absolute Node entrypoint, and
drops the database after the suite. It sets `DATABASE_URL` to the generated test
database before Prisma is created. For generated databases, migrations run through the admin
connection, then the harness creates a separate non-superuser runtime role and
connects Prisma with that role so Postgres RLS cannot be bypassed by test setup.

Supported environment variables:

- `PERMONEY_TEST_DATABASE_URL`: use a pre-created database. The database name
  must start with `permoney_test_`, and the connection role must not be a
  superuser or `BYPASSRLS` role.
- `PERMONEY_TEST_ADMIN_DATABASE_URL`: admin connection used to create isolated
  databases. Defaults to local docker compose Postgres at
  `postgres://permoney@localhost:5433/postgres`.
- `PERMONEY_TEST_ADMIN_PASSWORD`: optional password applied to
  `PERMONEY_TEST_ADMIN_DATABASE_URL` when CI or a local test runner should keep
  the URL password-free.
- `PERMONEY_ALLOW_REMOTE_TEST_DATABASE=1`: required before the harness creates
  a database on a non-local Postgres host.

The harness refuses to run against a non-test database name. If the ambient
`DATABASE_URL` points at any non-test database, the suite fails before
migrations or Prisma queries run. Leave `DATABASE_URL` unset for integration
tests unless it points at a dedicated `permoney_test_*` database; use
`PERMONEY_TEST_ADMIN_DATABASE_URL` for database creation privileges.

## Isolation And Factories

Each integration test calls `harness.reset()`, which truncates app tables with
`RESTART IDENTITY CASCADE`. Tests must create their own data through factories
instead of depending on shared seeds.

Factory coverage lives in `tests/integration/support/factories.ts`:

- Family
- User
- Better Auth Session plus signed request headers
- Account
- Category
- Merchant
- Transaction
- UUIDv7 idempotency keys

Tenant-scoped fixture rows are created through `harness.withFamily(...)`, which
sets `app.family_id` with `set_config(..., true)` inside the same transaction.
That keeps RLS enabled and transaction-scoped for the test path.

## Server Function Tests

Use the authenticated factory helpers when a test needs to call server logic:

```ts
const owner = await factories.createAuthenticatedOnboardedUser()

owner.request.headers.get("cookie")
owner.serverContext.user
owner.serverContext.session
owner.serverContext.familyId
```

Use `createAuthenticatedUserWithoutFamily()` for onboarding and auth-boundary
tests where the session exists but `user.familyId` is `null`. This is the
canonical signup state: signup creates an authenticated user only, and guided
onboarding creates the family later.

Onboarding contract tests should cover both sides of the route boundary:
authenticated users without `familyId` are redirected away from protected app
routes, and onboarded users may enter `/dashboard` and `/transactions`.
Initializer tests should use real Postgres and verify replay does not create
duplicate family or future demo ledger rows.

## CI

CI exposes separate pass/fail status checks for each gate:

- `check`: formatting, linting, type-checking, no-`useEffect`, and auth-stub
  guards.
- `test:unit`: Vitest unit tests plus the finance-domain coverage gate.
- `test:integration`: real Postgres integration tests.
- `test:e2e`: Playwright browser route/auth/bundle regression tests with a
  real Postgres database.
- `build`: production build smoke test.

The integration and E2E jobs each start a Postgres service, create isolated
`permoney_test_*` databases through the harness, and run:

```bash
vp run test:integration
vp run test:e2e
```

Browser E2E tests should stay in `tests/e2e/**/*.e2e.ts`. Keep this suite small
enough for PR confidence, deterministic enough for CI, and strict enough to
catch auth-route, hydration, TanStack DB preload, and browser-bundle regressions.

## Supplemental TestSprite Workflow

TestSprite can be used to explore the app and propose candidate browser flows.
Use it as a discovery tool with this workflow:

1. Run TestSprite against a disposable local or preview environment, never
   against production data.
2. Save the prompt, app URL, app state, generated steps, and failure output in
   the related Linear issue or PR notes.
3. Triage each finding against Permoney's test boundaries:
   - browser-only route, hydration, and interaction issues become Playwright
     candidates;
   - ledger, RLS, idempotency, balance, audit, and database-law issues become
     real Postgres integration candidates;
   - pure formatting, parsing, money, or filter issues become unit-test
     candidates.
4. An engineer or agent must review the generated flow against the relevant
   invariant before committing any test.
5. Commit only deterministic exported tests or hand-written equivalents in the
   repo. Proprietary TestSprite output must not be required for CI unless it has
   been converted into a deterministic test that runs through Vite+.

Example: TestSprite explores signup, onboarding, and first navigation to
`/transactions`, then reports that a reload after onboarding shows a blank page.
Treat that as a candidate route/hydration regression, not as proof. Review the
flow against the onboarding contract in this document, then add or update a
Playwright test under `tests/e2e/**/*.e2e.ts` that:

- signs up through the UI;
- completes guided onboarding;
- reloads `/transactions`;
- asserts the page is usable and protected-route redirects are correct; and
- fails on known server-client boundary console errors.

If the same exploratory run also claims that account balances are wrong after a
transaction mutation, do not encode that as a shallow browser assertion alone.
Map it to the ledger invariant and add a real Postgres integration test that
proves the balance, audit, idempotency, and tenant-scoping behavior at the
database boundary.

Agents must not claim test coverage is complete just because TestSprite or any
AI-generated test suite ran successfully. The claim is only valid when the
relevant deterministic Vite+/Vitest, real Postgres integration, or Playwright
test has been committed and verified.
