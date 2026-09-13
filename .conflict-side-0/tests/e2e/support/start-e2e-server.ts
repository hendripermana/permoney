import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createIntegrationHarness } from "../../integration/support/database"

interface E2eServerState {
  baseURL: string
  databaseName: string
  databaseUrl: string
  devServerPid: number
  startedAt: string
}

const e2ePort = Number(process.env.PERMONEY_E2E_PORT ?? 3010)
const baseURL = `http://127.0.0.1:${e2ePort}`
const statePath = resolve(process.cwd(), ".playwright/permoney-e2e-state.json")
const vitePlusCliPath = resolve(process.cwd(), "node_modules/vite-plus/bin/vp")

let devServer: ChildProcess | null = null
let teardown: (() => Promise<void>) | null = null
let shuttingDown = false

async function main(): Promise<void> {
  const harness = await createIntegrationHarness()
  teardown = harness.teardown

  process.env.DATABASE_URL = harness.databaseUrl
  process.env.BETTER_AUTH_SECRET ??= randomUUID()
  process.env.BETTER_AUTH_URL = baseURL
  process.env.PERMONEY_E2E = "1"

  const spawnedDevServer = spawn(
    process.execPath,
    [vitePlusCliPath, "dev", "--host", "127.0.0.1", "--port", String(e2ePort)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BETTER_AUTH_URL: baseURL,
        DATABASE_URL: harness.databaseUrl,
        NODE_ENV: "development",
        PERMONEY_E2E: "1",
      },
      stdio: "inherit",
    }
  )
  devServer = spawnedDevServer

  writeState({
    baseURL,
    databaseName: harness.databaseName,
    databaseUrl: harness.databaseUrl,
    devServerPid: spawnedDevServer.pid ?? process.pid,
    startedAt: new Date().toISOString(),
  })

  spawnedDevServer.on("exit", (code, signal) => {
    if (shuttingDown) return
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
    console.error(`[e2e] dev server exited unexpectedly with ${reason}`)
    void shutdown(code ?? 1)
  })
}

function writeState(state: E2eServerState): void {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${statePath}.tmp`, statePath)
}

async function stopDevServer(): Promise<void> {
  const runningDevServer = devServer
  if (runningDevServer?.exitCode !== null) return

  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(resolveStop, 5_000)
    runningDevServer.once("exit", () => {
      clearTimeout(timeout)
      resolveStop()
    })
    runningDevServer.kill("SIGTERM")
  })
}

async function cleanup(): Promise<void> {
  await stopDevServer()
  await rm(statePath, { force: true })
  if (teardown) {
    await teardown()
    teardown = null
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  try {
    await cleanup()
  } catch (error) {
    console.error("[e2e] cleanup failed", error)
    process.exit(1)
  }

  process.exit(exitCode)
}

process.on("SIGINT", () => {
  void shutdown(0)
})

process.on("SIGTERM", () => {
  void shutdown(0)
})

try {
  await main()
} catch (error: unknown) {
  console.error("[e2e] failed to start", error)
  await shutdown(1)
}
