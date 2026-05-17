# Testing

Permoney splits tests by blast radius so ledger work can prove correctness
without slowing down every local feedback loop.

## Commands

```bash
vp test run                  # default unit suite
vp run test:unit             # explicit unit suite
vp run test:integration      # real Postgres integration suite
vp run test:e2e              # browser E2E suite, currently allowed to be empty
vp run test:ci               # CI-safe unit + integration gate
```

Unit tests must keep importing Vitest utilities from `vite-plus/test`.
Integration tests use their own config at `vitest.integration.config.ts` and
live under `tests/integration/**/*.integration.ts`, so `vp test run` remains
the fast default unit path. The default suite is intentionally scoped to
`src/**/*.test.*` and `scripts/**/*.test.mjs`; local agent/cache worktrees such
as `.kilo/**` and `.kilocode/**` are excluded.

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

CI runs the fast unit suite separately from the Postgres integration suite. The
integration job starts a Postgres service, creates isolated `permoney_test_*`
databases through the harness, and runs:

```bash
vp run test:integration
```

Heavier browser E2E tests should stay in `tests/e2e/**/*.e2e.ts` and must not
depend on manual login or clicks outside the runner.
