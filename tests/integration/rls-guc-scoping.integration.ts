import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "../../src/server/middleware/with-family"
import { prisma as appPrisma } from "../../src/server/db.server"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

interface CurrentSettingRow {
  family_id: string | null
}

interface BackendPidRow {
  pid: number
}

const PRISMA_NOT_FOUND =
  /required but not found|No record was found|No Account found/i

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("transaction-scoped RLS GUC", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await getHarness().reset()
  })

  afterAll(async () => {
    if (process.env.DATABASE_URL) {
      await appPrisma.$disconnect()
    }
    await harness?.teardown()
  })

  test("tenant-scoped reads fail without transaction-scoped app.family_id", async () => {
    const testFactories = getFactories()
    const owner = await testFactories.createAuthenticatedOnboardedUser()
    const account = await testFactories.createAccount({
      familyId: owner.family.id,
      name: "Hidden without GUC",
    })

    await expect(
      appPrisma.account.findFirstOrThrow({
        where: { id: account.id },
      })
    ).rejects.toThrow(PRISMA_NOT_FOUND)
  })

  test("tenant-scoped reads succeed inside scopedTenantTransaction", async () => {
    const testFactories = getFactories()
    const owner = await testFactories.createAuthenticatedOnboardedUser()
    const account = await testFactories.createAccount({
      familyId: owner.family.id,
      name: "Visible with scoped GUC",
    })

    const visible = await scopedTenantTransaction(
      owner.family.id,
      owner.user.id,
      (tx) =>
        tx.account.findUniqueOrThrow({
          where: { id: account.id },
        })
    )

    expect(visible.id).toBe(account.id)
    expect(visible.familyId).toBe(owner.family.id)
  })

  test("family A cannot read or write family B rows through the helper", async () => {
    const [familyA, familyB] = await Promise.all([
      getFactories().createAuthenticatedOnboardedUser(),
      getFactories().createAuthenticatedOnboardedUser(),
    ])
    const familyBAccount = await getFactories().createAccount({
      familyId: familyB.family.id,
      name: "Other tenant account",
    })

    const crossTenantRead = await scopedTenantTransaction(
      familyA.family.id,
      familyA.user.id,
      (tx) =>
        tx.account.findFirst({
          where: { id: familyBAccount.id },
        })
    )

    expect(crossTenantRead).toBeNull()

    await expect(
      scopedTenantTransaction(familyA.family.id, familyA.user.id, (tx) =>
        tx.account.create({
          data: {
            balance: 0n,
            color: "#111827",
            currency: "IDR",
            familyId: familyB.family.id,
            name: "Illegal cross-tenant insert",
            status: "active",
            accountClass: "ASSET",
            accountSubtype: "checking",
            accountType: "DEPOSITORY",
          },
        })
      )
    ).rejects.toThrow(/row-level security|policy/i)
  })

  test("back-to-back helper calls do not leak app.family_id outside the transaction", async () => {
    const [familyA, familyB] = await Promise.all([
      getFactories().createAuthenticatedOnboardedUser(),
      getFactories().createAuthenticatedOnboardedUser(),
    ])
    const [accountA, accountB] = await Promise.all([
      getFactories().createAccount({
        familyId: familyA.family.id,
        name: "Family A account",
      }),
      getFactories().createAccount({
        familyId: familyB.family.id,
        name: "Family B account",
      }),
    ])

    const visibleToA = await scopedTenantTransaction(
      familyA.family.id,
      familyA.user.id,
      (tx) => tx.account.findMany({ orderBy: { name: "asc" } })
    )
    const visibleToB = await scopedTenantTransaction(
      familyB.family.id,
      familyB.user.id,
      (tx) => tx.account.findMany({ orderBy: { name: "asc" } })
    )
    const [setting] = await appPrisma.$queryRaw<CurrentSettingRow[]>`
      SELECT NULLIF(current_setting('app.family_id', true), '') AS family_id
    `

    expect(visibleToA.map((account) => account.id)).toEqual([accountA.id])
    expect(visibleToB.map((account) => account.id)).toEqual([accountB.id])
    expect(setting?.family_id ?? null).toBeNull()
  })

  test("multi-step protected mutation stays on one transaction client", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()

    const result = await scopedTenantTransaction(
      owner.family.id,
      owner.user.id,
      async (tx) => {
        const firstPid = await readBackendPid(tx)
        const account = await tx.account.create({
          data: {
            balance: 10_000n,
            color: "#2563eb",
            currency: "IDR",
            familyId: owner.family.id,
            name: "Single connection account",
            status: "active",
            accountClass: "ASSET",
            accountSubtype: "checking",
            accountType: "DEPOSITORY",
          },
        })
        const selected = await tx.account.findUniqueOrThrow({
          where: { id: account.id },
        })
        const updated = await tx.account.update({
          where: { id: account.id },
          data: { balance: { increment: 2_500n } },
        })
        const secondPid = await readBackendPid(tx)

        return {
          firstPid,
          selectedFamilyId: selected.familyId,
          secondPid,
          updatedBalance: updated.balance,
        }
      }
    )

    expect(result.firstPid).toBe(result.secondPid)
    expect(result.selectedFamilyId).toBe(owner.family.id)
    expect(result.updatedBalance).toBe(12_500n)
  })

  test("root Prisma queries inside a scoped transaction do not inherit the transaction GUC", async () => {
    const testFactories = getFactories()
    const owner = await testFactories.createAuthenticatedOnboardedUser()
    const account = await testFactories.createAccount({
      familyId: owner.family.id,
      name: "Root misuse account",
    })

    await expect(
      scopedTenantTransaction(owner.family.id, owner.user.id, () =>
        appPrisma.account.findFirstOrThrow({
          where: { id: account.id },
        })
      )
    ).rejects.toThrow(PRISMA_NOT_FOUND)
  })

  test("the server helper does not expose session-scoped GUC access", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/server/middleware/with-family.ts"),
      "utf8"
    )

    expect(source).not.toContain("set_config('app.family_id', $1, false)")
    expect(source).not.toMatch(/export\s+async\s+function\s+withGuc/)
  })
})

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getFactories(): TestFactories {
  if (!factories) throw new Error("Integration factories are not initialized")
  return factories
}

async function readBackendPid(tx: TenantTransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<BackendPidRow[]>`
    SELECT pg_backend_pid() AS pid
  `
  if (!row) throw new Error("Unable to read Postgres backend PID")
  return row.pid
}
