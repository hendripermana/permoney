// PER-187: typed replacement for the bare `Error("UNAUTHENTICATED")` /
// `Error("NOT_A_MEMBER")` / `Error("FORBIDDEN")` throws in
// `src/server/middleware/session.ts` (the M3-5 "AppError" tech debt the
// comments there already flagged). Lives outside `*.server.ts` on purpose:
// it has no Prisma/secret/Node dependency, so both the server middleware and
// the client-side query client can import it directly.
//
// NOTE on the client/server boundary (verified against the running dev
// server, not assumed): TanStack Start's default seroval plugins include
// `ShallowErrorPlugin` (@tanstack/router-core), which intercepts every
// thrown `Error` crossing a server-fn RPC call and serializes ONLY
// `.message` — `.name`, `.code`, and every other own property are dropped,
// and the client deserializes to a plain `new Error(message)`. So across
// that boundary, `.code` never survives and `instanceof AppError` is always
// false. `.message` is the only field guaranteed to cross intact, which is
// why `hasAuthErrorCode` below checks `.code` first (for same-process
// callers, e.g. integration tests invoking server functions directly) and
// falls back to `.message` (for the browser, post-RPC case this ticket is
// about). Both checks compare against the same small closed enum below, not
// a fuzzy substring — this is as "typed" a discriminator as this framework
// boundary allows.
export type AuthErrorCode = "UNAUTHENTICATED" | "NOT_A_MEMBER" | "FORBIDDEN"

const AUTH_ERROR_CODES: ReadonlySet<string> = new Set<AuthErrorCode>([
  "UNAUTHENTICATED",
  "NOT_A_MEMBER",
  "FORBIDDEN",
])

// Subset of AuthErrorCode that means the session itself is gone, as opposed
// to FORBIDDEN (a valid session lacking a capability). Only this subset
// should ever force a redirect to /login.
const SESSION_LOSS_CODES: ReadonlySet<string> = new Set<AuthErrorCode>([
  "UNAUTHENTICATED",
  "NOT_A_MEMBER",
])

export class AppError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code)
    this.name = "AppError"
    this.code = code
  }
}

function extractAuthErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const ownCode = (error as { code?: unknown }).code
  if (typeof ownCode === "string") return ownCode
  // RPC-crossed errors lose everything but `.message` (see note above) —
  // AppError's constructor defaults `message` to the code itself, so this
  // still matches the exact canonical string, not a human sentence.
  return error.message
}

// True for any typed auth-class error (UNAUTHENTICATED, NOT_A_MEMBER,
// FORBIDDEN). None of these are ever transient, so callers should never
// retry them.
export function isAuthError(error: unknown): boolean {
  const code = extractAuthErrorCode(error)
  return code !== undefined && AUTH_ERROR_CODES.has(code)
}

// True only when the session itself is gone. Callers use this narrower
// check to decide whether to force a redirect to /login; FORBIDDEN should
// surface inline instead, since the user is still authenticated.
export function isSessionLossError(error: unknown): boolean {
  const code = extractAuthErrorCode(error)
  return code !== undefined && SESSION_LOSS_CODES.has(code)
}
