import type { Prisma } from "@prisma/client"

export interface SerializableRetryEvent {
  attempt: number
  errorName: string
  maxRetries: number
  nextDelayMs: number
}

export interface SerializableRetryOptions {
  baseDelayMs?: number
  jitterRatio?: number
  maxRetries?: number
  maxWait?: number
  onRetry?: (event: SerializableRetryEvent) => void
  timeout?: number
}

export interface SerializableRetryClient {
  $transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel
      maxWait?: number
      timeout?: number
    }
  ): Promise<T>
}

export class BalanceConflictError extends Error {
  override readonly name = "BalanceConflictError"

  constructor(attempts: number, cause?: unknown) {
    super(
      `Account balance conflict could not be resolved after ${attempts} attempt(s)`,
      { cause }
    )
  }
}

export class VersionDriftError extends Error {
  override readonly name = "VersionDriftError"

  constructor(message = "Account balance version drift detected") {
    super(message)
  }
}

export async function withSerializableRetry<T>(
  client: SerializableRetryClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: SerializableRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 50
  const jitterRatio = opts.jitterRatio ?? 0.2

  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    try {
      return await client.$transaction(fn, {
        isolationLevel: "Serializable" as Prisma.TransactionIsolationLevel,
        maxWait: opts.maxWait,
        timeout: opts.timeout,
      })
    } catch (error) {
      if (!isRetryableConcurrencyError(error)) {
        throw error
      }

      const attemptsSoFar = attemptIndex + 1
      if (attemptIndex >= maxRetries) {
        throw new BalanceConflictError(attemptsSoFar, error)
      }

      const retryAttempt = attemptIndex + 1
      const nextDelayMs = computeBackoffDelayMs({
        baseDelayMs,
        jitterRatio,
        retryAttempt,
      })
      const errorName = readErrorName(error)

      opts.onRetry?.({
        attempt: retryAttempt,
        errorName,
        maxRetries,
        nextDelayMs,
      })

      // TODO(M3-5): ganti dengan structured logger + retry metric.
      console.warn(
        `[PER-18] Retrying Serializable transaction after ${errorName} ` +
          `(${retryAttempt}/${maxRetries})`
      )

      if (nextDelayMs > 0) {
        await sleep(nextDelayMs)
      }
    }
  }

  throw new BalanceConflictError(maxRetries + 1)
}

export function isRetryableConcurrencyError(error: unknown): boolean {
  if (error instanceof VersionDriftError) {
    return true
  }

  if (typeof error === "string") {
    return error.includes("40001") || error.includes("serialization_failure")
  }

  if (typeof error !== "object" || error === null) {
    return false
  }

  const code = readStringProperty(error, "code")
  if (code === "40001" || code === "P2034") {
    return true
  }

  const message = readStringProperty(error, "message")
  if (
    message?.includes("40001") ||
    message?.includes("serialization_failure")
  ) {
    return true
  }

  const meta = readUnknownProperty(error, "meta")
  if (isRetryableConcurrencyError(meta)) {
    return true
  }

  const cause = readUnknownProperty(error, "cause")
  return cause === undefined ? false : isRetryableConcurrencyError(cause)
}

function computeBackoffDelayMs({
  baseDelayMs,
  jitterRatio,
  retryAttempt,
}: {
  baseDelayMs: number
  jitterRatio: number
  retryAttempt: number
}): number {
  const rawDelay = baseDelayMs * 2 ** (retryAttempt - 1)
  if (rawDelay <= 0) return 0
  if (jitterRatio <= 0) return Math.round(rawDelay)

  const boundedJitterRatio = Math.min(jitterRatio, 1)
  const randomUnit = readCryptoRandomUnit()
  const jitterMultiplier = 1 + (randomUnit * 2 - 1) * boundedJitterRatio
  return Math.max(0, Math.round(rawDelay * jitterMultiplier))
}

function readCryptoRandomUnit(): number {
  if (!globalThis.crypto) {
    return 0.5
  }

  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0]! / 0xffffffff
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readErrorName(error: unknown): string {
  return readStringProperty(error, "name") ?? "Error"
}

function readStringProperty(
  value: unknown,
  property: string
): string | undefined {
  const prop = readUnknownProperty(value, property)
  return typeof prop === "string" ? prop : undefined
}

function readUnknownProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  return (value as Record<string, unknown>)[property]
}
