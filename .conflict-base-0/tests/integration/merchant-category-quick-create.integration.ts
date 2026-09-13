import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  createMerchantForFamily,
  type SerializedMerchant,
} from "@/server/merchants"
import {
  CategoryNotFoundError,
  CategoryValidationError,
  createCategoryForFamily,
} from "@/server/categories"
import { DuplicateNameError } from "@/server/mutation-kit"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("quick-create Merchant & Category (PER-189)", () => {
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

  describe("createMerchantForFamily", () => {
    test("creates a merchant and writes an audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created: SerializedMerchant = await createMerchantForFamily({
        data: {
          name: "Starbucks",
          color: "#00704a",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.name).toBe("Starbucks")
      expect(created.color).toBe("#00704a")

      const row = await harness.withFamily(owner.family.id, async (tx) =>
        tx.merchant.findUniqueOrThrow({ where: { id: created.id } })
      )
      expect(row.familyId).toBe(owner.family.id)

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Merchant", entityId: created.id },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("create")
      expect(audits[0]?.familyId).toBe(owner.family.id)
    })

    test("trims the name and defaults color to null", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await createMerchantForFamily({
        data: {
          name: "  Blue Bottle Coffee  ",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.name).toBe("Blue Bottle Coffee")
      expect(created.color).toBeNull()
    })

    test("rejects a case/whitespace-insensitive duplicate name within the family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await factories.createMerchant({
        familyId: owner.family.id,
        name: "Starbucks",
      })

      let captured: unknown
      try {
        await createMerchantForFamily({
          data: {
            name: "  starbucks  ",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected DuplicateNameError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(DuplicateNameError)

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.merchant.count({ where: { familyId: owner.family.id } })
      )
      expect(count).toBe(1)
    })

    test("the same name is allowed across different families", async () => {
      const familyA = await factories.createAuthenticatedOnboardedUser()
      const familyB = await factories.createAuthenticatedOnboardedUser()
      await factories.createMerchant({
        familyId: familyA.family.id,
        name: "Starbucks",
      })

      const created = await createMerchantForFamily({
        data: {
          name: "Starbucks",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: familyB.family.id,
        user: familyB.user,
      })
      expect(created.name).toBe("Starbucks")
    })

    test("replays the same idempotency key without creating a second merchant", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const key = factories.createIdempotencyKey()
      const payload = {
        data: { name: "Replay Merchant", idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      }

      const first = await createMerchantForFamily(payload)
      const second = await createMerchantForFamily(payload)

      expect(second.id).toBe(first.id)
      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.merchant.count({
          where: { familyId: owner.family.id, name: "Replay Merchant" },
        })
      )
      expect(count).toBe(1)
    })

    describe("tenant isolation", () => {
      test("a merchant created for one family is invisible under another family's RLS scope", async () => {
        const owner = await factories.createAuthenticatedOnboardedUser()
        const intruder = await factories.createAuthenticatedOnboardedUser()

        const created = await createMerchantForFamily({
          data: {
            name: "Owner-only Merchant",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })

        const visibleToIntruder = await harness.withFamily(
          intruder.family.id,
          async (tx) => tx.merchant.findUnique({ where: { id: created.id } })
        )
        expect(visibleToIntruder).toBeNull()

        const visibleToOwner = await harness.withFamily(
          owner.family.id,
          async (tx) => tx.merchant.findUnique({ where: { id: created.id } })
        )
        expect(visibleToOwner?.id).toBe(created.id)
      })
    })
  })

  describe("createCategoryForFamily", () => {
    test("creates a category with defaults and writes an audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await createCategoryForFamily({
        data: {
          name: "Coffee",
          type: "expense",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.name).toBe("Coffee")
      expect(created.type).toBe("expense")
      expect(created.color).toBe("#6172F3")
      expect(created.icon).toBe("shapes")
      expect(created.parentId).toBeNull()

      const row = await harness.withFamily(owner.family.id, async (tx) =>
        tx.category.findUniqueOrThrow({ where: { id: created.id } })
      )
      expect(row.isSystem).toBe(false)
      expect(row.familyId).toBe(owner.family.id)

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Category", entityId: created.id },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("create")
    })

    test("respects explicit color/icon and a same-type parent", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const parent = await factories.createCategory({
        familyId: owner.family.id,
        name: "Food & Drink",
        type: "expense",
      })

      const created = await createCategoryForFamily({
        data: {
          name: "Coffee Shops",
          type: "expense",
          color: "#e07a5f",
          icon: "coffee",
          parentId: parent.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      expect(created.color).toBe("#e07a5f")
      expect(created.icon).toBe("coffee")
      expect(created.parentId).toBe(parent.id)
    })

    test("rejects a parent whose type does not match", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const incomeParent = await factories.createCategory({
        familyId: owner.family.id,
        type: "income",
      })

      let captured: unknown
      try {
        await createCategoryForFamily({
          data: {
            name: "Mismatched Child",
            type: "expense",
            parentId: incomeParent.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected CategoryValidationError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(CategoryValidationError)
    })

    test("rejects a parentId belonging to another family (tenant-owned reference)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderCategory = await factories.createCategory({
        familyId: intruder.family.id,
      })

      let captured: unknown
      try {
        await createCategoryForFamily({
          data: {
            name: "Hijacked Child",
            type: "expense",
            parentId: intruderCategory.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected CategoryNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(CategoryNotFoundError)
    })

    test("rejects a case/whitespace-insensitive duplicate name within the family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await factories.createCategory({
        familyId: owner.family.id,
        name: "Groceries",
        type: "expense",
      })

      let captured: unknown
      try {
        await createCategoryForFamily({
          data: {
            name: " groceries ",
            type: "expense",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
        expect.fail("Expected DuplicateNameError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(DuplicateNameError)

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.category.count({ where: { familyId: owner.family.id } })
      )
      expect(count).toBe(1)
    })

    test("replays the same idempotency key without creating a second category", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const key = factories.createIdempotencyKey()
      const payload = {
        data: {
          name: "Replay Category",
          type: "income" as const,
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        user: owner.user,
      }

      const first = await createCategoryForFamily(payload)
      const second = await createCategoryForFamily(payload)

      expect(second.id).toBe(first.id)
      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.category.count({
          where: { familyId: owner.family.id, name: "Replay Category" },
        })
      )
      expect(count).toBe(1)
    })

    describe("tenant isolation", () => {
      test("a category created for one family is invisible under another family's RLS scope", async () => {
        const owner = await factories.createAuthenticatedOnboardedUser()
        const intruder = await factories.createAuthenticatedOnboardedUser()

        const created = await createCategoryForFamily({
          data: {
            name: "Owner-only Category",
            type: "expense",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })

        const visibleToIntruder = await harness.withFamily(
          intruder.family.id,
          async (tx) => tx.category.findUnique({ where: { id: created.id } })
        )
        expect(visibleToIntruder).toBeNull()
      })
    })
  })
})
