import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createAccountForFamily } from "../../src/server/accounts"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

/**
 * F1 audit S5.3 — the scheduled balance-drift audit.
 *
 * The detector already existed (`auditTransactionFlowBalanceAcrossFamilies`,
 * PER-268) but nothing ran it on a schedule, so drift was only found when a
 * human remembered to look. This file pins the contract of the new read-only
 * `verify` mode by spawning the REAL CLI against real Postgres:
 *
 *   0  clean            (every family audited, no drift)
 *   1  drift found      (actionable)
 *   2  unauditable      (a family with no active member — "skipped", not clean)
 *
 * The drift fixture is injected with a raw balance write, which is exactly the
 * production condition the audit exists to catch: stored balance disagreeing
 * with the canonical formula.
 */

const TSX = resolve(process.cwd(), "node_modules/.bin/tsx")
const SCRIPT = resolve(
  process.cwd(),
  "scripts/per-268-balance-correction-audit.ts"
)

let harness: IntegrationHarness
let factories: TestFactories

beforeAll(async () => {
  harness = await createIntegrationHarness()
  factories = createTestFactories(harness)
})

beforeEach(async () => {
  await harness.reset()
})

afterAll(async () => {
  await harness.teardown()
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseSummary(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON summary in CLI output:\n${stdout}`)
  }
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1))
  if (!isRecord(parsed)) {
    throw new Error("JSON summary was not an object")
  }
  return parsed
}

function runVerifyCli(): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync(TSX, [SCRIPT, "verify"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

describe("balance-drift verify mode (PER-268 detector, scheduled)", () => {
  test("exits 0 with a clean summary when stored balances agree", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await createAccountForFamily({
      data: {
        name: "Checking",
        accountType: "DEPOSITORY",
        openingBalance: "250000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const { status, stdout } = runVerifyCli()
    const summary = parseSummary(stdout)

    expect(status).toBe(0)
    expect(summary.status).toBe("clean")
    expect(summary.event).toBe("balance_drift_verify")
    expect(summary.driftedAccountCount).toBe(0)
    expect(summary.unauditableFamilies).toEqual([])
  })

  test("exits 1 and reports the account when a stored balance has drifted", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await createAccountForFamily({
      data: {
        name: "Drifted Checking",
        accountType: "DEPOSITORY",
        openingBalance: "250000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Simulate the historical failure mode: the materialized balance is wrong
    // by an amount the ledger cannot explain (pre-PER-268 drift).
    await harness.withFamily(owner.family.id, async (tx) => {
      await tx.account.update({
        where: { id: account.id },
        data: { balance: { increment: 7_500_000n } },
      })
    })

    const { status, stdout, stderr } = runVerifyCli()
    const summary = parseSummary(stdout)

    expect(status).toBe(1)
    expect(summary.status).toBe("drift")
    expect(summary.driftedAccountCount).toBe(1)

    const drifted = summary.drifted
    expect(Array.isArray(drifted)).toBe(true)
    const first = Array.isArray(drifted) ? drifted[0] : null
    expect(isRecord(first)).toBe(true)
    if (isRecord(first)) {
      expect(first.accountId).toBe(account.id)
      expect(first.familyId).toBe(owner.family.id)
      expect(first.driftAmount).toBeTruthy()
    }

    // The cron line carries ids and amounts, never names or emails.
    expect(stdout).not.toContain("Drifted Checking")
    expect(stdout).not.toContain(owner.user.email)
    expect(stderr).toContain("Balance drift found")
  })

  test("exits 2 when a family cannot be audited at all", async () => {
    const family = await factories.createFamily({
      currency: "IDR",
      name: "Fully Revoked Family",
    })
    const user = await factories.createUser({ familyId: null })
    await factories.createFamilyMember({
      familyId: family.id,
      userId: user.id,
      status: "revoked",
    })

    const { status, stdout, stderr } = runVerifyCli()
    const summary = parseSummary(stdout)

    expect(status).toBe(2)
    expect(summary.status).toBe("unauditable")
    expect(summary.driftedAccountCount).toBe(0)
    expect(summary.unauditableFamilies).toEqual([{ familyId: family.id }])
    expect(stderr).toContain("could not be audited")
  })
})
