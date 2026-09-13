import { describe, expect, test } from "vite-plus/test"
import {
  addHijriYears,
  daysInHijriMonth,
  gregorianToHijri,
  hijriAnniversary,
  hijriToGregorian,
  wholeHijriYearsElapsed,
} from "./zakat-hijri"

describe("zakat-hijri", () => {
  describe("gregorianToHijri / hijriToGregorian round-trip", () => {
    test("converts a known Gregorian date to Hijri and back exactly", () => {
      const g = new Date("2026-09-13T00:00:00.000Z")
      const h = gregorianToHijri(g)
      expect(h).toEqual({ year: 1448, month: 4, day: 2 })
      const back = hijriToGregorian(h)
      expect(back.toISOString().slice(0, 10)).toBe("2026-09-13")
    })

    test("round-trips across a wide range of dates without drift", () => {
      for (let year = 2015; year <= 2035; year++) {
        const g = new Date(Date.UTC(year, 5, 15))
        const h = gregorianToHijri(g)
        const back = hijriToGregorian(h)
        expect(back.getTime()).toBe(g.getTime())
      }
    })
  })

  describe("daysInHijriMonth", () => {
    test("every Hijri month is either 29 or 30 days", () => {
      for (let year = 1440; year <= 1450; year++) {
        for (let month = 1; month <= 12; month++) {
          const days = daysInHijriMonth(year, month)
          expect([29, 30]).toContain(days)
        }
      }
    })
  })

  describe("addHijriYears", () => {
    test("adds a whole Hijri year, same month/day, when the target month has enough days", () => {
      const result = addHijriYears({ year: 1447, month: 6, day: 1 }, 1)
      expect(result).toEqual({ year: 1448, month: 6, day: 1 })
    })

    test("clamps the day when the target year's month is one day shorter", () => {
      // Find a (year, month) pair where day 30 exists but the next year's
      // same month only has 29 days, to exercise the clamp deterministically.
      let found = false
      for (let year = 1440; year <= 1449 && !found; year++) {
        for (let month = 1; month <= 12; month++) {
          if (
            daysInHijriMonth(year, month) === 30 &&
            daysInHijriMonth(year + 1, month) === 29
          ) {
            const result = addHijriYears({ year, month, day: 30 }, 1)
            expect(result).toEqual({ year: year + 1, month, day: 29 })
            found = true
            break
          }
        }
      }
      expect(found).toBe(true)
    })
  })

  describe("hijriAnniversary", () => {
    test("is meaningfully shorter than 365 days (a real lunar year, not a fixed Gregorian offset)", () => {
      const start = new Date("2025-01-01T00:00:00.000Z")
      const anniversary = hijriAnniversary(start, 1)
      const diffDays = (anniversary.getTime() - start.getTime()) / 86_400_000
      // A Hijri year is ~354-355 days — assert it is neither 365 (a naive
      // Gregorian year) nor a fixed 355 (the ADR-forbidden approximation),
      // just a real range around it.
      expect(diffDays).toBeGreaterThanOrEqual(353)
      expect(diffDays).toBeLessThanOrEqual(356)
      expect(diffDays).not.toBe(365)
    })

    test("two consecutive anniversaries are not always the same gap (real lunar variance)", () => {
      const start = new Date("2020-01-01T00:00:00.000Z")
      const gaps: number[] = []
      let cursor = start
      for (let i = 0; i < 8; i++) {
        const next = hijriAnniversary(cursor, 1)
        gaps.push((next.getTime() - cursor.getTime()) / 86_400_000)
        cursor = next
      }
      const distinctGaps = new Set(gaps)
      expect(distinctGaps.size).toBeGreaterThan(1)
    })
  })

  describe("wholeHijriYearsElapsed", () => {
    test("is 0 before the first anniversary", () => {
      const start = new Date("2025-01-01T00:00:00.000Z")
      const asOf = new Date("2025-06-01T00:00:00.000Z")
      expect(wholeHijriYearsElapsed(start, asOf)).toBe(0)
    })

    test("is 1 exactly on the first anniversary, 0 the day before", () => {
      const start = new Date("2025-01-01T00:00:00.000Z")
      const anniversary = hijriAnniversary(start, 1)
      expect(wholeHijriYearsElapsed(start, anniversary)).toBe(1)
      expect(
        wholeHijriYearsElapsed(
          start,
          new Date(anniversary.getTime() - 86_400_000)
        )
      ).toBe(0)
    })

    test("counts multiple elapsed years", () => {
      const start = new Date("2015-01-01T00:00:00.000Z")
      const thirdAnniversary = hijriAnniversary(start, 3)
      expect(wholeHijriYearsElapsed(start, thirdAnniversary)).toBe(3)
    })
  })
})
