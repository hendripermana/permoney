# ADR-0002 — Enforce the `no-use-effect` convention via a unit-tested grep guard

|                   |                                                           |
| ----------------- | --------------------------------------------------------- |
| **Status**        | Accepted (amended 2026-04-30, hardened 2026-05-01)        |
| **Date**          | 2026-04-26                                                |
| **Accepted**      | 2026-04-26                                                |
| **Amended**       | 2026-04-30 — consolidated to single-tool guard            |
| **Hardened**      | 2026-05-01 — extracted detector, added 39-case test suite |
| **Deciders**      | Hendri Permana                                            |
| **Supersedes**    | —                                                         |
| **Superseded by** | —                                                         |

## TL;DR

A pure-Node detector (`scripts/check-no-use-effect.detector.mjs`) catches every place in `src/` that violates the `no-use-effect` skill — both `import { useEffect } from "react"` and `React.useEffect(...)` call sites — with a sentinel-comment exemption for genuinely-justified cases. A 124-line CLI shim (`scripts/check-no-use-effect.mjs`) drives it at pre-commit and CI. A 39-case Vitest suite pins the detector against regression. There is **no oxlint rule**: a previous version delegated the named-import case to oxlint, but that rule's spec-strict behaviour produced 38 IDE false-positives on the project's namespace-import convention, so we consolidated. The guard is regex-based, not AST-based — see § Threat model for what that buys and what it accepts.

## Current state — How enforcement works today

### What is detected

| Kind             | Pattern                                                                                                 | Exemptable?                                                | Where the rule lives               |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| **Named import** | `import { useEffect [as x], useLayoutEffect } from "react"` (single- or multi-line, type-only included) | **No** — bypass requires rewriting to namespace + sentinel | `NAMED_IMPORT_PATTERN` in detector |
| **Call site**    | `React.useEffect(...)` / `React.useLayoutEffect(...)`                                                   | **Yes**, with the sentinel below                           | `CALL_SITE_PATTERNS` in detector   |

### The sentinel exemption

A call site is **justified** iff the contiguous comment block immediately preceding it contains the literal phrase:

```
no-use-effect skill exemption
```

"Contiguous" means: walking up from the call-site line through `//`, `/*`, `*` lines and blank lines, stopping at the first line of real code, the sentinel must appear somewhere inside that walked block. Three call sites in the codebase use it today — `src/components/ui/calendar.tsx`, `src/routes/__root.tsx`, `src/routes/transactions.tsx`.

Additionally, **`src/hooks/use-mount-effect.ts` is allowlisted by path** — that file exists _to_ call `React.useEffect` once and is the blessed escape hatch. Named-import violations are still checked even there (the file should never need them).

### Where it runs

