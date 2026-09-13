/**
 * Test suite for the `no-use-effect` policy detector (ADR-0002).
 *
 * The detector is a regex-based, IO-free implementation of the project's
 * `no-use-effect` skill enforcement. This file pins its behaviour against
 * a comprehensive set of cases — every regex tweak in the future MUST keep
 * these tests green. If a case here ever turns red without a corresponding
 * ADR amendment, the regex regressed: revert.
 *
 * The test cases are grouped into five logical buckets that mirror the
 * detector's responsibilities:
 *
 *   1. Banned named imports — single-line, multi-line, type-only, aliased.
 *   2. Allowed namespace / non-react imports — verify zero false positives.
 *   3. Unjustified call sites — `React.useEffect(...)` without sentinel.
 *   4. Justified call sites — sentinel in the contiguous preceding block.
 *   5. Adversarial / boundary cases — word-boundary, nested files, etc.
 */

import { describe, expect, it } from "vite-plus/test"
import {
  CALL_SITE_PATTERNS,
  MAX_WALK,
  NAMED_IMPORT_PATTERN,
  SENTINEL,
  findCallSiteViolations,
  findNamedImportViolations,
  isCommentOrBlank,
  precedingCommentBlock,
  scanText,
} from "./check-no-use-effect.detector.mjs"

// ───────────────────────────────────────────────────────────────────────────
// 1. Banned named imports
// ───────────────────────────────────────────────────────────────────────────

