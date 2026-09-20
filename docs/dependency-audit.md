# Dependency audit posture — and why there is no audit CI job

Measured **2026-09-20** with `vp pm audit -- --audit-level high`:
**13 findings — 1 critical, 8 high, 4 moderate** (`pnpm audit` exits 1).

Every finding is a **transitive dependency of dev/build tooling**, not a
runtime dependency:

| Chain                                         | Reached via                                          | Kind               |
| --------------------------------------------- | ---------------------------------------------------- | ------------------ |
| `@vitest/browser`, `vitest`, `@vitest/mocker` | `@vitest/coverage-v8`                                | test tooling       |
| `postcss`, `nanoid`                           | `@voidzero-dev/vite-plus-core`                       | build tooling      |
| `brace-expansion`                             | `@tanstack/eslint-config` → `eslint-plugin-import-*` | lint tooling       |
| `mysql2`, `deepmerge-ts`                      | `prisma`                                             | CLI/config tooling |

`mysql2` is worth calling out because of its severity: it is a Prisma
dependency that exists for Prisma's MySQL support. This deployment is
Postgres-only (`@prisma/adapter-pg`, ADR-0003/ADR-0047), so no code path can
reach it at runtime.

## Why there is deliberately no audit step in CI

This was evaluated against the rule "add the job only if it can be made
non-flaky; otherwise document why and stop" (F1 audit S8.5).

1. **It cannot be made non-red.** The set is not flaky — it is _permanently_
   failing at `--audit-level high`. Blocking would break every build from day
   one; `continue-on-error` would ship a job that is always red, which trains
   reviewers to ignore red.
2. **Most of it cannot be fixed from this repository.** `AGENTS.md` forbids
   installing or upgrading `vitest`, `oxlint`, `oxfmt` and `tsdown` directly:
   they are wrapped by `vite-plus` and arrive only through it. `postcss` and
   `nanoid` are `vite-plus`'s own dependencies. A fix needs an upstream
   release, not a local bump — and `vite-plus` bumps carry a documented hazard
   (an ARM64-only SSR crash invisible to x86_64 CI; see `.github/dependabot.yml`,
   which deliberately keeps them out of grouped PRs for exactly this reason).
3. **The actionable channel already exists.** Dependabot is enabled
   (`.github/dependabot.yml`): weekly version PRs plus GitHub-native security
   alerts, which express the thing an audit job cannot — "a patched version is
   now available for a dependency we control".

## The rule

A finding is actioned immediately, as a normal individually-reviewed upgrade,
when it lands on a **direct** dependency or on anything that runs in
**production**.

Findings that are transitive inside dev tooling are recorded here and revisited
when the upstream that owns them ships a fix.

## Re-check points

- before any dependency-review,
- after any `vite-plus` or `prisma` upgrade,
- when a security advisory reaches the project by any other route.

Command:

```sh
vp pm audit -- --audit-level high
```

If a **runtime** dependency ever appears in the list, that is the trigger to
reconsider a blocking CI gate — at that point the finding is actionable, which
is what the gate is for.
