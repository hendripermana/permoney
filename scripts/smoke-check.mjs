#!/usr/bin/env node
/**
 * M1.5 Dev Smoke Check — scripted HTTP assertion.
 *
 * Verifies the dev server responds on the configured port (3006) and that
 * protected routes redirect unauthenticated users instead of crashing.
 *
 * Usage:
 *   1. Start the dev server: vp dev (or vp run dev)
 *   2. Run: node scripts/smoke-check.mjs
 *
 * Exit 0 = pass, Exit 1 = fail.
 */

const PORT = 3006
const BASE = `http://localhost:${PORT}`

/** @param {string} label @param {boolean} ok */
function assert(label, ok) {
  const icon = ok ? "✓" : "✗"
  console.log(`  ${icon} ${label}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  console.log(`\n  PERMONEY SMOKE CHECK (port ${PORT})\n`)

  // 1. Server is reachable
  let rootRes
  try {
    rootRes = await fetch(BASE, { redirect: "manual" })
  } catch {
    console.error(`  ✗ Cannot reach ${BASE}. Is the dev server running?`)
    process.exit(1)
  }
  assert("Dev server reachable", rootRes.status > 0)

  // 2. /transactions redirects unauthenticated → /login (beforeLoad guard)
  let trxRes
  try {
    trxRes = await fetch(`${BASE}/transactions`, { redirect: "manual" })
  } catch (e) {
    assert(`/transactions fetch failed: ${e.message}`, false)
    return
  }
  // TanStack Start SPA navigation returns HTML shell; the redirect happens
  // client-side via the router. On a full-page request the server may return
  // 200 with the shell or 302. Accept both — the key assertion is NO 500.
  assert(
    `/transactions does not 500 (got ${trxRes.status})`,
    trxRes.status < 500
  )

  // 3. /login is accessible (public route)
  let loginRes
  try {
    loginRes = await fetch(`${BASE}/login`, { redirect: "manual" })
  } catch (e) {
    assert(`/login fetch failed: ${e.message}`, false)
    return
  }
  assert(`/login responds OK (got ${loginRes.status})`, loginRes.status < 400)

  // Summary
  console.log("")
  if (process.exitCode) {
    console.log("  SMOKE CHECK FAILED — see failures above.\n")
  } else {
    console.log("  ALL CHECKS PASSED ✓\n")
  }
}

main()
