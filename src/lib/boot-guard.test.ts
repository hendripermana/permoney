import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  BootUnreachableError,
  callWithBootRetry,
  computeBootBackoffDelayMs,
  isBootUnreachableError,
  withTimeout,
} from "./boot-guard"

/**
 * F1 audit B5 — the boot guard's retry/timeout contract.
 *
 * The production incident was a stall with no recovery path, so these tests
 * pin the four things that must be true for the fix to be a fix:
 * a bounded wait, a retry that helps a flaky route, a bounded total budget,
 * and a failure object that carries NOTHING from the transport into the UI.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("withTimeout", () => {
  it("resolves with the value when the work settles first", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 50, () => new Error("late"))
    ).resolves.toBe("ok")
  })

  it("rejects with the timeout error when the work stalls", async () => {
    vi.useFakeTimers()
    const stalled = new Promise<string>(() => {
      // never settles — the incident's shape
    })
    const result = withTimeout(stalled, 1000, () => new Error("timed out"))
    const assertion = expect(result).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it("leaves no pending timer behind on a fast success", async () => {
    vi.useFakeTimers()
    await withTimeout(Promise.resolve(1), 5000, () => new Error("late"))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("computeBootBackoffDelayMs", () => {
  it("doubles per attempt and honours the ceiling", () => {
    expect(computeBootBackoffDelayMs(1, 400, 4000)).toBe(400)
    expect(computeBootBackoffDelayMs(2, 400, 4000)).toBe(800)
    expect(computeBootBackoffDelayMs(3, 400, 4000)).toBe(1600)
    expect(computeBootBackoffDelayMs(4, 400, 4000)).toBe(3200)
    expect(computeBootBackoffDelayMs(5, 400, 4000)).toBe(4000)
    expect(computeBootBackoffDelayMs(0, 400, 4000)).toBe(0)
  })
})

describe("callWithBootRetry — success paths", () => {
  it("returns the first success without sleeping", async () => {
    const call = vi.fn(async () => "guard")
    const sleep = vi.fn(async () => undefined)

    await expect(callWithBootRetry(call, { sleep })).resolves.toBe("guard")
    expect(call).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("recovers after a transient failure (the flaky-route case)", async () => {
    let attempts = 0
    const call = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw new Error("network blip")
      return "guard"
    })
    const sleep = vi.fn(async () => undefined)

    await expect(callWithBootRetry(call, { attempts: 3, sleep })).resolves.toBe(
      "guard"
    )
    expect(call).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[400], [800]])
  })

  it("retries after a TIMEOUT, not just after a thrown error", async () => {
    let first = true
    const call = vi.fn(() => {
      if (first) {
        first = false
        return new Promise<string>(() => {
          // hangs — the incident's shape
        })
      }
      return Promise.resolve("guard")
    })

    await expect(
      callWithBootRetry(call, {
        attempts: 2,
        timeoutMs: 10,
        sleep: async () => undefined,
      })
    ).resolves.toBe("guard")
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe("callWithBootRetry — failure paths", () => {
  it("throws a timeout-flavoured error once the budget is spent", async () => {
    const call = vi.fn(
      () =>
        new Promise<string>(() => {
          // always hangs
        })
    )

    const error = await callWithBootRetry(call, {
      attempts: 3,
      timeoutMs: 10,
      sleep: async () => undefined,
    }).catch((thrown: unknown) => thrown)

    expect(isBootUnreachableError(error)).toBe(true)
    expect((error as BootUnreachableError).reason).toBe("timeout")
    expect((error as BootUnreachableError).attempts).toBe(3)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("reports a thrown failure as unreachable, and stops at the attempt budget", async () => {
    const call = vi.fn(async () => {
      throw new Error("connection refused")
    })

    const error = await callWithBootRetry(call, {
      attempts: 2,
      sleep: async () => undefined,
    }).catch((thrown: unknown) => thrown)

    expect((error as BootUnreachableError).reason).toBe("unreachable")
    expect((error as BootUnreachableError).attempts).toBe(2)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("never leaks the transport's own error text into the user-facing error", async () => {
    const call = vi.fn(async () => {
      throw new Error(
        "postgres://permoney:secret@10.0.0.4/permoney — relation does not exist"
      )
    })

    const error = (await callWithBootRetry(call, {
      attempts: 1,
      sleep: async () => undefined,
    }).catch((thrown: unknown) => thrown)) as BootUnreachableError

    expect(error.message).not.toContain("secret")
    expect(error.message).not.toContain("10.0.0.4")
    expect(error.message).not.toContain("postgres")
    expect(error.message).not.toContain("relation")
    expect(error.message).toBe(
      "Permoney could not be reached (The server could not be reached.)"
    )
  })
})

describe("callWithBootRetry — offline handling", () => {
  it("attempts once when the browser reports no network, then says offline", async () => {
    const call = vi.fn(async () => {
      throw new Error("no route to host")
    })

    const error = await callWithBootRetry(call, {
      attempts: 3,
      isOnline: () => false,
      sleep: async () => undefined,
    }).catch((thrown: unknown) => thrown)

    expect(call).toHaveBeenCalledTimes(1)
    expect((error as BootUnreachableError).reason).toBe("offline")
    expect((error as BootUnreachableError).attempts).toBe(1)
  })

  it("still succeeds while the browser says offline (self-hosted LAN case)", async () => {
    const call = vi.fn(async () => "guard")

    await expect(
      callWithBootRetry(call, {
        attempts: 3,
        isOnline: () => false,
        sleep: async () => undefined,
      })
    ).resolves.toBe("guard")
    expect(call).toHaveBeenCalledTimes(1)
  })
})
