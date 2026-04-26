# ADR-0002 — Enforce the `no-use-effect` convention via lint + pre-commit guard

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-04-26     |
| **Accepted**      | 2026-04-26     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

`.agents/skills/no-use-effect/SKILL.md` (the `no-use-effect` skill) bans direct `useEffect` / `useLayoutEffect` calls in favour of five replacement patterns:

1. **Derived state** — compute from props/state inline.
2. **Data-fetching libraries** — TanStack Query / TanStack DB.
3. **Event handlers** — fire side effects from the actual user action.
4. **`useMountEffect`** — the project's blessed escape hatch (`src/hooks/use-mount-effect.ts`, introduced alongside this ADR).
5. **`key` prop** — for state reset on identity change.

Until today, this convention lived **only** in the skill document and `AGENTS.md`. There was no machine enforcement. Concrete consequences observed during the Apr 2026 audit:

- A 7-site `useEffect` audit was needed before this commit (see commit `9de218b`).
- Reviewers (human or AI) had to remember to grep for `useEffect` on every PR.
- Future contributors who skip `SKILL.md` could re-introduce raw `useEffect` calls and CI would stay green.

The ban is real, but it was operating on the honour system. That is unacceptable for a project that markets itself as "MAANG-grade."

### Why a single tool is insufficient

The codebase exclusively uses the **namespace import style**:

```ts
import * as React from "react"
React.useEffect(() => {
  /* ... */
}, [])
```

`oxlint` (via `vp lint`) ships `no-restricted-imports`, which can flag named imports like `import { useEffect } from "react"` — but it operates on import _specifiers_, not on member-access expressions. It **cannot** detect `React.useEffect(...)`. Switching the codebase to named imports purely to make the lint rule effective would be churn for the sake of tooling, and it would not stop a determined developer from writing `import * as ReactNs from "react"; ReactNs.useEffect(...)`.

So enforcement requires **two cooperating mechanisms**: one for the named-import style (lint) and one for the namespace style (a tiny grep guard).

## Decision

Adopt a **two-layer enforcement** with an escape valve for genuinely-justified call sites:

### Layer 1 — `oxlint` rule

`.oxlintrc.json` enables `no-restricted-imports` with a payload that bans the named imports `useEffect` and `useLayoutEffect` from `"react"`:

```@/home/ubuntu/permoney/.oxlintrc.json:1-13
{
  "rules": {
    "no-restricted-imports": [
      "error",
      {
        "paths": [
          {
            "name": "react",
            "importNames": ["useEffect", "useLayoutEffect"],
            "message": "Direct `useEffect`/`useLayoutEffect` is banned..."
          }
        ]
      }
    ]
  }
}
```

This fires on `import { useEffect } from "react"` even when the call site is hidden behind aliasing or further composition.

### Layer 2 — `scripts/check-no-use-effect.mjs`

A pure-Node script (zero dependencies) walks `src/`, scans for `React.useEffect(` and `React.useLayoutEffect(`, and accepts a call site iff one of:

1. The **contiguous comment block** immediately preceding the call site contains the literal sentinel `no-use-effect skill exemption`. "Contiguous" means the script walks upward from the call site through `//`, `/*`, `*` and blank lines, stopping at the first line of real code; the sentinel can appear anywhere in the walked block.
2. The call site lives in `src/hooks/use-mount-effect.ts` itself — that file is the blessed escape hatch wrapper, and exists _to_ call `React.useEffect` once.

Anything else is a violation; the script exits with code 1 and prints `file:line` for each offender plus a remediation hint.

### Wiring

Three integration points:

1. **Pre-commit (`vite.config.ts` `staged` hook)** — runs on `git commit`:
   ```ts
   staged: {
     "*": "vp check --fix && node scripts/check-no-use-effect.mjs --quiet",
   }
   ```
2. **Combined `check` script (`package.json`)** — exposed as `vp run check` (renamed from the built-in `vp check` so it includes our guard):
   ```json
   { "check": "vp check && node scripts/check-no-use-effect.mjs" }
   ```
   And a standalone `lint:no-use-effect` script for ad-hoc invocation.
3. **CI** — runs `vp run check` (no extra wiring needed beyond what the `package.json` script already does).

### The sentinel string is load-bearing

`no-use-effect skill exemption` was chosen because it:

