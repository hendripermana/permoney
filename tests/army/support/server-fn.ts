import { createHash } from "node:crypto"
import type { Browser } from "@e2e-dev/web"

// Deterministic port of tests/e2e/support/server-fn-recorder.ts: the same
// dev/prod server-function URL identities, but captured through this
// runner's attempt-scoped `browser.route()` instead of Playwright's
// `page.on("request")`. Deliberately does NOT import the Playwright helper —
// that file imports @playwright/test, and pulling the old engine into this
// runner's process would defeat the whole point of a second lane.

const SERVER_FUNCTION_BASE_PATH = "/_serverFn/"

/** Raw request bodies (seroval JSON), in request order. */
export interface ServerFunctionCapture {
  bodies: Array<string>
}

/**
 * The URL paths one server function answers on: the dev-server `devId`
 * (base64url of {file, export}) and the production `buildId` (sha256 of
 * "path--export"), so a dev run and a future production run both match.
 */
function serverFunctionPaths(options: {
  exportName: string
  sourcePath: string
}): ReadonlySet<string> {
  const functionName = `${options.exportName}_createServerFn_handler`
  const devId = Buffer.from(
    JSON.stringify({
      file: `/${options.sourcePath}?tss-serverfn-split`,
      export: functionName,
    }),
    "utf8"
  ).toString("base64url")
  const buildId = createHash("sha256")
    .update(`${options.sourcePath}--${functionName}`)
    .digest("hex")
  return new Set([
    `${SERVER_FUNCTION_BASE_PATH}${devId}`,
    `${SERVER_FUNCTION_BASE_PATH}${buildId}`,
  ])
}

/**
 * Record the POST body of every call to one server function. Registered
 * attempt-scoped (the runner drops it at attempt teardown); the handler
 * pushes the body BEFORE `continue()`, so by the time a submit's dialog has
 * closed, its body is in `bodies` — no polling, no race.
 */
export async function captureServerFunctionBodies(
  browser: Browser,
  options: { exportName: string; sourcePath: string }
): Promise<ServerFunctionCapture> {
  const paths = serverFunctionPaths(options)
  const capture: ServerFunctionCapture = { bodies: [] }

  await browser.route(/\/_serverFn\//, async (route) => {
    const url = new URL(route.request.url)
    if (route.request.method === "POST" && paths.has(url.pathname)) {
      capture.bodies.push(route.request.postData ?? "")
    }
    await route.continue()
  })

  return capture
}