| Trigger          | Command                                                             | When                                     |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| Pre-commit       | `scripts/staged-check.mjs` → `node scripts/check-no-use-effect.mjs` | every `git commit`, on staged files only |
| CI / local check | `vp run check` (the project's combined `package.json` script)       | every CI run                             |
| Standalone       | `vp run lint:no-use-effect`                                         | ad-hoc                                   |
| Test suite       | `vp test run` → `scripts/check-no-use-effect.test.mjs`              | every CI run; pins the detector          |

### File map

```
scripts/
├── check-no-use-effect.mjs               (124 lines) — CLI shim: walks src/, reads files, invokes detector
├── check-no-use-effect.detector.mjs      (222 lines) — pure functions, the canonical policy
└── check-no-use-effect.test.mjs          (39 cases) — Vitest pin against regression
```

The detector exports six things: the constants `SENTINEL` / `MAX_WALK` / `CALL_SITE_PATTERNS` / `NAMED_IMPORT_PATTERN`, the helpers `isCommentOrBlank` / `precedingCommentBlock`, the detectors `findNamedImportViolations` / `findCallSiteViolations`, and the convenience wrapper `scanText(text, { isAllowlisted? })`. The CLI does no policy work itself — every behavioural decision is testable.

## Threat model

The guard is **regex-based**, intentionally. We catalogue what it does and does not catch so a future maintainer reading this knows which threats are protected against and which are accepted.

### Detected (the common cases)

| #   | Pattern                                                          | Detected by                                  |
| --- | ---------------------------------------------------------------- | -------------------------------------------- |
| 1   | `import { useEffect } from "react"`                              | named-import detector                        |
| 2   | `import { useEffect, useLayoutEffect } from "react"`             | named-import detector                        |
| 3   | Multi-line variant of (1) / (2)                                  | named-import detector (forward-walks to `}`) |
| 4   | `import type { useEffect } from "react"`                         | named-import detector                        |
| 5   | `import { useEffect as ue } from "react"`                        | named-import detector                        |
| 6   | `import { useEffect } from "react/jsx-runtime"` (subpath)        | named-import detector                        |
| 7   | `React.useEffect(() => {}, [])` no comment                       | call-site detector                           |
| 8   | `React.useEffect(...)` with non-sentinel comment above           | call-site detector                           |
| 9   | `React.useEffect(...)` with sentinel comment broken by code line | call-site detector                           |

### Accepted bypass vectors (we deliberately do NOT catch these)

| #      | Bypass                                                                                                        | Why we don't catch it                          | Why it's an acceptable risk                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| **B1** | `import * as ReactNs from "react"; ReactNs.useEffect(...)` (renamed namespace)                                | Detector hard-codes `\bReact\.`                | Project convention is `React.` exclusively; PR reviewers will catch a rename.          |
| **B2** | Re-export trick: a local file `export { useEffect } from "react"`, then `import { useEffect } from "./local"` | Detector does not chase re-exports             | Requires deliberate, multi-file effort to bypass. PR reviewers will see the re-export. |
| **B3** | `import("react").then(R => R.useEffect(...))` (dynamic import)                                                | Detector does not parse expression form        | Never used in this codebase; pathological for a hook.                                  |
| **B4** | `(globalThis as any).React = require("react"); React.useEffect(...)`                                          | Detector does not analyse runtime mutation     | Pathological — would be flagged by review on sight.                                    |
| **B5** | `const e = React.useEffect; e(...)` (alias before call)                                                       | Detector does not track variable bindings      | Pathological — same as B4.                                                             |
| **B6** | `}` inside a comment in a multi-line import block                                                             | Detector's forward-walk stops at the first `}` | Would not survive `oxfmt` reformatting; never observed in real PRs.                    |

The threat model is **honest contributors who type the wrong thing**, not adversaries trying to defeat policy. Every accepted vector requires either deliberate effort (B1, B2) or pathological code (B3–B6) that would not survive code review on aesthetic grounds alone.

## Why regex, not AST

A senior reviewer would correctly note that "real" code-policy enforcement at MAANG-scale runs on AST: a custom ESLint rule, a `ts-morph` visitor, or an `oxlint` plugin. We chose regex with eyes open. The trade-off:

| Dimension               | Regex (chosen)                                                | AST (rejected for now)                                              |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Cold start              | ~100 ms on `src/` (single Node process, no transpile)         | 1–3 s (oxlint plugin pipeline or ts-morph)                          |
| Dependencies            | Zero                                                          | At least one (oxlint plugin scaffold, or `ts-morph`)                |
| Lines of code           | 222 (detector) + 124 (CLI) + tests                            | est. 400+ for an oxlint plugin in Rust, 600+ for ts-morph visitor   |
| Bypass surface          | B1–B6 above                                                   | Effectively zero — AST sees through aliases, re-exports, namespaces |
| Maintainability         | Anyone with `git blame` can read the regex and the test cases | Requires Rust (oxlint) or deep TypeScript-AST knowledge             |
| Time-to-ship (Apr 2026) | 1 day, including tests                                        | 1–2 weeks, including landing the plugin scaffold                    |

The convention has held in this codebase for the entire history of the project (the audit found 7 violations across 6 months of accumulation, all from a single contributor onboarding period). The threat model is **drift, not adversaries**. Regex is the right tool for drift detection; AST is the right tool for security boundaries. We will revisit if the assumption breaks — concretely, the trigger to escalate to AST is: any single PR contains a B-class bypass vector that ships to `main`.

The 39-case test suite serves as the _behavioural_ spec the regex must satisfy. If we ever migrate to AST, the same tests run against the new implementation and we get a clean cutover.

## Wiring

Three integration points, all unchanged from the original ADR despite the implementation rewrite:

1. **Pre-commit** — `vite.config.ts`'s `staged` hook runs `scripts/staged-check.mjs`, which dispatches `vp check --fix` then `node scripts/check-no-use-effect.mjs`.
2. **CI / local check** — `package.json` `check` script: `vp check && node scripts/check-no-use-effect.mjs`.
3. **Standalone** — `package.json` `lint:no-use-effect` script for ad-hoc invocation.

The new addition (2026-05-01) is **test discovery**: Vitest auto-discovers `scripts/**/*.test.mjs`, so `vp test run` includes the detector test file with no extra config.

## Verification

At the time of the 2026-05-01 hardening:

```bash
vp run check          # → fmt + lint + tsc + no-use-effect guard
vp test run           # → 5 test files, 193 / 193 tests pass (39 of which test the detector)
vp build              # → production bundle generated
```

The 39 detector tests cover six logical buckets:

1. Banned named imports (9 cases — single-line, multi-line, type-only, aliased, subpath, dual-name)
2. Allowed imports — must not false-positive (7 cases — namespace, default, other named, non-react source, word-boundary `useEffectInternal`, similar-but-distinct names, type-only types)
3. Unjustified call sites (4 cases)
4. Justified call sites — must not false-positive (4 cases — line-comment, blank-separated, JSDoc-block, broken-by-code)
5. End-to-end via `scanText` (5 cases — both kinds in one pass, allowlist semantics, CRLF, empty input, sane component)
6. Helper-level micro-tests (10 cases — `isCommentOrBlank`, `precedingCommentBlock`, constant invariants)

The real `src/` post-amendment: 0 violations, 3 sentinel-justified call sites unchanged from the original ADR.

## Consequences

### Positive

- **Single source of truth** — the detector is the policy. No two tools drifting out of sync.
- **Zero IDE noise** — no oxlint rule means no spec-strict false positives on the 38 namespace-import files.
- **Pre-empts the future CLI break** — when oxlint CLI catches up to the spec, we are unaffected.
- **Behavioural spec is executable** — 39 tests pin the detector. Regressions are caught in CI, not in `git blame` six months later.
- **Refactor-safe** — pure functions in the detector module mean future changes (e.g. extending to `useInsertionEffect`) are local edits with immediate test feedback.
- **Honest threat model** — accepted bypass vectors are catalogued, not hand-waved.

### Negative / costs

- **No just-in-time IDE feedback** for the named-import form (the developer sees the error at `git commit`, not as-you-type). Acceptable: named React imports are essentially never used in this codebase by convention, and the pre-commit hook runs in <1 s.
- **Regex bypass surface** documented above (B1–B6). Accepted because the threat model is drift, not adversaries.
- **Two `.mjs` files instead of one** — slight increase in file count for the testability win.

### Neutral

- All wiring (`vp run check`, `lint:no-use-effect`, the `staged` hook) is unchanged — they already invoked the script.
- Build, test, and runtime behaviour unchanged.

## Alternatives considered (current)

### A. Custom oxlint plugin (AST-based)

Rejected — see § "Why regex, not AST". Reconsider if any B-class vector ships to `main`.

### B. Custom ESLint rule (AST-based, run via `eslint --no-eslintrc`)

Rejected — same reasoning. Adds an entire ESLint dependency tree we don't otherwise need.

### C. `ts-morph` visitor as a script

Rejected — adds a 10 MB dependency for a 200-line problem. The build-time cost would dwarf the test suite.

### D. Just trust reviewers

Rejected — the original ADR observed that this was the de-facto state and let 7 violations slip in over 6 months. Convention without enforcement = aspiration.

## Implementation files

```
docs/adr/0002-lint-enforcement-no-use-effect.md   (this file)
scripts/check-no-use-effect.detector.mjs          (pure detector — the policy)
scripts/check-no-use-effect.mjs                   (CLI shim — walks src/, exits 1 on violation)
scripts/check-no-use-effect.test.mjs              (Vitest spec — 39 cases)
scripts/staged-check.mjs                          (pre-commit dispatcher)
```

Configuration touch-points:

- `vite.config.ts` — `staged` hook
- `package.json` — `check`, `lint:no-use-effect` scripts
- `.oxlintrc.json` — `rules: {}` (kept as a placeholder for future oxlint configuration)

---

## Revision history

### 2026-05-01 — Hardening (this revision)

- Extracted pure detector functions from the CLI script into `scripts/check-no-use-effect.detector.mjs`.
- Added `scripts/check-no-use-effect.test.mjs` with 39 test cases covering 6 logical buckets.
- Reordered ADR top-down so the **current state** is on page one; demoted the original two-layer narrative to this history section.
- Documented the threat model explicitly (B1–B6 bypass vectors).
- Documented the regex-vs-AST trade-off explicitly.
- Fixed stale references in `docs/adr/README.md` index entry and `vite.config.ts` `staged` comment.

### 2026-04-30 — Consolidation amendment

The original two-layer design rested on the assumption that `oxlint`'s `no-restricted-imports` would only flag _named_ imports, leaving namespace imports for the script to handle. That assumption broke in practice for two reasons:

1. **The ESLint spec for `no-restricted-imports` says `importNames` ALSO flags namespace imports**, on the grounds that a namespace import (`import * as React from "react"`) technically grants access to all named exports including the restricted ones. Oxlint's IDE/LSP build follows the spec strictly; the CLI build at version 1.62.0 did not yet, but almost certainly will in a future release.
2. **The codebase deliberately uses the namespace style in 38 files** (it's the project convention). The strict-spec interpretation therefore produced 38 false-positive squiggles — one per React component file — in any IDE running an oxlint LSP that follows the spec. The CLI was clean today, but the next CLI upgrade would have triggered a 38-file fire-drill.

Rather than tolerate creeping IDE noise that would eventually become a CLI break, all enforcement was consolidated into the script. The `oxlint` `no-restricted-imports` rule was removed; `.oxlintrc.json` was preserved with empty `rules: {}` as a placeholder for future configuration. The script was extended to also detect named imports, with a forward-walking line stitcher for multi-line specifier lists.

A five-case smoke test was run before merging that amendment (synthetic files dropped in `src/__smoke__/`, then deleted). Those smoke cases are now part of the 39-test Vitest suite — see § Verification.

### 2026-04-26 — Original two-layer design (now superseded)

The first version of this ADR adopted a two-layer enforcement:

- **Layer 1 (oxlint rule)** — `.oxlintrc.json` enabled `no-restricted-imports` with `paths.importNames: ["useEffect", "useLayoutEffect"]` from `"react"`, intended to catch the named-import form.
- **Layer 2 (Node script)** — `scripts/check-no-use-effect.mjs` scanned for `React.useEffect(` and `React.useLayoutEffect(` call sites, accepting the sentinel-comment exemption.

That design was correct in intent but, as the 2026-04-30 amendment found, fragile in practice because the two layers had overlapping rather than complementary behaviour at the IDE/LSP level. The hardening above replaces it with a single layer that is unit-tested and bypass-mapped.
