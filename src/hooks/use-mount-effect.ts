import * as React from "react"

/**
 * `useMountEffect` — the project's blessed escape hatch for `useEffect`.
 *
 * Per the `no-use-effect` convention (see `.agents/skills/no-use-effect/`),
 * raw `useEffect` is banned in favor of:
 *
 *   1. Inline computation (derived state)
 *   2. Data-fetching libraries (`useQuery`, TanStack DB, etc.)
 *   3. Event handlers
 *   4. `useMountEffect` for one-time external sync (← this file)
 *   5. `key` prop for state reset on identity change
 *
 * Use this helper when — and only when — you need to synchronize with an
 * external system whose lifecycle naturally maps to "setup on mount,
 * cleanup on unmount." Canonical good uses:
 *
 *   - Browser API subscriptions: `matchMedia`, `addEventListener`,
 *     `IntersectionObserver`, `ResizeObserver`
 *   - Third-party widget bootstrap with stable singletons
 *   - One-shot DOM imperatives that don't track changing props
 *
 * If a dependency could change during the component's lifetime, do NOT
 * widen this hook to accept a deps array — that defeats its intent.
 * Instead, capture the changing value via a ref:
 *
 *   const cbRef = React.useRef(callback)
 *   cbRef.current = callback   // updated every render, no closure capture
 *   useMountEffect(() => {
 *     const handler = () => cbRef.current()
 *     window.addEventListener("event", handler)
 *     return () => window.removeEventListener("event", handler)
 *   })
 *
 * The empty dependency array is the entire point of this abstraction:
 * it makes "run once" a load-bearing semantic, surfaced in the call
 * site, rather than something a reviewer has to infer from `[]`.
 */
export function useMountEffect(
  effect: () => void | (() => void | undefined)
): void {
  // The lint rule `react-hooks/exhaustive-deps` would normally complain
  // here; we silence it because the empty deps array is intentional and
  // is the documented contract of this helper.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(effect, [])
}
