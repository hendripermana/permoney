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
  AccountValidationError,
  archiveAccountForFamily,
  createAccountForFamily,
  getAccountsForFamily,
  reactivateAccountForFamily,
  updateAccountForFamily,
} from "@/server/accounts"
import {
  getAccountBalanceForFamily,
  getAccountOpeningValueForFamily,
} from "@/server/valuations"
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

  describe("reserve / minimum balance (PER-217)", () => {
    test("stores a reserve on a cash-like ASSET and folds it into available (safe-to-spend)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await createAccountForFamily({
        data: {
          name: "BCA with buffer",
          accountType: "DEPOSITORY",
          currency: "IDR",
          openingBalance: "1000000",
          reserveBalance: "200000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(created.balance).toBe("1000000")
      expect(created.reserveBalance).toBe("200000")

      // Ledger-neutral: the stored balance is untouched by the reserve.
      const row = await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: created.id } })
      )
      expect(row.balance).toBe(1000000n)
      expect(row.reserveBalance).toBe(200000n)

      // available = current − held − reserve; held is 0 with no pending txns.
      const view = await getAccountBalanceForFamily({
        accountId: created.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(view.current).toBe("1000000")
      expect(view.held).toBe("0")
      expect(view.reserve).toBe("200000")
      expect(view.available).toBe("800000")
    })

    test("a 0 reserve is normalized to null (no reserve)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const created = await createAccountForFamily({
        data: {
          name: "No buffer",
          accountType: "DEPOSITORY",
          openingBalance: "500000",
          reserveBalance: "0",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(created.reserveBalance).toBeNull()
    })

    test("rejects a reserve on a liability account (validated, before any write)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      let captured: unknown
      try {
        await createAccountForFamily({
          data: {
            name: "Card with bogus reserve",
            accountType: "CREDIT",
            openingBalance: "0",
            reserveBalance: "50000",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected AccountValidationError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountValidationError)
    })

    test("rejects a reserve on a tracked (valuation) asset", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      let captured: unknown
      try {
        await createAccountForFamily({
          data: {
            name: "Gold with bogus reserve",
            accountType: "TRACKED_ASSET",
            accountSubtype: "commodity",
            openingBalance: "0",
            reserveBalance: "50000",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected AccountValidationError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountValidationError)
    })

    test("update sets then clears the reserve (null clears; omit leaves unchanged)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await factories.createAccount({
        familyId: owner.family.id,
        name: "Editable buffer",
      })

      const set = await updateAccountForFamily({
        data: {
          id: account.id,
          reserveBalance: "150000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(set.reserveBalance).toBe("150000")

      // Omitting the field leaves the reserve unchanged.
      const renamed = await updateAccountForFamily({
        data: {
          id: account.id,
          name: "Renamed",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(renamed.reserveBalance).toBe("150000")

      // Explicit null clears it.
      const cleared = await updateAccountForFamily({
        data: {
          id: account.id,
          reserveBalance: null,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(cleared.reserveBalance).toBeNull()
    })

    test("the DB CHECK is the backstop: a raw reserve on a liability is rejected", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const card = await createAccountForFamily({
        data: {
          name: "Visa",
          accountType: "CREDIT",
          openingBalance: "0",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // Bypass the app-layer validation and write straight to the row: the DB
      // CHECK (Database Is the Law) must still reject it.
      let captured: unknown
      try {
        await harness.withFamily(owner.family.id, async (tx) =>
          tx.account.update({
            where: { id: card.id },
            data: { reserveBalance: 50000n },
          })
        )
        expect.fail("Expected the DB CHECK to reject the reserve")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeTruthy()
    })
  })

  describe("account opening value (PER-229 performance)", () => {
    test("returns the signed opening valuation for a tracked asset", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const gold = await createAccountForFamily({
        data: {
          name: "Gold ANTAM",
          accountType: "TRACKED_ASSET",
          accountSubtype: "gold",
          openingBalance: "20000000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const view = await getAccountOpeningValueForFamily({
        accountId: gold.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(view.openingValue).toBe("20000000")
      expect(view.currency).toBe("IDR")
    })

    test("cannot read the opening value of another family's account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await factories.createAccount({
        familyId: owner.family.id,
      })

      let captured: unknown
      try {
        await getAccountOpeningValueForFamily({
          accountId: account.id,
          familyId: intruder.family.id,
          userId: intruder.user.id,
        })
        expect.fail("Expected a not-found error for a cross-tenant read")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeTruthy()
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

      const mine = await getAccountsForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
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
