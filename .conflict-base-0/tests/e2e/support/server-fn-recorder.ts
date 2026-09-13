import { createHash } from "node:crypto"
import { expect, type Page, type Request } from "@playwright/test"

const SERVER_FUNCTION_BASE_PATH = "/_serverFn/"

export interface ServerFunctionMatcher {
  displayName: string
  paths: ReadonlySet<string>
}

interface ServerFunctionCall {
  method: string
  url: string
}

export function createServerFunctionMatcher(options: {
  exportName: string
  sourcePath: string
}): ServerFunctionMatcher {
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

  return {
    displayName: options.exportName,
    paths: new Set([
      `${SERVER_FUNCTION_BASE_PATH}${devId}`,
      `${SERVER_FUNCTION_BASE_PATH}${buildId}`,
    ]),
  }
}

export function startServerFunctionRecorder(
  page: Page,
  matcher: ServerFunctionMatcher
) {
  const calls: Array<ServerFunctionCall> = []
  const onRequest = (request: Request) => {
    const url = new URL(request.url())
    if (!matcher.paths.has(url.pathname)) return
    calls.push({ method: request.method(), url: request.url() })
  }

  page.on("request", onRequest)

  return {
    calls,
    stop: () => {
      page.off("request", onRequest)
    },
  }
}

export async function expectNoServerFunctionCalls(
  recorder: ReturnType<typeof startServerFunctionRecorder>,
  matcher: ServerFunctionMatcher
): Promise<void> {
  await expect
    .poll(() => recorder.calls.length, {
      message: `${matcher.displayName} must not be called`,
      timeout: 500,
    })
    .toBe(0)
}

export async function expectServerFunctionCalled(
  recorder: ReturnType<typeof startServerFunctionRecorder>,
  matcher: ServerFunctionMatcher
): Promise<void> {
  await expect
    .poll(() => recorder.calls.length, {
      message: `${matcher.displayName} should be called`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
}
