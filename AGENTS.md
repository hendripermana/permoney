# Project: Permoney (https://permana.icu)

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.

## TanStack Intent — Agent Skills Discovery

The `<!-- intent-skills:start -->...<!-- intent-skills:end -->` block below is **auto-generated** by [`@tanstack/intent`](https://tanstack.com/intent/latest). It maps high-level tasks (the `when:` field) to versioned skill documents (the `use:` field) shipped inside installed npm packages. Skills update when the corresponding package updates — no copy-pasting stale rules files.

**Usage for AI agents:**

- When a user request matches a `when:` description, load the corresponding skill with:
  ```
  vp dlx @tanstack/intent@latest load <use>
  ```
  For example, to load the TanStack DB optimistic mutations skill: `vp dlx @tanstack/intent@latest load @tanstack/db#db-core/mutations-optimistic`.
- The auto-generated line inside the block mentions `npx` — **override that with `vp dlx`** per project Vite+ convention (see § _Common Pitfalls_).

**Maintenance commands (run after adding/removing dependencies):**

- `vp dlx @tanstack/intent@latest install --map` — regenerate the mapping block from currently installed packages. Safe to run anytime; only rewrites content between the markers.
- `vp dlx @tanstack/intent@latest stale` — verify mapped skills still exist and reference current versions.
- `vp dlx @tanstack/intent@latest list` — dump every discoverable skill from `node_modules` with descriptions.

**Do not hand-edit inside the markers.** Any manual edit is overwritten on the next `install --map`. To add project-specific rules, write them OUTSIDE the block (like this section).

<!-- intent-skills:start -->

# Skill mappings - load `use` with `npx @tanstack/intent@latest load <use>`.

skills:

- when: "TanStack DB core concepts: createCollection with queryCollectionOptions, electricCollectionOptions, powerSyncCollectionOptions, rxdbCollectionOptions, trailbaseCollectionOptions, localOnlyCollectionOptions. Live queries via query builder (from, where, join, select, groupBy, orderBy, limit). Optimistic mutations with draft proxy (collection.insert, collection.update, collection.delete). createOptimisticAction, createTransaction, createPacedMutations. Entry point for all TanStack DB skills."
  use: "@tanstack/db#db-core"
- when: "Creating typed collections with createCollection. Adapter selection: queryCollectionOptions (REST/TanStack Query), electricCollectionOptions (ElectricSQL real-time sync), powerSyncCollectionOptions (PowerSync SQLite), rxdbCollectionOptions (RxDB), trailbaseCollectionOptions (TrailBase), localOnlyCollectionOptions, localStorageCollectionOptions. CollectionConfig options: getKey, schema, sync, gcTime, autoIndex (default off), defaultIndexType, syncMode (eager/on-demand, plus progressive for Electric). StandardSchema validation with Zod/Valibot/ArkType. Collection lifecycle (idle/loading/ready/error). Adapter-specific sync patterns including Electric txid tracking, Query direct writes, and PowerSync query-driven sync with onLoad/onLoadSubset hooks."
  use: "@tanstack/db#db-core/collection-setup"
- when: "Building custom collection adapters for new backends. SyncConfig interface: sync function receiving begin, write, commit, markReady, truncate, metadata primitives. ChangeMessage format (insert, update, delete). loadSubset for on-demand sync. LoadSubsetOptions (where, orderBy, limit, cursor). Expression parsing: parseWhereExpression, parseOrderByExpression, extractSimpleComparisons, parseLoadSubsetOptions. Collection options creator pattern. rowUpdateMode (partial vs full). Subscription lifecycle and cleanup functions. Persisted sync metadata API (metadata.row and metadata.collection) for storing per-row and per-collection adapter state."
  use: "@tanstack/db#db-core/custom-adapter"
- when: "Query builder fluent API: from, where, join, leftJoin, rightJoin, innerJoin, fullJoin, select, fn.select, groupBy, having, orderBy, limit, offset, distinct, findOne. Operators: eq, gt, gte, lt, lte, like, ilike, inArray, isNull, isUndefined, and, or, not. Aggregates: count, sum, avg, min, max. String functions: upper, lower, length, concat, coalesce. Math: add. $selected namespace. createLiveQueryCollection. Derived collections. Predicate push-down. Incremental view maintenance via differential dataflow (d2ts). Virtual properties ($synced, $origin, $key, $collectionId). Includes subqueries for hierarchical data. toArray and concat(toArray(...)) scalar includes. queryOnce for one-shot queries. createEffect for reactive side effects (onEnter, onUpdate, onExit, onBatch)."
  use: "@tanstack/db#db-core/live-queries"
- when: "collection.insert, collection.update (Immer-style draft proxy), collection.delete. createOptimisticAction (onMutate + mutationFn). createPacedMutations with debounceStrategy, throttleStrategy, queueStrategy. createTransaction, getActiveTransaction, ambient transaction context. Transaction lifecycle (pending/persisting/completed/failed). Mutation merging. onInsert/onUpdate/onDelete handlers. PendingMutation type. Transaction.isPersisted."
  use: "@tanstack/db#db-core/mutations-optimistic"
- when: "SQLite-backed persistence for TanStack DB collections. persistedCollectionOptions wraps any adapter (Electric, Query, PowerSync, or local-only) with durable local storage. Platform adapters: browser (WA-SQLite OPFS), React Native (op-sqlite), Expo (expo-sqlite), Electron (IPC), Node (better-sqlite3), Capacitor, Tauri, Cloudflare Durable Objects. Multi-tab/multi-process coordination via BrowserCollectionCoordinator / ElectronCollectionCoordinator / SingleProcessCoordinator. schemaVersion for migration resets. Local-only mode for offline-first without a server."
  use: "@tanstack/db#db-core/persistence"
- when: "Integrating TanStack DB with meta-frameworks (TanStack Start, Next.js, Remix, Nuxt, SvelteKit). Client-side only: SSR is NOT supported — routes must disable SSR. Preloading collections in route loaders with collection.preload(). Pattern: ssr: false + await collection.preload() in loader. Multiple collection preloading with Promise.all. Framework-specific loader APIs."
  use: "@tanstack/db#meta-framework"
- when: "Two-way event patterns between devtools panel and application. App-to-devtools observation, devtools-to-app commands, time-travel debugging with snapshots and revert. structuredClone for snapshot safety, distinct event suffixes for observation vs commands, serializable payloads only."
  use: "@tanstack/devtools-event-client#devtools-bidirectional"
- when: "Create typed EventClient for a library. Define event maps with typed payloads, pluginId auto-prepend namespacing, emit()/on()/onAll()/onAllPluginEvents() API. Connection lifecycle (5 retries, 300ms), event queuing, enabled/disabled state, SSR fallbacks, singleton pattern. Unique pluginId requirement to avoid event collisions."
  use: "@tanstack/devtools-event-client#devtools-event-client"
- when: "Analyze library codebase for critical architecture and debugging points, add strategic event emissions. Identify middleware boundaries, state transitions, lifecycle hooks. Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload fields, guard emit() for production. Transparent server/client event bridging."
  use: "@tanstack/devtools-event-client#devtools-instrumentation"
- when: "Configure @tanstack/devtools-vite for source inspection (data-tsd-source, inspectHotkey, ignore patterns), console piping (client-to-server, server-to-client, levels), enhanced logging, server event bus (port, host, HTTPS), production stripping (removeDevtoolsOnBuild), editor integration (launch-editor, custom editor.open). Must be FIRST plugin in Vite config. Vite ^6 || ^7 only."
  use: "@tanstack/devtools-vite#devtools-vite-plugin"
- when: "React bindings for TanStack DB. useLiveQuery hook with dependency arrays (8 overloads: query function, config object, pre-created collection, disabled state via returning undefined/null). useLiveSuspenseQuery for React Suspense with Error Boundaries (data always defined). useLiveInfiniteQuery for cursor-based pagination (pageSize, fetchNextPage, hasNextPage, isFetchingNextPage). usePacedMutations for debounced React state updates. Return shape: data, state, collection, status, isLoading, isReady, isError. Import from @tanstack/react-db (re-exports all of @tanstack/db)."
  use: "@tanstack/react-db#react-db"
- when: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
  use: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
- when: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
  use: "@tanstack/react-start#react-start"
- when: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
  use: "@tanstack/react-start#react-start/server-components"
- when: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
  use: "@tanstack/router-core#router-core"
- when: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (\_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
  use: "@tanstack/router-core#router-core/auth-and-guards"
- when: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
  use: "@tanstack/router-core#router-core/code-splitting"
- when: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
  use: "@tanstack/router-core#router-core/data-loading"
- when: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
  use: "@tanstack/router-core#router-core/navigation"
- when: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
  use: "@tanstack/router-core#router-core/not-found-and-errors"
- when: "Dynamic path segments ($paramName), splat routes ($ / \_splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
  use: "@tanstack/router-core#router-core/path-params"
- when: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
  use: "@tanstack/router-core#router-core/search-params"
- when: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
  use: "@tanstack/router-core#router-core/ssr"
- when: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
  use: "@tanstack/router-core#router-core/type-safety"
- when: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
  use: "@tanstack/router-plugin#router-plugin"
- when: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
  use: "@tanstack/start-client-core#start-core"
- when: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
  use: "@tanstack/start-client-core#start-core/deployment"
- when: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE\_ prefix, process.env)."
  use: "@tanstack/start-client-core#start-core/execution-model"
- when: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
  use: "@tanstack/start-client-core#start-core/middleware"
- when: "createServerFn (GET/POST), inputValidator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
  use: "@tanstack/start-client-core#start-core/server-functions"
- when: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
  use: "@tanstack/start-client-core#start-core/server-routes"
- when: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
  use: "@tanstack/start-server-core#start-server-core"
- when: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."
  use: "@tanstack/virtual-file-routes#virtual-file-routes"
- when: "Load environment variables from a .env file into process.env for Node.js applications. Use when configuring apps with secrets, setting up local development environments, managing API keys and database uRLs, parsing .env file contents, or populating environment variables programmatically. Always use this skill when the user mentions .env, even for simple tasks like \"set up dotenv\" — the skill contains critical gotchas (encrypted keys, variable expansion, command substitution) that prevent common production issues."
  use: "dotenv#dotenv"
- when: "Use dotenvx to run commands with environment variables, manage multiple .env files, expand variables, and encrypt env files for safe commits and CI/CD."
  use: "dotenv#dotenvx"
- when: "Vite+ skill for development workflow and CLI operations. Use this skill to route user requests to the appropriate bundled Vite+ docs."
use: "vite-plus#vite-plus"
<!-- intent-skills:end -->

# 🚨 STRICT REACT & FRONTEND ENGINEERING RULES

As an AI Agent, you MUST follow these architectural rules for the Permoney project. Refusal to follow these leads to flaky code and infinite loops.

## 1. THE `useEffect` BAN (Declarative & Predictable Logic)

**Do NOT call `useEffect` directly.** To maintain a predictable and performant application, direct usage of `useEffect` is strictly forbidden unless it is the absolute only option.

**MANDATORY:** You MUST consult and strictly follow the [no-use-effect skill](.agents/skills/no-use-effect/SKILL.md) whenever you are dealing with state synchronization or side effects. The skill document provides the exact five replacement patterns required and the specific `useMountEffect` escape hatch.

## 2. STRICT TYPESCRIPT (NO `any` ALLOWED)

- **BANNED:** Never use the `any` keyword. It defeats the purpose of TypeScript.
- **INSTEAD:** Use explicit Interfaces, Types, or literal casting (e.g., `value as "expense" | "income"`). Rely on our Zod schemas (`transactionSchema`) for validation and type inference.

## 3. UI & DESIGN SYSTEM (shadcn/ui + Tailwind)

All UI components MUST remain strictly consistent with the overarching design guidelines and the shadcn/ui design system.

- **MANDATORY DESIGN DIRECTIVES**: Every single UI implementation and modification MUST strictly adhere to the rules outlined in [DESIGN.md](./DESIGN.md). You are strictly prohibited from writing UI code without first validating it against these design standards.
- **Source of Truth**: Always refer to [COMPONENTS.md](./COMPONENTS.md) and the `@/components/ui` directory before proposing or creating new components.
- **Component Addition**: DO NOT use `npx` or `pnpm dlx` directly. Use the Vite+ wrapper command ONLY: `vp dlx shadcn@latest add [component-name]`.
- **Styling**: Use Tailwind CSS utility classes exclusively. Inline styles (`style={{...}}`) are strictly prohibited.
- **Class Merging**: Use the `cn()` utility function for all class merging, especially for conditional rendering logic.
- **Icons**: Use `lucide-react` for all iconography to maintain visual consistency.
- **TanStack Integration**:
  - For **TanStack Table**, utilize primitives from `@/components/ui/table.tsx`.
  - For **TanStack Form**, utilize primitives from `@/components/ui/form.tsx`.
- **Language Standards**:
  - **Code & UI**: All user-facing text, variable names, and logic must be in **English**.
  - **Communication**: Inline code comments and chat explanations should be in **Indonesian** to serve as learning markers.

## Approved Community Registries

- **Shadcnblocks**: Use for complex layout shells and dashboard sections.
- **Kibo UI**: Use for advanced enterprise components and data-heavy tables.
- **Magic UI**: Use for high-end animations and interactive visual elements.

## Execution Rule

When adding a community component, always follow the Vite+ pattern:
`vp dlx shadcn@latest add @<registry>/<component-name>`

## 4. DIRECTORY STRUCTURE

- `@/components/ui`: Reserved for shadcn primitives (Atomic components).
- `@/components/blocks`: Reserved for complex components that compose multiple UI primitives (Molecules/Organisms).

## 5. THE TRANSACTION CORE ARCHITECTURE

Transactions are the heart of Permoney. To maintain a bulletproof ledger and high-performance UX, follow these architectural directives:

### A. Data Integrity & Double-Entry (Server-Side)

- **ACID Transactions**: Every financial mutation (Create/Update/Delete) MUST be wrapped in a `prisma.$transaction([])` block.
- **Signed Amounts**: At the Database level, `amount` must be SIGNED (Negative for Expense/Transfer Out, Positive for Income/Transfer In). The UI handles absolute values for display.
- **Atomic Balance Updates**: Never compute a new balance in memory and save it. Use Prisma's `{ increment: x }` or `{ decrement: x }` to avoid race conditions.
- **Split Transaction Normalization**: If `isSplit` is true, the `categoryId` and `merchantId` on the parent `Transaction` must be `null`. Data exclusively lives in the `SplitEntry` children.
- **Transfer Logic**: A `Transfer` is a dual-leg operation creating an Outflow and Inflow transaction. Use the `kind` field to distinguish between `funds_movement`, `cc_payment`, and `loan_payment`.

### B. Reactive Ledger (Client-Side)

- **TanStack DB Integration**: Use `useLiveQuery` from `@tanstack/react-db` for the main ledger view. This provides sub-10ms reactivity for local state.
- **MANDATORY Route Loader Preload**: Every route that calls `useLiveQuery(...)` against a collection MUST have a `loader` that awaits `collection.preload()`. Without this, `useLiveQuery` triggers `startSyncImmediate()` during the render phase; the async fetch resolves before child fibers commit, producing the React warning _"Can't perform a React state update on a component that hasn't mounted yet."_ The canonical route shape:

  ```tsx
  export const Route = createFileRoute("/transactions")({
    ssr: false, // TanStack DB collections are client-only
    loader: async () => {
      await transactionCollection.preload()
      return null
    },
    component: TransactionsPage,
  })
  ```

  Source: `node_modules/@tanstack/db/skills/meta-framework/SKILL.md` § _HIGH — Forgetting to preload in route loader_. Loader runs during navigation, blocks until collection reaches `status === "ready"`, so by the time the component renders there is zero async work in render.

- **`ssr: false` is a hard requirement for any route touching TanStack DB collections.** Collections are browser-only; SSR rendering will hang or error.
- **Synchronization**: After any server mutation (e.g., `createTransactionFn`), you MUST call `transactionCollection.utils.refetch()` to sync the local IndexedDB with the SQLite source of truth.
- **Optimistic Bulk UI**: For mass edits, perform an optimistic update on the `transactionCollection` draft before triggering `bulkUpdateTransactionsFn` for instant user feedback.

### C. Performance & State Orchestration

- **Memoized KPI Aggregation**: Use `useMemo` to derive financial KPIs (Net Cash Flow, Total Income) from the `filteredTransactions` array to prevent expensive recalculations on every render.
- **Search & Filter Pipeline**: Filtering logic must be separated into a pure utility (`applyFilters`) and synchronized with TanStack Router Search Params for persistent, shareable URLs.
- **The Singleton Edit Pattern**: Manage the "Edit Transaction" state via a singleton `editingTrx` state in the parent list, resetting with a `key` on the modal to ensure clean internal state.

### D. Bulk Mutation Engine & Smart Rules

- **Atomic Bulk Creation**: Use `bulkCreateTransactionsFn` for imports. It must calculate aggregate account deltas and apply them atomically.
- **Smart Rules Directives**: Automated mapping must leverage the `SmartRule` keyword engine during the ingestion phase, BEFORE presenting the preview to the user.

## 6. THE SERVER/CLIENT BOUNDARY (TanStack Start)

Permoney uses **TanStack Start**, NOT Next.js / Remix / React Server Components. Violating the server/client boundary crashes the app at runtime via the security trap in `src/server/db.ts` with message `🚨 SECURITY BREACH`. The following rules are non-negotiable because the cost of getting them wrong is shipping the Prisma client + `DATABASE_URL` into the user's browser.

### A. Directives — Hard Bans

- **BANNED: `"use server"`** at the top of any file. This is a React Server Components / Next.js directive. TanStack Start does NOT understand it; worse, its presence **disables** the `createServerFn` splitter on that file, causing `import { prisma } from "./db"` to ship to the browser. Source: `node_modules/@tanstack/start-client-core/skills/start-core/server-functions/SKILL.md` explicitly forbids it.
- **BANNED: `getServerSideProps`, `getStaticProps`, RSC `async` components.** These are Next.js patterns.
- **TOLERATED (no-op): `"use client"`.** Harmless shadcn boilerplate — TanStack Start ignores it. Do not add new ones, but do not churn existing files to remove them either.

### B. Server Function Authoring Rules

- **EVERY database access, secret API key read, and filesystem operation MUST be wrapped in `createServerFn(...).handler(...)`** — never in a route `loader`, never at module top-level of a shared file. Route loaders are **isomorphic** (run on BOTH server and client during navigation); putting `prisma.x` in a loader leaks it.
- **Input validation is mandatory.** Use `.inputValidator(z.object({...}))` with Zod. Never trust a client-sent `id`, `amount`, or `userId`.
- **Return values are the type contract.** Derive client-side types via `Awaited<ReturnType<typeof serverFn>>` — NEVER import Prisma model types directly into UI code. Example pattern:

  ```ts
  // src/lib/collections.ts
  type TransactionRecord = Awaited<ReturnType<typeof getTransactionsFn>>[number]
  ```

- **File organization (recommended but not enforced):** `*.server.ts` for server-only helpers, `*.functions.ts` for `createServerFn` wrappers. Currently `src/server/*.ts` hosts both — acceptable as long as every server-side value is reached only through `createServerFn` handler bodies.

### C. The `db.ts` Invariant — Side-Effect-Free Server Modules

The splitter replaces `.handler(body)` with an RPC stub on the client. The `import { prisma } from "./db"` line itself remains. Per ESM spec, a module with **top-level side effects** cannot be tree-shaken — it will execute in the browser.

**Therefore `src/server/db.ts` and any module reachable from it MUST be side-effect free at top level:**

- **BANNED:** `new PrismaClient(...)`, `new PrismaLibSql(...)`, `throw new Error(...)`, `globalThis.x = ...` at module scope.
- **REQUIRED:** All construction goes inside a factory function. Exports use a `Proxy` for lazy access, annotated with `/* @__PURE__ */` so Rolldown can eliminate the module entirely when no client code references it.
- **REQUIRED:** The `typeof window !== "undefined"` security trap lives INSIDE the factory (defense-in-depth), never at module scope.

Canonical implementation — do not regress from this pattern:

```ts
// src/server/db.ts — SIDE-EFFECT FREE
import { PrismaClient } from "@prisma/client"
import { PrismaLibSql } from "@prisma/adapter-libsql"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  if (typeof window !== "undefined") {
    throw new Error("🚨 SECURITY BREACH: db.ts leaked to client bundle.")
  }
  const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL! })
  const client = new PrismaClient({ adapter })
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client
  return client
}

export const prisma: PrismaClient = /* @__PURE__ */ new Proxy(
  {} as PrismaClient,
  {
    get(_t, prop) {
      const client = globalForPrisma.prisma ?? createPrismaClient()
      const value = Reflect.get(client, prop) as unknown
      return typeof value === "function"
        ? (value as (...a: Array<unknown>) => unknown).bind(client)
        : value
    },
  }
)
```

### D. Why This Architecture — Historical Bugs to Never Repeat

Past AI-introduced regressions that triggered the security trap (documented so future agents do not repeat them):

1. **Adding `"use server"` directives.** Disables splitter → full handler bodies + prisma import ship to browser.
2. **Eager Prisma construction at module scope.** `export const prisma = new PrismaClient(...)` is a top-level side effect → Vite refuses to tree-shake → module evaluates on the client → `@prisma/client` (~MB of Node-only code) + trap fires.
3. **Database calls in route `loader`.** Loaders are isomorphic; `await prisma.x()` in a loader hits the client during SPA navigation.
4. **Importing Prisma model types into UI.** Couples the client to `@prisma/client`. Use `Awaited<ReturnType<typeof serverFn>>` instead.

### E. Review Checklist Before Touching Server Code

- [ ] No `"use server"` / `"use client"` added to server files.
- [ ] All `prisma.x` access is inside `createServerFn(...).handler(...)` bodies, never at module scope, never in loaders.
- [ ] `src/server/db.ts` remains a lazy Proxy with `/* @__PURE__ */` annotation and zero module-level side effects.
- [ ] Client-side types derive from `Awaited<ReturnType<typeof fn>>`, not from `@prisma/client`.
- [ ] `vp check` and `vp test` pass; `/transactions` loads without the `🚨 SECURITY BREACH` error.
