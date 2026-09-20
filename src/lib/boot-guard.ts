/**
 * Boot guard resilience (F1 audit B5).
 *
 * Production incident this exists for: on a flaky route, the FIRST
 * session/auth call of a session — the one the `_protected` layout's
 * `beforeLoad` guard makes — stalled, and the browser sat on a blank loading
 * screen forever. There was no timeout, no retry, and no failure state.
 *
 * This module is deliberately framework-free and side-effect-free so it can be
 * unit-tested without a router, a DOM, or a server. The route wiring lives in
 * `src/routes/_protected.tsx`; the UI lives in
 * `src/components/blocks/boot-unreachable-panel.tsx`.
 *
 * Two properties are load-bearing:
 *
 * 1. **A per-attempt timeout, not a total one.** A slow-but-successful call
 *    must still work (the incident's flip side would be killing a request that
 *    was merely slow), so each attempt gets a full budget and the retry only
 *    happens once an attempt has actually timed out or failed.
 * 2. **The error carries no payload.** It names the reason and the attempt
 *    count and nothing else — no URL, no response body, no server message.
 *    It is rendered straight into a user-visible fallback.
 */

/** Why the boot guard gave up. Drives the copy the user sees. */
export type BootUnreachableReason = "offline" | "timeout" | "unreachable"

const REASON_COPY: Record<BootUnreachableReason, string> = {
  offline: "This device has no network connection.",
  timeout: "The server did not answer in time.",
  unreachable: "The server could not be reached.",
}

export class BootUnreachableError extends Error {
  override readonly name = "BootUnreachableError"
  readonly reason: BootUnreachableReason
  readonly attempts: number

  constructor(reason: BootUnreachableReason, attempts: number) {
    // Plain language, no payload: this string can reach a user's screen.
    super(`Permoney could not be reached (${REASON_COPY[reason]})`)
    this.reason = reason
    this.attempts = attempts
  }
}

export function isBootUnreachableError(
  value: unknown
): value is BootUnreachableError {
  return value instanceof BootUnreachableError
}

/**
 * Reject with `onTimeout()` after `timeoutMs` if `promise` has not settled.
 *
 * The underlying work is intentionally NOT cancelled: a TanStack Start server
 * fn call cannot be aborted from here, and a late success is harmless because
 * the caller has already moved on. The timer is always cleared, so a fast
 * success leaves no pending timer behind (asserted in the unit tests).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Exponential backoff, capped. Attempt 1 waits `baseDelayMs`, attempt 2 twice
 * that, and so on — bounded so a long outage never parks on a multi-minute
 * sleep.
 */
export function computeBootBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  if (attempt < 1) return 0
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
}

export interface BootRetryConfig {
  /** Total attempts, including the first. Default 3. */
  attempts?: number
  /** Budget for ONE attempt. Default 6000 ms. */
  timeoutMs?: number
  /** First backoff delay; doubles per attempt. Default 400 ms. */
  baseDelayMs?: number
  /** Backoff ceiling. Default 4000 ms. */
  maxDelayMs?: number
  /**
   * Injected for tests. Defaults to the browser's `navigator.onLine` when it
   * exists, else `true` (a non-browser caller has no offline concept).
   */
  isOnline?: () => boolean
  /** Injected for tests. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>
}

function defaultIsOnline(): boolean {
  if (typeof navigator === "undefined") return true
  // `navigator.onLine === false` means "no network", not "server unreachable" —
  // on a self-hosted LAN deployment the server can still answer, so the caller
  // still gets ONE attempt (see `callWithBootRetry`).
  return navigator.onLine !== false
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Call `call()` with a bounded timeout and a small retry-with-backoff.
 *
 * Offline short-circuit: when `isOnline()` is false the attempt count drops to
 * ONE. Retrying three times against a connection the browser already knows is
 * down wastes the user's time and delays the honest "you're offline" state;
 * trying once keeps the LAN case working.
 *
 * Throws `BootUnreachableError` — never the underlying error — once the budget
 * is spent. The last failure's reason is preserved only as "timeout" versus
 * "unreachable", so nothing from the transport can leak into the UI.
 */
export async function callWithBootRetry<T>(
  call: () => Promise<T>,
  config: BootRetryConfig = {}
): Promise<T> {
  const {
    attempts: configuredAttempts = 3,
    timeoutMs = 6000,
    baseDelayMs = 400,
    maxDelayMs = 4000,
    isOnline = defaultIsOnline,
    sleep = defaultSleep,
  } = config

  const online = isOnline()
  const attempts = online ? configuredAttempts : 1
  let lastWasTimeout = false

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTimeout(
        call(),
        timeoutMs,
        () => new BootUnreachableError("timeout", attempt) as unknown as Error
      )
    } catch (error) {
      // A BootUnreachableError raised by the timeout wrapper is the only
      // "timed out" signal; anything the call itself threw is "unreachable".
      lastWasTimeout =
        isBootUnreachableError(error) && error.reason === "timeout"
      if (attempt === attempts) break
      await sleep(computeBootBackoffDelayMs(attempt, baseDelayMs, maxDelayMs))
    }
  }

  throw new BootUnreachableError(
    !online ? "offline" : lastWasTimeout ? "timeout" : "unreachable",
    attempts
  )
}
