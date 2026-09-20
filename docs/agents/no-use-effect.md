# No `useEffect` — the rule, the five replacements, the escape hatch

This is the project rule that `AGENTS.md` marks **MANDATORY** for any work
involving state synchronization or side effects. It lives here, in a tracked
file, because the skill harness under `.agents/` is gitignored: a fresh clone
must still be able to read the rule that governs its own React code.

> **Never call `useEffect` directly.** Use derived state, event handlers,
> data-fetching libraries, or `useMountEffect` instead.

The rule is enforced mechanically, not just by review:

| Layer        | Where                                                      | What it does                                                          |
| ------------ | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| ESLint       | `eslint.config.js` — `no-restricted-syntax`                | bans importing/calling `useEffect`                                    |
| Guard script | `scripts/check-no-use-effect.mjs` (runs in `vp run check`) | walks `src/**` and fails on banned imports and unjustified call sites |
| Escape hatch | `src/hooks/use-mount-effect.ts`                            | the only sanctioned `useEffect` call site                             |

An exemption is a comment containing the literal string
`no-use-effect skill exemption` in the contiguous comment block immediately
above the call, and the guard script treats that as reviewed intent:

```ts
// no-use-effect skill exemption: subscribing to a browser event that has no
// declarative equivalent in this codebase.
useEffect(() => {
  window.addEventListener("resize", onResize)
  return () => window.removeEventListener("resize", onResize)
}, [onResize])
```

Without that sentinel, `scripts/check-no-use-effect.mjs` fails the build.

## Quick reference

| Instead of `useEffect` for…           | Use                                         |
| ------------------------------------- | ------------------------------------------- |
| Deriving state from other state/props | Inline computation (Rule 1)                 |
| Fetching data                         | `useQuery` / data-fetching library (Rule 2) |
| Responding to user actions            | Event handlers (Rule 3)                     |
| One-time external sync on mount       | `useMountEffect` (Rule 4)                   |
| Resetting state when a prop changes   | `key` prop on parent (Rule 5)               |

Background: React's [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect).
In Permoney, TanStack DB collections plus `useLiveQuery` are the sanctioned
data-fetching path, and TanStack Router loaders preload collections — neither
needs an effect to stay in sync.

## The escape hatch: `useMountEffect`

For the rare case where you must sync with an external system on mount:

```ts
export function useMountEffect(effect: () => void | (() => void)) {
  /* eslint-disable no-restricted-syntax */
  useEffect(effect, [])
}
```

## Rule 1 — Derive state, do not sync it

Most effects that set state from other state are unnecessary and add an extra
render.

```tsx
// BAD: two render cycles — first stale, then filtered
function ProductList() {
  const [products, setProducts] = useState([])
  const [filtered, setFiltered] = useState([])

  useEffect(() => {
    setFiltered(products.filter((p) => p.inStock))
  }, [products])
}

// GOOD: compute inline in one render
function ProductList() {
  const [products, setProducts] = useState([])
  const filtered = products.filter((p) => p.inStock)
}
```

**Smell test:** you are about to write `useEffect(() => setX(derive(y)), [y])`,
or you have state that only mirrors other state or props.

## Rule 2 — Use data-fetching libraries

Effect-based fetching creates race conditions and duplicates caching logic.

```tsx
// BAD: race-condition risk
useEffect(() => {
  fetchProduct(productId).then(setProduct)
}, [productId])

// GOOD: the query library handles cancellation/caching/staleness
const { data: product } = useQuery(["product", productId], () =>
  fetchProduct(productId)
)
```

**Smell test:** your effect does `fetch(...)` then `setState(...)`, or you are
re-implementing caching, retries, cancellation, or stale handling.

## Rule 3 — Event handlers, not effects

If the user clicked something, do the work in the handler.

```tsx
// BAD: an effect used as an action relay
useEffect(() => {
  if (liked) {
    postLike()
    setLiked(false)
  }
}, [liked])

// GOOD: act directly
<button onClick={() => postLike()}>Like</button>
```

**Smell test:** state exists only as a flag so an effect can do the real action
("set flag → effect runs → reset flag").

## Rule 4 — `useMountEffect` for one-time external sync

Good uses: DOM integration (focus, scroll), third-party widget lifecycles,
browser API subscriptions.

```tsx
// BAD: guard inside the effect
useEffect(() => {
  if (!isLoading) playVideo()
}, [isLoading])

// GOOD: mount only once preconditions are met
function VideoPlayerWrapper({ isLoading }: { isLoading: boolean }) {
  if (isLoading) return <LoadingScreen />
  return <VideoPlayer />
}

function VideoPlayer() {
  useMountEffect(() => playVideo())
}
```

Use it when the dependency is genuinely stable (singletons, refs, context
values that never change):

```ts
// BAD: a dependency that never changes
useEffect(() => {
  connectionManager.on("connected", handleConnect)
  return () => connectionManager.off("connected", handleConnect)
}, [connectionManager])

// GOOD
useMountEffect(() => {
  connectionManager.on("connected", handleConnect)
  return () => connectionManager.off("connected", handleConnect)
})
```

**Smell test:** you are synchronizing with an external system and the behaviour
is naturally "setup on mount, cleanup on unmount".

## Rule 5 — Reset with `key`, not dependency choreography

```tsx
// BAD: emulating remount behaviour with an effect
useEffect(() => {
  loadVideo(videoId)
}, [videoId])

// GOOD: `key` forces a clean remount
function VideoPlayerWrapper({ videoId }: { videoId: string }) {
  return <VideoPlayer key={videoId} videoId={videoId} />
}

function VideoPlayer({ videoId }: { videoId: string }) {
  useMountEffect(() => {
    loadVideo(videoId)
  })
}
```

**Smell test:** the effect's only job is to reset local state when an id/prop
changes, or you want a fresh instance per entity.

## Component structure convention

Computed values come after hooks and local state, never via `useEffect`:

```tsx
export function FeatureComponent({ featureId }: ComponentProps) {
  // Hooks first
  const { data, isLoading } = useQueryFeature(featureId)

  // Local state
  const [isOpen, setIsOpen] = useState(false)

  // Computed values (NOT useEffect + setState)
  const displayName = user?.name ?? "Unknown"

  // Event handlers
  const handleClick = () => {
    setIsOpen(true)
  }

  // Early returns
  if (isLoading) return <Loading />

  // Render
  return <div>…</div>
}
```

## Verifying a change

```sh
vp run check        # format + lint + types + the no-use-effect guard
vp run test:unit:coverage
```

If you are refactoring an existing `useEffect`, keep the change and the updated
tests in the same commit.