describe("findNamedImportViolations — banned named imports", () => {
  it('flags a single-line `import { useEffect } from "react"`', () => {
    const violations = findNamedImportViolations([
      `import { useEffect } from "react"`,
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe("named-import")
    expect(violations[0].line).toBe(1)
  })

  it("flags `import { useLayoutEffect } from 'react'` with single quotes", () => {
    const violations = findNamedImportViolations([
      `import { useLayoutEffect } from 'react'`,
    ])
    expect(violations).toHaveLength(1)
  })

  it("flags a multi-line import where the banned name is in the middle", () => {
    const lines = [
      "import {",
      "  useState,",
      "  useEffect,",
      "  useMemo,",
      `} from "react"`,
    ]
    const violations = findNamedImportViolations(lines)
    expect(violations).toHaveLength(1)
    expect(violations[0].line).toBe(1) // points at the FIRST line of the import
    expect(violations[0].snippet).toContain("useEffect")
  })

  it("flags a multi-line import containing useLayoutEffect", () => {
    const lines = [
      "import {",
      "  useRef,",
      "  useLayoutEffect,",
      `} from "react"`,
    ]
    expect(findNamedImportViolations(lines)).toHaveLength(1)
  })

  it('flags `import type { useEffect } from "react"` (banned even type-only)', () => {
    // `useEffect` is a runtime symbol, so a type-only import of it is a
    // code smell, not a real use. Still banned — we surface it loudly.
    const violations = findNamedImportViolations([
      `import type { useEffect } from "react"`,
    ])
    expect(violations).toHaveLength(1)
  })

  it("flags an aliased import `useEffect as ue`", () => {
    const violations = findNamedImportViolations([
      `import { useEffect as ue } from "react"`,
    ])
    expect(violations).toHaveLength(1)
  })

  it("flags both names when both appear in a single import", () => {
    const violations = findNamedImportViolations([
      `import { useEffect, useLayoutEffect } from "react"`,
    ])
    // Single import statement → single violation record (not double-count).
    expect(violations).toHaveLength(1)
  })

  it("flags an import from a `react/...` subpath (e.g. react/jsx-runtime)", () => {
    // Defensive: subpath imports of react are rare in our codebase but
    // semantically equivalent for the purpose of this rule. We err on the
    // side of catching them.
    const violations = findNamedImportViolations([
      `import { useEffect } from "react/jsx-runtime"`,
    ])
    expect(violations).toHaveLength(1)
  })

  it("reports each separate import block as a distinct violation", () => {
    const violations = findNamedImportViolations([
      `import { useEffect } from "react"`,
      "",
      `import { useLayoutEffect } from "react"`,
    ])
    expect(violations).toHaveLength(2)
    expect(violations[0].line).toBe(1)
    expect(violations[1].line).toBe(3)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. Allowed imports — must NOT false-positive
// ───────────────────────────────────────────────────────────────────────────

describe("findNamedImportViolations — must NOT false-positive", () => {
  it('ignores plain namespace imports `import * as React from "react"`', () => {
    expect(
      findNamedImportViolations([`import * as React from "react"`])
    ).toEqual([])
  })

  it('ignores default import `import React from "react"`', () => {
    expect(findNamedImportViolations([`import React from "react"`])).toEqual([])
  })

  it("ignores other named imports from react that are not banned", () => {
    expect(
      findNamedImportViolations([
        `import { useState, useMemo, useCallback, useRef } from "react"`,
      ])
    ).toEqual([])
  })

  it("ignores `useEffect` imported from a non-react source (local mock)", () => {
    // Critical: someone might write a local React-shaped mock for testing
    // and import `useEffect` from it. That's not a policy violation —
    // it's not the React module.
    expect(
      findNamedImportViolations([
        `import { useEffect } from "./local-react-mock"`,
        `import { useEffect } from "../testing/react-stub"`,
        `import { useEffect } from "@/test/react-mock"`,
      ])
    ).toEqual([])
  })

  it("ignores `useEffectInternal` (word-boundary check)", () => {
    // The regex uses `\b` boundaries to avoid matching identifier prefixes.
    // `useEffectInternal` happens to embed `useEffect` but is a different
    // identifier — must NOT trigger.
    expect(
      findNamedImportViolations([
        `import { useEffectInternal, useLayoutEffectShim } from "react"`,
      ])
    ).toEqual([])
  })

  it("ignores imports with similar but distinct names", () => {
    expect(
      findNamedImportViolations([
        `import { useEffectful } from "react"`,
        `import { effectiveUseFoo } from "react"`,
      ])
    ).toEqual([])
  })

  it("ignores type-only imports of types from react", () => {
    expect(
      findNamedImportViolations([
        `import type { ReactNode, FC, MouseEvent } from "react"`,
      ])
    ).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. Unjustified call sites
// ───────────────────────────────────────────────────────────────────────────

describe("findCallSiteViolations — unjustified call sites", () => {
  it("flags `React.useEffect(...)` with no preceding comment", () => {
    const violations = findCallSiteViolations([
      `import * as React from "react"`,
      `function C() {`,
      `  React.useEffect(() => {}, [])`,
      `}`,
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0].line).toBe(3)
    expect(violations[0].kind).toBe("call-site")
  })

  it("flags `React.useLayoutEffect(...)`", () => {
    const violations = findCallSiteViolations([
      `function C() { React.useLayoutEffect(() => {}, []) }`,
    ])
    expect(violations).toHaveLength(1)
  })

  it("flags a call site whose only preceding comment lacks the sentinel", () => {
    const violations = findCallSiteViolations([
      `// just a regular comment, no sentinel here`,
      `React.useEffect(() => {}, [])`,
    ])
    expect(violations).toHaveLength(1)
  })

  it("flags multiple call sites independently", () => {
    const violations = findCallSiteViolations([
      `React.useEffect(() => {}, [])`,
      `function gap() {}`,
      `React.useLayoutEffect(() => {}, [])`,
    ])
    expect(violations).toHaveLength(2)
    expect(violations[0].line).toBe(1)
    expect(violations[1].line).toBe(3)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. Justified call sites — must NOT false-positive
// ───────────────────────────────────────────────────────────────────────────

describe("findCallSiteViolations — sentinel exemption", () => {
  it("ignores call site with sentinel in line-comment block immediately above", () => {
    const violations = findCallSiteViolations([
      `// no-use-effect skill exemption — DOM ResizeObserver subscription`,
      `React.useEffect(() => {}, [])`,
    ])
    expect(violations).toEqual([])
  })

  it("ignores call site with sentinel separated by a blank line", () => {
    // The walker accepts blank lines inside the contiguous comment block,
    // so visually-separated justifications still count as "preceding".
    const violations = findCallSiteViolations([
      `// no-use-effect skill exemption — focus trap requires imperative DOM`,
      ``,
      `React.useEffect(() => {}, [])`,
    ])
    expect(violations).toEqual([])
  })

  it("ignores call site with sentinel inside a JSDoc-style block comment", () => {
    const violations = findCallSiteViolations([
      `/**`,
      ` * Justified — no-use-effect skill exemption.`,
      ` * Reason: imperative ResizeObserver setup.`,
      ` */`,
      `React.useEffect(() => {}, [])`,
    ])
    expect(violations).toEqual([])
  })

  it("flags call site if sentinel is broken by a non-comment line in between", () => {
    // The contiguous-block walker stops at the first line of REAL code, so
    // a sentinel comment separated from the call by a code line does NOT
    // count. This prevents "cargo culting" the sentinel far away from the
    // actual exemption it's supposed to justify.
    const violations = findCallSiteViolations([
      `// no-use-effect skill exemption`,
      `const irrelevant = 1`,
      `React.useEffect(() => {}, [])`,
    ])
    expect(violations).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. End-to-end / integration via scanText
// ───────────────────────────────────────────────────────────────────────────

describe("scanText — integration", () => {
  it("returns BOTH kinds in one pass", () => {
    const text = [
      `import { useEffect } from "react"`,
      `import * as React from "react"`,
      `function C() {`,
      `  React.useEffect(() => {}, [])`,
      `  return null`,
      `}`,
    ].join("\n")
    const violations = scanText(text)
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => v.kind).sort()).toEqual([
      "call-site",
      "named-import",
    ])
  })

  it("respects `isAllowlisted` for call-site detection only", () => {
    // Allowlist (e.g. src/hooks/use-mount-effect.ts) suppresses call-site
    // checks but NOT named-import checks. The hook itself uses namespace
    // style; if a future contributor writes `import { useEffect } from
    // "react"` inside the hook, we still want to know.
    const text = [
      `import { useEffect } from "react"`,
      `import * as React from "react"`,
      `React.useEffect(() => {}, [])`,
    ].join("\n")
    const violations = scanText(text, { isAllowlisted: true })
    // Named import still flagged; call site suppressed.
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe("named-import")
  })

  it("CRLF line endings are handled identically to LF", () => {
    const lf = [
      `import { useEffect } from "react"`,
      `React.useLayoutEffect(() => {}, [])`,
    ].join("\n")
    const crlf = lf.replaceAll("\n", "\r\n")
    expect(scanText(lf)).toEqual(scanText(crlf))
  })

  it("handles an empty string without crashing", () => {
    expect(scanText("")).toEqual([])
  })

  it("returns 0 violations on a sane, conventional component file", () => {
    const text = [
      `"use client"`,
      `import * as React from "react"`,
      `import { Button } from "@/components/ui/button"`,
      ``,
      `export function MyForm() {`,
      `  const [name, setName] = React.useState("")`,
      `  return <Button onClick={() => setName("hi")}>Hi</Button>`,
      `}`,
    ].join("\n")
    expect(scanText(text)).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 6. Helper-level micro-tests (defensive — pin small invariants)
// ───────────────────────────────────────────────────────────────────────────

describe("isCommentOrBlank", () => {
  it("treats blank lines as comments", () => {
    expect(isCommentOrBlank("")).toBe(true)
    expect(isCommentOrBlank("   ")).toBe(true)
  })

  it("treats `//`, `/*`, `*`, and `*/` lines as comments", () => {
    expect(isCommentOrBlank("// hi")).toBe(true)
    expect(isCommentOrBlank("/* block start")).toBe(true)
    expect(isCommentOrBlank(" * doc continuation")).toBe(true)
    expect(isCommentOrBlank("*/")).toBe(true)
  })

  it("treats real code as non-comment", () => {
    expect(isCommentOrBlank("const x = 1")).toBe(false)
    expect(isCommentOrBlank('import { foo } from "bar"')).toBe(false)
  })

  it("survives undefined input (defensive — callers may overshoot EOF)", () => {
    expect(isCommentOrBlank(undefined)).toBe(false)
  })
})

describe("precedingCommentBlock", () => {
  it("collects the contiguous block above the given line", () => {
    const lines = [
      `const x = 1`, // 0 — code, walker should stop here
      `// comment a`, // 1
      ``, // 2 (blank, allowed)
      `// comment b`, // 3
      `React.useEffect(() => {}, [])`, // 4 — call site
    ]
    const block = precedingCommentBlock(lines, 4)
    expect(block).toContain("comment a")
    expect(block).toContain("comment b")
    expect(block).not.toContain("const x")
  })

  it("returns empty string when the line above is real code", () => {
    expect(
      precedingCommentBlock([`const x = 1`, `React.useEffect(...)`], 1)
    ).toBe("")
  })
})

describe("constants are stable", () => {
  it("SENTINEL is the canonical phrase", () => {
    // If this ever changes, every existing exemption comment in the
    // codebase must be updated in the same commit. Pin it here.
    expect(SENTINEL).toBe("no-use-effect skill exemption")
  })

  it("MAX_WALK is a reasonable ceiling", () => {
    expect(MAX_WALK).toBeGreaterThanOrEqual(100)
    expect(MAX_WALK).toBeLessThanOrEqual(1000)
  })

  it("CALL_SITE_PATTERNS covers both useEffect and useLayoutEffect", () => {
    expect(CALL_SITE_PATTERNS).toHaveLength(2)
    expect(CALL_SITE_PATTERNS.some((re) => re.test("React.useEffect("))).toBe(
      true
    )
    expect(
      CALL_SITE_PATTERNS.some((re) => re.test("React.useLayoutEffect("))
    ).toBe(true)
  })

  it('NAMED_IMPORT_PATTERN is anchored on `from "react"`', () => {
    expect(NAMED_IMPORT_PATTERN.test(`import { useEffect } from "react"`)).toBe(
      true
    )
    expect(
      NAMED_IMPORT_PATTERN.test(`import { useEffect } from "not-react"`)
    ).toBe(false)
  })
})
