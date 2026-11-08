# Dependency audit posture — and why there is no audit CI job

Measured **2026-09-20** with `vp pm audit -- --audit-level high`:
**13 findings — 1 critical, 8 high, 4 moderate** (`pnpm audit` exits 1).

_(The claim below held in September 2026. **Superseded by the
2026-10-25 update below** — keep reading before acting on it.)_

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

## Update — 2026-10-25: the trigger above fired

Dependabot alerts were enabled on 2026-10-24/25 and immediately reported
**32 open alerts** (2 critical, 11 high) against the then-current lockfile —
the finding set had grown well past the September measurement, and the
central claim above was no longer true.

What the triage found:

- **`zod` is a direct production dependency and ships in the prod artifact**
  (`.output/server/_libs/zod.mjs`). Alert GHSA-mrhx-c7xc-m3w5 (`zod`
  4.6.5 → 4.6.6) was the exactly-one runtime-reachable finding of the 32. Per
  the rule ("actioned immediately as a normal individually-reviewed upgrade"),
  it was fixed via a lockfile refresh (zod ≥4.6.7 declared and resolved).
- 19 of the 32 alerts trace to a single misclassification: `shadcn` — a
  code-generation CLI, imported by no code under `src/` — sits in
  `dependencies`, pulling `express`, `@modelcontextprotocol/sdk`, `socks`, and
  `undici` into the "production" graph. The structural fix (move it to
  `devDependencies`, and audit `tailwindcss`/`@tailwindcss/vite`/
  `@tanstack/router-plugin`/`tw-animate-css` for the same class) landed on
  2026-11-01 — see the re-scan below.
- `vite-plus` 1.1.0 → 1.3.0 (which carries the `@vitest/ui` +
  `@vitest/browser` patches) stays blocked pending the documented ARM64
  build-and-boot gate (`.github/dependabot.yml`), as does anything that
  needs to reinstall vitest through it.

### Reachability method for this repo

`pnpm audit --prod` is **not** a trustable runtime signal here: optional-peer
edges (`better-auth ┄ vitest`, `@better-auth/prisma-adapter ┄ prisma`)
promote dev-only tooling into the prod graph, and the flag disagrees with its
own full mode on individual findings. The authoritative check is the shipped
artifact: the prod image contains only `.output` (no `node_modules`), so
reachability is measured by grepping the built `.output` for a package's
ingress markers (`node_modules/.pnpm/<pkg>@…` regions in the traced bundle).
In the 2026-10-25 triage, exactly one critical/high package had non-zero
markers (`zod`, 20 refs); every other critical/high package had 0.

### Collateral transitive drift — unrequested, range-honoring (2026-11-01 refresh)

The lockfile refresh also re-resolved upstream manifests inside their declared
ranges. Two deliberate `package.json` edits were made — raising the `zod`
declared floor to the patched line, and one scoped override (`e2e>zod`:
`>=4.6.6`) because the `e2e@0.21.2` dev dependency hard-pins
`"zod": "4.6.1"` exactly, which alert #26 (`GHSA-mrhx-c7xc-m3w5`, fixed in
4.6.6) would otherwise have survived the merge. The override drops as soon
as `e2e`'s own manifest pins zod ≥ 4.6.6; until then it is deliberately
stronger than upstream. Everything below moved only
because a parent required it:

- `content-disposition` 1.1.0 → 2.0.1 (**major**) — required by
  `express@5.3.0`, whose sole caller chain is the `shadcn` CLI subtree
  (dev-CLI; never imported by `src/`, never shipped in `.output`).
- `express` 5.2.1 → 5.3.0, `shadcn` 4.21.3 → 4.22.1 and `@shadcn/registry`
  0.1.2 → 0.2.0 — the registry/shadcn bump is what retires the last resolved
  `zod@3.25.76` instance (their zod spec flipped `^3.24.1` → `^4.2.0`).
  This, not the zod floor-raise alone, is what removed zod 3 from the tree.
- Data-only widths: browserslist 4.28.9 → 4.29.4 (+ caniuse-lite /
  electron-to-chromium / node-releases / baseline-browser-mapping series).
- Patch drift: express-rate-limit, open, qs, on-finished, bundle-name;
  `@hono/node-server` peer widened (`^4 || ^5.0.0-0`); powershell-utils →
  wsl-utils package swap below `open`.

### Post-refresh re-scan (2026-11-01)

