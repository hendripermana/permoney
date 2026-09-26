import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

/**
 * Structured server log (F1 audit S5.1).
 *
 * One JSON object per line, on stdout for `debug`/`info` and stderr for
 * `warn`/`error`, so `docker logs` output is greppable and a future shipper
 * needs no parsing rules.
 *
 * The hard constraint: **this app moves money, so a log line must never carry
 * money or identity payloads.** It carries identifiers, an error NAME, a
 * scrubbed error MESSAGE, and nothing else — no request bodies, no amounts, no
 * descriptions, no emails, no tokens. Two mechanisms enforce that:
 *
 *   1. `ServerLogEvent` is a CLOSED shape (no index signature). A caller
 *      cannot spread a payload into a log line by accident; adding a field is a
 *      deliberate, reviewable edit to this file.
 *   2. Every free-text value goes through `scrubLogText`, which redacts
 *      emails, opaque tokens and long digit runs (amounts, epoch stamps).
 *
 * We also deliberately do NOT log whole error objects or their `.stack`. Prisma
 * errors carry `meta` containing the offending VALUES, and stacks leak file
 * paths and arguments — both are payloads by another name.
 *
 * Context (`requestId`, `userId`, `familyId`) rides in an AsyncLocalStorage so
 * that a log call from anywhere inside a request carries correlation ids
 * without threading them through every function signature. `requestId` is
 * minted per RPC call and is the join key against whatever the client reported.
 */

export type ServerLogLevel = "debug" | "info" | "warn" | "error"

export interface ServerLogContext {
  requestId: string
  userId?: string
  familyId?: string
  memberId?: string
}

/**
 * The complete set of fields a log line may carry. Closed on purpose — see the
 * module comment.
 */
export interface ServerLogEvent {
  level: ServerLogLevel
  /** Stable machine-readable name, e.g. `server_fn_error`. Never user input. */
  event: string
  /** Server function name, from TanStack's `serverFnMeta`. */
  fn?: string
  /** Source file of the server function, from `serverFnMeta`. */
  fnFile?: string
  /** `error.name` — a class name, not a message. */
  errorName?: string
  /** Scrubbed error message. */
  message?: string
  /** Wall time the operation took, in ms. */
  durationMs?: number
  /** Retry attempt number (1-based), where a caller is retrying. */
  attempt?: number
  /** Retry ceiling, where a caller is retrying. */
  maxAttempts?: number
  /** Short outcome token, e.g. `rejected`. Never user input. */
  outcome?: string
  /** Row/record count, where a caller genuinely has one. */
  count?: number
  /** HTTP-ish status, where a caller genuinely has one. */
  status?: number
}

export const REDACTED_EMAIL = "<email>"
export const REDACTED_OPAQUE = "<opaque>"
export const REDACTED_NUMBER = "<number>"
const MAX_TEXT_LENGTH = 400

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_-]{32,}/g
const LONG_DIGIT_PATTERN = /\d{6,}/g

/**
 * Redact payload-shaped text. Order matters: emails first (so their domain is
 * not half-eaten), then opaque tokens, then digit runs. Truncation bounds the
 * line so one pathological message cannot flood the log.
 */
export function scrubLogText(text: string): string {
  return text
    .replace(EMAIL_PATTERN, REDACTED_EMAIL)
    .replace(OPAQUE_TOKEN_PATTERN, REDACTED_OPAQUE)
    .replace(LONG_DIGIT_PATTERN, REDACTED_NUMBER)
    .slice(0, MAX_TEXT_LENGTH)
}

/**
 * Build the JSON line. Pure and exported so the redaction/shape contract can
 * be asserted without touching stdout.
 */
export function buildLogLine(
  event: ServerLogEvent,
  context: ServerLogContext | undefined,
  now: Date = new Date()
): Record<string, string | number> {
  const line: Record<string, string | number> = {
    timestamp: now.toISOString(),
    level: event.level,
    event: scrubLogText(event.event),
    requestId: context?.requestId ?? "",
  }

  if (context?.userId) line.userId = context.userId
  if (context?.familyId) line.familyId = context.familyId
  if (context?.memberId) line.memberId = context.memberId
  if (event.fn) line.fn = scrubLogText(event.fn)
  if (event.fnFile) line.fnFile = scrubLogText(event.fnFile)
  if (event.errorName) line.errorName = scrubLogText(event.errorName)
  if (event.message !== undefined) line.message = scrubLogText(event.message)
  if (event.outcome) line.outcome = scrubLogText(event.outcome)
  if (event.durationMs !== undefined) line.durationMs = event.durationMs
  if (event.attempt !== undefined) line.attempt = event.attempt
  if (event.maxAttempts !== undefined) line.maxAttempts = event.maxAttempts
  if (event.count !== undefined) line.count = event.count
  if (event.status !== undefined) line.status = event.status

  return line
}

const logContextStore = new AsyncLocalStorage<ServerLogContext>()

/**
 * Runs `fn` with a fresh log context. The outermost per-request middleware
 * calls this exactly once, so every nested log line shares its `requestId`.
 */
export async function withServerLogContext<T>(
  fn: () => Promise<T>,
  seed: Partial<ServerLogContext> = {}
): Promise<T> {
  const context: ServerLogContext = {
    requestId: seed.requestId ?? randomUUID(),
    ...seed,
  }
  return await logContextStore.run(context, fn)
}

/**
 * Adds fields the middleware chain learns as it resolves (auth knows the user;
 * the family guard knows the family). No-op outside a log context, so it is
 * always safe to call.
 */
export function updateServerLogContext(
  patch: Partial<Omit<ServerLogContext, "requestId">>
): void {
  const context = logContextStore.getStore()
  if (!context) {
    return
  }
  Object.assign(context, patch)
}

export function getServerLogContext(): Readonly<ServerLogContext> | undefined {
  return logContextStore.getStore()
}

export function logEvent(event: ServerLogEvent): void {
  const line = buildLogLine(event, logContextStore.getStore())
  const serialized = JSON.stringify(line)
  if (event.level === "warn" || event.level === "error") {
    console.error(serialized)
  } else {
    console.log(serialized)
  }
}

export interface ServerErrorLogMeta {
  fn?: string
  fnFile?: string
  durationMs?: number
}

/**
 * Logs a thrown value and rethrows it unchanged. Extracted so the middleware
 * body is a single call and the behaviour ("one line, then the original error
 * keeps propagating") is testable against a real database failure.
 */
export function logAndRethrow(
  error: unknown,
  meta: ServerErrorLogMeta = {}
): never {
  logEvent({
    level: "error",
    event: "server_fn_error",
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    fn: meta.fn,
    fnFile: meta.fnFile,
    durationMs: meta.durationMs,
  })
  throw error
}