- Is unique enough that it never appears in unrelated code.
- Encodes _why_ the call is allowed (it's an exemption to the skill rule).
- Is short enough to be a copy-pasteable header for a justification block.

Three call sites in the codebase already use it (audited and approved during the Apr 2026 cleanup):

```@/home/ubuntu/permoney/src/components/ui/calendar.tsx:201-216
  // ─── Justified `useEffect` (no-use-effect skill exemption) ──────
```

```@/home/ubuntu/permoney/src/routes/__root.tsx:50-68
  // ─── Justified `useEffect` (no-use-effect skill exemption) ──────
```

```@/home/ubuntu/permoney/src/routes/transactions.tsx:114-123
  // ─── Justified `useEffect` (no-use-effect skill exemption) ──────
```

The script was tested adversarially: an unannotated `React.useEffect(() => {}, [])` in a temp file was flagged (`exit=1`), and the same code with a sentinel-prefixed comment block above it passed (`exit=0`).

## Consequences

### Positive

- The convention is now machine-enforced. CI fails on any unjustified `React.useEffect`.
- Pre-commit catches violations before they ever reach the remote.
- Reviewers stop being the load-bearing layer; their attention can shift to logic, not pattern-matching `useEffect`.
- Existing justified call sites are zero-friction — they were annotated correctly during the Apr 2026 audit and pass the new guard untouched.
- The escape valve is honest: it requires the author to write a paragraph explaining _why_ none of the five rules apply, which is a high enough activation energy that "lazy `useEffect`" never wins, and a low enough one that legitimate cases (like DOM `.focus()` in `react-day-picker`) are not blocked.

### Negative / costs

- Two cooperating mechanisms instead of one — a future maintainer needs to remember both. Mitigated by the prominent doc-comment at the top of `scripts/check-no-use-effect.mjs` and this ADR.
- The script does textual scanning, not AST analysis. It could be defeated by truly contrived code (e.g. `(React)["use"+"Effect"](...)` ). We accept this: the people defeating the guard are the same people who would write `// @ts-ignore` over a real bug, and no static analyser stops that.
- A misnamed file or aliased React namespace (e.g. `import * as R from "react"; R.useEffect(...)`) would slip through Layer 2 today. If we ever see this pattern in code, we extend `VIOLATION_PATTERNS` in the script. So far, the codebase only uses `React.` as the namespace, so this is not a hypothetical we need to over-engineer for.

### Neutral

- Adds two files (`.oxlintrc.json`, `scripts/check-no-use-effect.mjs`) and minor edits to `vite.config.ts` + `package.json`. No runtime cost — both layers run only at lint/commit/CI time.

## Alternatives considered

### A. Switch the codebase to named imports + rely on `no-restricted-imports` alone

Rejected. Churn (every component touched) for no semantic benefit, and easily defeated by the next contributor who writes `import * as React from "react"`.

### B. Write a custom oxlint plugin

Rejected. oxlint plugin authoring is in flux as of Apr 2026 (Rust API not stable); the dev cost for a 200-line guard is far higher than `node scripts/check-no-use-effect.mjs`. We can revisit if oxlint stabilises a JS plugin API.

### C. Husky + lint-staged

Rejected. Vite+ already provides a `staged` hook (`vp config` wires it via Git pre-commit). Adding Husky/lint-staged duplicates infrastructure and pulls in two packages we don't need.

### D. Just trust reviewers

Rejected — that's the status quo. The whole point of this ADR is that "trust reviewers" was costing real reviewer-attention every PR and was demonstrably letting `useEffect` reappear (the Apr 2026 audit found 7 of them).

## Implementation

Single commit, no schema changes, no runtime changes. Files added:

- `.oxlintrc.json`
- `scripts/check-no-use-effect.mjs`
- `docs/adr/0002-lint-enforcement-no-use-effect.md` (this file)

Files edited:

- `vite.config.ts` — chained the guard into the `staged` hook.
- `package.json` — added `lint:no-use-effect` script and inlined the guard into the existing `check` script.
- `docs/adr/README.md` — added this ADR to the index.

## Verification

```bash
vp check                          # → fmt + lint + tsc + no-use-effect guard
pnpm run lint:no-use-effect       # standalone
node scripts/check-no-use-effect.mjs --quiet   # raw form (silent on success)
```

All three should be green at the time this ADR is accepted (74 files, 154 tests, 3 justified `React.useEffect` sites, 0 unjustified).