The re-locked manifest dropped the open Dependabot alert count **32 → 8**
(zod alert #26 confirmed cleared). All eight are dev/build chains. The
2026-11-01 branch then reclassified the build-only tooling (`shadcn`,
`tailwindcss`, `@tailwindcss/vite`, `@tanstack/router-plugin`,
`tw-animate-css` — none imported by `src/` at runtime) to `devDependencies`,
so the whole `shadcn` subtree is dev-only, and refreshed the remaining
in-range transitive resolution:

- **systeminformation 5.33.8** — GHSA-3f7j-7jwc-fxfj (high),
  GHSA-7648-jmwf-vw7j (medium), GHSA-4vjg-vx72-qq4g (low): **cleared here**.
  Parent `@dotenvx/dotenvx@1.75.1` (sole caller: the `shadcn` CLI subtree)
  declares `^5.22.11`, so the resolution was refreshed to 5.33.19 directly —
  no override, and deliberately only that edge re-resolved (an `pnpm update`
  sweep would have drifted four unrelated dev chains: js-base64, ws,
  @types/estree, @types/node).
- **minimatch 10.2.5/10.2.6** — GHSA-g3hv-75wg-m249 (medium), fixed only at
  **11.0.1** (semver-major for its dev-tooling parents: `@tanstack/
  eslint-config` chain and `@ts-morph/common` under `shadcn`). Not forced;
  scheduled through the next Dependabot PR cycle or a scoped-override
  decision.
- **deepmerge 4.3.1** — GHSA-gcqx-w48m-w2h4 (low): **no fixed version exists**
  (`first_patched_version: null`). Sole parent is the `shadcn` CLI subtree,
  dev-only since 2026-11-01. Standing watch item; revisit when upstream ships.
- **vitest trio** (`@vitest/ui`, `@vitest/browser`, `vite-plus`, medium
  GHSA-p458-7748-mcp3) — accepted by design: vite-plus owns vitest and its
  upgrades ride the ARM64 build-and-boot gate (`.github/dependabot.yml`).

Net after this landing: the open-alert set should sit at **5** — the vitest
trio (excluded by design), minimatch (major fix scheduled), deepmerge (no fix
upstream yet). That is where it stands: Dependabot briefly reported four
during the refresh window, then its post-merge re-scan created a fresh
`minimatch` alert (GHSA-g3hv-75wg-m249, 2026-11-08) while the resolved
versions stayed at 10.2.5/10.2.6. The advisory's vulnerable range is
`>=7.0.0, <11.0.1`, so the original assessment holds.

### Second refresh — weekly Dependabot wave (2026-11-08)

The 2026-11-01 cycle left ten Dependabot PRs queued. Nine were applied in one
hand-authored refresh; the tenth (`vite-plus`) stays excluded by the ARM64
build-and-boot gate. One `vp install` from the then-current `main` regenerated
the lockfile, so the stale-base textual-merge class described in
`.github/dependabot.yml` cannot occur: there is no second writer to the file.

Direct bumps: `dotenv` 18.0.9 (no `src/` import; reachable only as
`nitro`'s optional dependency, plus the dev scripts `prisma/seed*.ts`,
`prisma.config.ts`, `scripts/verify-money-migration.mjs`),
`@upstash/ratelimit` 2.2.0, `resend` 6.34.1, `@daypicker/react` 10.0.2,
`@e2e-dev/web` 0.15.3, `ai` 7.0.156, `@playwright/test` 1.64.1,
`@node-rs/argon2` 2.2.2, `shadcn` 4.23.0.

Collateral changes worth recording:

- `shadcn@4.23.0` **replaced its express-based MCP server dependency**
  (`@modelcontextprotocol/sdk` → `@modelcontextprotocol/server`). The whole
  `express` subtree leaves the lockfile, including
  `content-disposition@2.0.1` — the only major called out in the previous
  drift note. Nothing under `src/`, `prisma/`, `scripts/`, or `tests/`
  imports `express`; the shadcn CLI is dev-only.
- Range-honoring drift past the PR targets: `resend` 6.37.0,
  `@playwright/test` 1.65.0, `ai` 7.0.165. These are the highest versions
  satisfying the ranges Dependabot proposed at lockfile-generation time, not
  extra decisions.
- `@e2e-dev/web` is **exact-pinned at 0.15.3**, not range-bumped: 0.15.4
  raised its peer floor to `e2e >=0.22.1 <1`, while this repository pins
  `e2e@0.21.2`. A caret here resolves to 0.15.5 and breaks the
  `test:e2e-army` lane. Lift the pin when `e2e` itself moves.

Alert set after the wave: **5 open** — the vitest trio (excluded by design),
`minimatch` (fixed only at 11.0.1, semver-major for its dev-tooling parents),
and `deepmerge` (no fix upstream). `minimatch` was re-reported by Dependabot's
post-merge re-scan even though the resolved versions did not move.

### The trigger decision

The trigger was evaluated and **the no-CI-audit-job decision stands**:
Dependabot alerts plus the four guards in `vp run check` remain the
actionable channel. A permanently-red `pnpm audit` job would still train
reviewers to ignore red, and alert triage (installed vs reachable) is a
judgment call that a nightly job would render either always-green or noisy.
Revisit only if another runtime-direct finding appears outside a scheduled
lockfile refresh.

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

## Merge protocol for lockfile-touching PRs

Dependabot PRs that touch `pnpm-lock.yaml` follow the four-rule protocol
recorded in `.github/dependabot.yml` (rebase first, merge serially, "no checks
reported" = sync the branch rather than wait, and let every `main` CI run
finish before merging the next). It exists because of the 2026-10-10 incident:
a stale-base squash merge produced a `pnpm-lock.yaml` with duplicated mapping
keys while GitHub still reported the PR CLEAN (#422 → #433).

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
is what the gate is for. This trigger fired on 2026-10-25 (`zod` — direct
production dependency, bundled in `.output`); see the update section above
for what was done and what was decided.
