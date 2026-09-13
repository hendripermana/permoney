import { requestHandler } from "@tanstack/react-start/server"

// =============================================================================
// Execute a REAL createServerFn through its SERVER path inside an integration
// test, so `familyMiddleware` / `requireCapability` actually run.
//
// Integration tests normally call the `*ForFamily` service layer directly, which
// deliberately BYPASSES the middleware gate. A test whose subject IS the gate
// ("does the HTTP-facing endpoint reject a member without the required
// capability?") must run the server fn's server path.
//
// NOTE: calling the exported server fn directly (`someFn({ data })`) does NOT
// run the server middlewares. The framework's direct-call path is its CLIENT
// path (it exists to issue the RPC), so it skips every `.server(...)`
// middleware and calls the handler with an empty context. The server path is
// `__executeServer`, which is what an incoming RPC invokes. This helper calls
// that, inside the two request-scoped stores the framework sets up per request:
//
//   1. the h3 event store — provided by the framework's public `requestHandler`
//      wrapper. `getRequest()` (used by `authMiddleware`) reads it, so the
//      factory's authenticated `Request` (session cookie headers) flows through
//      the same path a browser call would.
//   2. TanStack Start's storage context — a per-process AsyncLocalStorage keyed
//      by the registered symbol below. `createServerFn` reads it for start
//      options and the request context. Because it is a `globalThis` singleton
//      keyed by `Symbol.for(...)`, this helper reaches the exact instance the
//      framework uses; no extra dependency is required.
//
// The fabricated start context carries only what the server path reads: the
// request, the (empty) start options, and the global-middleware context. If a
// framework upgrade changes that contract, these tests fail loudly here.
//
// WHAT RUNS, AND WHAT DOES NOT: the middleware chain is real — `authMiddleware`
// resolves the session from the request cookies, `familyMiddleware` resolves the
// active membership from Postgres, and `requireCapability` applies the role
// matrix — as is the input validator. The HANDLER BODY does not run here: the
// framework only wires the handler into the server path when its Vite plugin has
// compiled the module for the dev/build server (`?tss-serverfn-split`), which
// vitest does not apply. Assert on the gate (rejection or pass-through), not on
// handler side effects; side-effect correctness belongs to the service-layer
// integration tests that call the `*ForFamily` functions directly.
// =============================================================================

const START_STORAGE_KEY = Symbol.for("tanstack-start:start-storage-context")

interface AsyncStorageLike<Store> {
  run: <Result>(store: Store, fn: () => Result) => Result
}

interface StartStorageContextLike {
  getRouter: () => Promise<never>
  request: Request
  startOptions: Record<string, never>
  contextAfterGlobalMiddlewares: Record<string, never>
  executedRequestMiddlewares: Set<unknown>
  handlerType: "serverFn"
}

export type ServerFnOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: unknown }

/** The server entry `createServerFn` exposes for an incoming RPC. */
type ServerEntry = (options: {
  data?: unknown
}) => Promise<{ result?: unknown; error?: unknown }>

/**
 * Read `__executeServer` off a server-fn export without asserting its type: the
 * export's own call signature is a large framework type, so the property is
 * validated at runtime and wrapped into a small local contract.
 */
function getServerEntry(serverFn: object): ServerEntry | null {
  if (!("__executeServer" in serverFn)) return null
  const candidate: unknown = serverFn.__executeServer
  if (typeof candidate !== "function") return null

  return async (options) => {
    const raw: unknown = await Reflect.apply(candidate, undefined, [options])
    if (typeof raw !== "object" || raw === null) return {}
    return {
      result: "result" in raw ? raw.result : undefined,
      error: "error" in raw ? raw.error : undefined,
    }
  }
}

function isAsyncStorageLike(
  value: unknown
): value is AsyncStorageLike<StartStorageContextLike> {
  if (typeof value !== "object" || value === null || !("run" in value)) {
    return false
  }
  return typeof value.run === "function"
}

function getStartStorage(): AsyncStorageLike<StartStorageContextLike> {
  const store: unknown = Reflect.get(globalThis, START_STORAGE_KEY)
  if (!isAsyncStorageLike(store)) {
    throw new Error(
      "TanStack Start storage context is not initialized; the framework's " +
        "AsyncLocalStorage singleton was not found on globalThis."
    )
  }
  return store
}

function createStartContext(request: Request): StartStorageContextLike {
  return {
    getRouter: () => {
      throw new Error("No router is available in a server-function test")
    },
    request,
    startOptions: {},
    contextAfterGlobalMiddlewares: {},
    executedRequestMiddlewares: new Set(),
    handlerType: "serverFn",
  }
}

/**
 * Run `serverFn`'s server path (middleware chain + input validator, then the
 * handler when the framework has compiled it) with `user.request` as the ambient
 * request. Returns the handler's result, or the error the chain raised — e.g.
 * the middleware's `AppError("FORBIDDEN")` when the gate rejects.
 */
export async function callServerFnAs(
  user: { request: Request },
  serverFn: object,
  data: unknown = {}
): Promise<ServerFnOutcome> {
  const execute = getServerEntry(serverFn)
  if (!execute) {
    throw new Error(
      "callServerFnAs: the export is not a createServerFn (no __executeServer)"
    )
  }

  let outcome: ServerFnOutcome = {
    ok: false,
    error: new Error("server function did not run"),
  }

  const handler = requestHandler(async () =>
    getStartStorage().run(createStartContext(user.request), async () => {
      const { result, error } = await execute({ data })
      outcome =
        error === undefined ? { ok: true, result } : { ok: false, error }
      return new Response(null, { status: 204 })
    })
  )

  await handler(user.request, undefined)
  return outcome
}
