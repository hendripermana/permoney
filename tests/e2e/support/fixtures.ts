import { test as base } from "@playwright/test"

// Known server/client boundary regressions. These are matched against
// console.error TEXT, where the browser may report a handled failure that is
// not a thrown exception.
const FORBIDDEN_CONSOLE_FRAGMENTS = [
  "Hydration failed because the server rendered HTML didn't match the client",
  "react-dom/server.browser.js",
  "renderRouterToString",
  "node:stream/web",
  "SECURITY BREACH",
  "PrismaClient is unable to run in this browser",
  "Calling 'require' for '.prisma/client/index-browser'",
  // PER-187: the router TypeError reported alongside the UNAUTHENTICATED
  // live-query hang. Root-cause analysis judged it a downstream symptom of
  // the auth-error retry storm, not an independent router bug — this
  // fragment turns that judgment into a standing regression check across
  // every e2e spec, instead of a one-off manual confirmation.
  "reading '_nonReactive'",
] as const

function containsForbiddenFragment(message: string): boolean {
  return FORBIDDEN_CONSOLE_FRAGMENTS.some((fragment) =>
    message.includes(fragment)
  )
}

export const test = base.extend({
  page: async ({ page }, runPageTest) => {
    const failures: Array<string> = []

    page.on("console", (message) => {
      if (message.type() !== "error") return
      const text = message.text()
      if (containsForbiddenFragment(text)) {
        failures.push(`console.error: ${text}`)
      }
    })

    // Every UNCAUGHT exception fails the test, whatever its message. A fixed
    // string denylist only catches a leak that reuses known wording; an
    // unexpected throw is the signal that something crossed a boundary (or
    // broke) in a way nobody predicted. Console output stays fragment-matched
    // above because handled errors legitimately log there.
    page.on("pageerror", (error) => {
      failures.push(`pageerror (uncaught): ${error.message}`)
    })

    await runPageTest(page)

    if (failures.length > 0) {
      throw new Error(
        `Browser errors were emitted during the test:\n${failures.join("\n")}`
      )
    }
  },
})

export { expect } from "@playwright/test"
