import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  AccountNotFoundError,
  archiveAccountForFamily,
  createAccountForFamily,
  getAccountsForFamily,
  reactivateAccountForFamily,
  updateAccountForFamily,
} from "@/server/accounts"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("accounts manual UX vertical slice (PER-143)", () => {
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

  describe("createAccountForFamily", () => {
    test("creates a cash-like account, signs the opening balance, and writes an audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await createAccountForFamily({
        data: {
          name: "BCA Checking",
          accountType: "DEPOSITORY",
          currency: "IDR",
          openingBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.accountClass).toBe("ASSET")
      expect(created.accountSubtype).toBe("checking")
      expect(created.balanceSource).toBe("transaction_flow")
      expect(created.balance).toBe("150000")
      expect(created.status).toBe("active")

      const row = await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: created.id } })
      )
      expect(row.balance).toBe(150000n)
      expect(row.balanceSource).toBe("transaction_flow")

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Account", entityId: created.id },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("create")
      expect(audits[0]?.familyId).toBe(owner.family.id)
    })

    test("creates a tracked asset with valuation balance source", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await createAccountForFamily({
        data: {
          name: "Family Car",
          accountType: "TRACKED_ASSET",
          accountSubtype: "vehicle",
          openingBalance: "200000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.accountClass).toBe("ASSET")
      expect(created.accountType).toBe("TRACKED_ASSET")
      expect(created.accountSubtype).toBe("vehicle")
      expect(created.balanceSource).toBe("valuation")
    })

    test("signs liability opening balance non-positive", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await createAccountForFamily({
        data: {
          name: "Visa Card",
          accountType: "CREDIT",
          openingBalance: "500000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.accountClass).toBe("LIABILITY")
      expect(created.balance).toBe("-500000")
    })

    test("replays the same idempotency key without creating a second account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const key = factories.createIdempotencyKey()
      const payload = {
        data: {
          name: "Replay Wallet",
          accountType: "E_WALLET" as const,
          openingBalance: "1000",
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        user: owner.user,
      }

      const first = await createAccountForFamily(payload)
      const second = await createAccountForFamily(payload)

      expect(second.id).toBe(first.id)
      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.count({
          where: { familyId: owner.family.id, name: "Replay Wallet" },
        })
      )
      expect(count).toBe(1)
    })
  })

  describe("updateAccountForFamily", () => {
    test("updates metadata and records before/after audit", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await factories.createAccount({
        familyId: owner.family.id,
        name: "Old Name",
      })

      const updated = await updateAccountForFamily({
        data: {
          id: account.id,
          name: "New Name",
          color: "#10b981",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(updated.name).toBe("New Name")
      expect(updated.color).toBe("#10b981")

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: {
            entityType: "Account",
            entityId: account.id,
            action: "update",
          },
        })
      )
      expect(audits).toHaveLength(1)
    })
  })

  describe("archive / reactivate", () => {
    test("archive soft-closes the account without erasing it, then reactivate restores it", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await factories.createAccount({
        familyId: owner.family.id,
        balance: 90000n,
      })

      const archived = await archiveAccountForFamily({
        data: {
          id: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(archived.status).toBe("closed")
      expect(archived.archivedAt).not.toBeNull()

      // The row and its balance still exist — soft close, never hard delete.
      const stillThere = await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: account.id } })
      )
      expect(stillThere.status).toBe("closed")
      expect(stillThere.balance).toBe(90000n)

      const softDeleteAudits = await harness.withFamily(
        owner.family.id,
        async (tx) =>
          tx.auditLog.findMany({
            where: { entityId: account.id, action: "soft_delete" },
          })
      )
      expect(softDeleteAudits).toHaveLength(1)

      const reactivated = await reactivateAccountForFamily({
        data: {
          id: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(reactivated.status).toBe("active")
      expect(reactivated.archivedAt).toBeNull()
    })

    test("archiving an already-closed account is an idempotent no-op", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await factories.createAccount({
        familyId: owner.family.id,
      })

      await archiveAccountForFamily({
        data: {
          id: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      const secondArchive = await archiveAccountForFamily({
        data: {
          id: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(secondArchive.status).toBe("closed")
      const softDeleteAudits = await harness.withFamily(
        owner.family.id,
        async (tx) =>
          tx.auditLog.findMany({
            where: { entityId: account.id, action: "soft_delete" },
          })
      )
      // Only the first archive transitioned state and wrote an audit row.
      expect(softDeleteAudits).toHaveLength(1)
    })
  })

  describe("tenant isolation", () => {
    test("getAccountsForFamily only returns the acting family's accounts", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      await factories.createAccount({ familyId: owner.family.id, name: "Mine" })
      await factories.createAccount({
        familyId: intruder.family.id,
        name: "Theirs",
      })

      const mine = await getAccountsForFamily({ familyId: owner.family.id })
      expect(mine.every((a) => a.name !== "Theirs")).toBe(true)
      expect(mine.some((a) => a.name === "Mine")).toBe(true)
    })

    test("cannot archive an account owned by another family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await factories.createAccount({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await archiveAccountForFamily({
          data: {
            id: intruderAccount.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected AccountNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountNotFoundError)

      // The intruder's account is untouched.
      const untouched = await harness.withFamily(
        intruder.family.id,
        async (tx) =>
          tx.account.findUniqueOrThrow({ where: { id: intruderAccount.id } })
      )
      expect(untouched.status).toBe("active")
    })

    test("cannot update an account owned by another family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await factories.createAccount({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await updateAccountForFamily({
          data: {
            id: intruderAccount.id,
            name: "Hijacked",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected AccountNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountNotFoundError)
    })
  })
})
