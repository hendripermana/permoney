import {
  createImportBatchForFamily,
  type getImportBatchForFamily,
} from "@/server/imports"
import type { IntegrationHarness } from "./database"
import type { TestFactories } from "./factories"

/**
 * Shared scaffolding for the import-staging / import-promotion integration
 * suites.
 *
 * Both suites stage rows into a real-Postgres tenant and then drive the import
 * server fns through the same harness plumbing. That scaffolding was copied
 * between them, which SonarCloud counted as duplicated new lines on the
 * promotion slice (3.4% vs the 3% gate) — so it lives here once, in the
 * per-domain fixture style the directory already uses (`sure-fixtures.ts`,
 * `holdings-fixtures.ts`).
 */

export interface ImportTenant {
  familyId: string
  userId: string
  accountId: string
}

export type ImportTenantRunner = <T>(
  familyId: string,
  userId: string,
  fn: Parameters<IntegrationHarness["withMember"]>[2]
) => Promise<T>

/**
 * The harness tenant runner: domain fns run with both GUCs set to the acting
 * member, exactly what `familyMiddleware` does in production.
 */
export function createImportTenantRunner(
  harness: IntegrationHarness
): ImportTenantRunner {
  return <T>(
    familyId: string,
    userId: string,
    fn: Parameters<IntegrationHarness["withMember"]>[2]
  ) => harness.withMember(familyId, userId, fn) as Promise<T>
}

/**
 * A family with one owner and one import-enabled account.
 *
 * `balance` defaults to a funded DEPOSITORY account so an expense promotion
 * keeps the ASSET balance >= 0 (the `account_normal_balance_sign` CHECK the
 * canonical path enforces); suites that only promote income can pass `0n`.
 */
export async function createImportTenant(
  harness: IntegrationHarness,
  factories: TestFactories,
  opts: {
    currency?: string
    importable?: boolean
    balance?: bigint
    name?: string
  } = {}
): Promise<ImportTenant> {
  const currency = opts.currency ?? "IDR"
  const family = await factories.createFamily({
    currency,
    ...(opts.name === undefined ? {} : { name: opts.name }),
  })
  const user = await factories.createUser({ familyId: family.id })
  await factories.createFamilyMember({
    familyId: family.id,
    userId: user.id,
    role: "owner",
  })
  const account = await factories.createAccount({
    familyId: family.id,
    currency,
    accountType: "DEPOSITORY",
    balance: opts.balance ?? 1_000_000n,
  })
  if (opts.importable !== false) {
    await harness.withFamily(family.id, (tx) =>
      tx.account.update({
        where: { id: account.id },
        data: { isImportable: true },
      })
    )
  }
  return { familyId: family.id, userId: user.id, accountId: account.id }
}

/** One staged row, in the shape the import server fns accept. */
export function buildImportRow(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "",
    rawPayload: { source: "csv", line: 1 },
    date: new Date("2026-06-15T03:00:00.000Z"),
    amount: "2500",
    type: "expense" as const,
    description: "Starbucks Jakarta",
    ...overrides,
  }
}

export interface StageImportBatchOptions {
  contentHash?: string
  idempotencyKey?: string
  sourceKind?: string
  provider?: string
}

/** Stage rows into a tenant's batch. Returns the batch summary. */
export async function stageImportBatch(
  tenant: ImportTenant,
  rows: Array<Record<string, unknown>>,
  opts: StageImportBatchOptions & {
    runInTenantTransaction: ImportTenantRunner
  }
): Promise<Awaited<ReturnType<typeof createImportBatchForFamily>>> {
  const { runInTenantTransaction, ...batchOptions } = opts
  return await createImportBatchForFamily({
    data: {
      sourceKind: batchOptions.sourceKind ?? "csv_upload",
      provider: batchOptions.provider,
      accountId: tenant.accountId,
      contentHash: batchOptions.contentHash ?? "hash-default",
      idempotencyKey: batchOptions.idempotencyKey,
      rows: rows.map((row) => ({ ...row, accountId: tenant.accountId })),
    },
    familyId: tenant.familyId,
    user: { id: tenant.userId, familyId: tenant.familyId },
    runInTenantTransaction,
  })
}

/** One batch row as the read side returns it (id + status, for decisions). */
export type ImportBatchRow = Awaited<
  ReturnType<typeof getImportBatchForFamily>
>["rows"][number]
