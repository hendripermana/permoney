import { describe, expect, test } from "vite-plus/test"
import { computeAccountHealth } from "./account-health"

describe("computeAccountHealth", () => {
  test("excellent: healthy runway + covered reserve + clean integrity", () => {
    const h = computeAccountHealth({
      runwayStatus: "healthy",
      reserveState: "healthy",
      driftTone: "none",
    })
    expect(h.score).toBe(100)
    expect(h.band).toBe("excellent")
    expect(h.lowConfidence).toBe(false)
    expect(h.factors.every((f) => f.tone === "good")).toBe(true)
  })

  test("attention: below reserve dominates the score", () => {
    const h = computeAccountHealth({
      runwayStatus: "below",
      reserveState: "below",
      driftTone: "none",
    })
    // runway 0*.5 + buffer .1*.3 + integrity 1*.2 = .23 → 23
    expect(h.score).toBe(23)
    expect(h.band).toBe("attention")
    // bad factors sort first
    expect(h.factors[0]?.tone).toBe("bad")
  })

  test("weights renormalize when no reserve is set", () => {
    // buffer N/A → only runway(.5) + integrity(.2) apply, renormalized over .7.
    const h = computeAccountHealth({
      runwayStatus: "watch",
      reserveState: "none",
      driftTone: "none",
    })
    // (0.5*.5 + 1*.2) / .7 = .45/.7 = .642857 → 64
    expect(h.score).toBe(64)
    expect(h.band).toBe("good")
    expect(h.factors.some((f) => f.key === "buffer")).toBe(false)
  })

  test("unknown: neither runway nor buffer applies (integrity alone is not enough)", () => {
    const h = computeAccountHealth({
      runwayStatus: "insufficient_data",
      reserveState: "none",
      driftTone: "none",
    })
    expect(h.score).toBeNull()
    expect(h.band).toBe("unknown")
    expect(h.lowConfidence).toBe(true)
  })

  test("lowConfidence when scored without runway history but a reserve exists", () => {
    const h = computeAccountHealth({
      runwayStatus: "insufficient_data",
      reserveState: "healthy",
      driftTone: "none",
    })
    // buffer(1*.3) + integrity(1*.2) over .5 = 100, but flagged low confidence.
    expect(h.score).toBe(100)
    expect(h.lowConfidence).toBe(true)
    expect(h.band).toBe("excellent")
  })

  test("drift error pulls the score down and surfaces a bad factor", () => {
    const clean = computeAccountHealth({
      runwayStatus: "healthy",
      reserveState: "healthy",
      driftTone: "none",
    })
    const drifted = computeAccountHealth({
      runwayStatus: "healthy",
      reserveState: "healthy",
      driftTone: "error",
    })
    expect(drifted.score).toBeLessThan(clean.score as number)
    expect(
      drifted.factors.some((f) => f.key === "integrity" && f.tone === "bad")
    ).toBe(true)
  })

  test("informational drift (imported) is not surfaced as a factor line", () => {
    const h = computeAccountHealth({
      runwayStatus: "healthy",
      reserveState: "healthy",
      driftTone: "informational",
    })
    expect(h.factors.some((f) => f.key === "integrity")).toBe(false)
  })

  test("factor ordering: bad before caution before good", () => {
    const h = computeAccountHealth({
      runwayStatus: "watch", // caution
      reserveState: "healthy", // good
      driftTone: "error", // bad
    })
    const tones = h.factors.map((f) => f.tone)
    expect(tones).toEqual(["bad", "caution", "good"])
  })
})
