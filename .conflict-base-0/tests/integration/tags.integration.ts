import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { DuplicateNameError } from "@/server/mutation-kit"
import {
  archiveTagForFamily,
  createTagForFamily,
  renameTagForFamily,
  setTransactionTagsForFamily,
  TagNotFoundError,
  TagTransactionNotFoundError,
} from "@/server/tags"
import { updateTransactionForFamily } from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-145 — free-form, family-scoped Tags on Transaction. Mirrors the
// Merchant/Category quick-create test shape (same tenant-owned taxonomy
// contract), plus setTransactionTagsForFamily's own attach/detach semantics.

const byId = (a: string, b: string) => a.localeCompare(b)

describe("Tags (PER-145)", () => {
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

  // Shared setup helpers — every test below was independently repeating this
  // exact boilerplate (flagged as duplication); factored out once here.
  const makeTag = (
    actor: AuthenticatedOnboardedUser,
    name: string,
    color?: string
  ) =>
    createTagForFamily({
      data: { name, color, idempotencyKey: factories.createIdempotencyKey() },
      familyId: actor.family.id,
      userId: actor.user.id,
    })

  const seedTransaction = async (actor: AuthenticatedOnboardedUser) => {
    const account = await factories.createAccount({
      familyId: actor.family.id,
    })
    return factories.createTransaction({
      familyId: actor.family.id,
      accountId: account.id,
      userId: actor.user.id,
    })
  }

  const applyTags = (
    actor: AuthenticatedOnboardedUser,
    transactionId: string,
    tagIds: string[]
  ) =>
    setTransactionTagsForFamily({
      data: {
        transactionId,
        tagIds,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: actor.family.id,
      userId: actor.user.id,
    })

  describe("createTagForFamily", () => {
    test("creates a tag with a default color and writes an audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await makeTag(owner, "Reimbursable")

      expect(created.name).toBe("Reimbursable")
      expect(created.color).toBe("#6172F3")
      expect(created.archivedAt).toBeNull()

      const row = await harness.withFamily(owner.family.id, async (tx) =>
        tx.tag.findUniqueOrThrow({ where: { id: created.id } })
      )
      expect(row.familyId).toBe(owner.family.id)

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Tag", entityId: created.id },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("create")
    })

    test("trims the name and respects an explicit color", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const created = await makeTag(owner, "  Trip: Bali  ", "#e07a5f")

      expect(created.name).toBe("Trip: Bali")
      expect(created.color).toBe("#e07a5f")
    })

    test("rejects a case/whitespace-insensitive duplicate name within the family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await makeTag(owner, "Tax Deductible")

      let captured: unknown
      try {
        await makeTag(owner, "  tax deductible  ")
        expect.fail("Expected DuplicateNameError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(DuplicateNameError)

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.tag.count({ where: { familyId: owner.family.id } })
      )
      expect(count).toBe(1)
    })

    test("the same name is allowed across different families", async () => {
      const familyA = await factories.createAuthenticatedOnboardedUser()
      const familyB = await factories.createAuthenticatedOnboardedUser()
      await makeTag(familyA, "Groceries Split")

      const created = await makeTag(familyB, "Groceries Split")
      expect(created.name).toBe("Groceries Split")
    })

    test("replays the same idempotency key without creating a second tag", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const key = factories.createIdempotencyKey()
      const payload = {
        data: { name: "Replay Tag", idempotencyKey: key },
        familyId: owner.family.id,
        userId: owner.user.id,
      }

      const first = await createTagForFamily(payload)
      const second = await createTagForFamily(payload)

      expect(second.id).toBe(first.id)
      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.tag.count({
          where: { familyId: owner.family.id, name: "Replay Tag" },
        })
      )
      expect(count).toBe(1)
    })

    describe("tenant isolation", () => {
      test("a tag created for one family is invisible under another family's RLS scope", async () => {
        const owner = await factories.createAuthenticatedOnboardedUser()
        const intruder = await factories.createAuthenticatedOnboardedUser()

        const created = await makeTag(owner, "Owner-only Tag")

        const visibleToIntruder = await harness.withFamily(
          intruder.family.id,
          async (tx) => tx.tag.findUnique({ where: { id: created.id } })
        )
        expect(visibleToIntruder).toBeNull()
      })
    })
  })

  describe("renameTagForFamily", () => {
    test("renames a tag and writes an audit row with before/after", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const tag = await makeTag(owner, "Old Name")

      const renamed = await renameTagForFamily({
        data: {
          id: tag.id,
          name: "New Name",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        userId: owner.user.id,
      })

      expect(renamed.name).toBe("New Name")
      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Tag", entityId: tag.id, action: "update" },
        })
      )
      expect(audits).toHaveLength(1)
    })

    test("rejects renaming to a name colliding with another tag in the same family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await makeTag(owner, "Taken")
      const tag = await makeTag(owner, "Original")

      let captured: unknown
      try {
        await renameTagForFamily({
          data: {
            id: tag.id,
            name: "taken",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          userId: owner.user.id,
        })
        expect.fail("Expected DuplicateNameError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(DuplicateNameError)
    })

    test("rejects renaming another family's tag (tenant-owned reference)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const victimTag = await makeTag(owner, "Victim")

      let captured: unknown
      try {
        await renameTagForFamily({
          data: {
            id: victimTag.id,
            name: "Hijacked",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: intruder.family.id,
          userId: intruder.user.id,
        })
        expect.fail("Expected TagNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(TagNotFoundError)

      const unchanged = await harness.withFamily(owner.family.id, async (tx) =>
        tx.tag.findUniqueOrThrow({ where: { id: victimTag.id } })
      )
      expect(unchanged.name).toBe("Victim")
    })
  })

  describe("archiveTagForFamily", () => {
    test("archives a tag and writes an audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const tag = await makeTag(owner, "To Archive")

      const archived = await archiveTagForFamily({
        data: { id: tag.id, idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        userId: owner.user.id,
      })

      expect(archived.archivedAt).not.toBeNull()
      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Tag", entityId: tag.id, action: "update" },
        })
      )
      expect(audits).toHaveLength(1)
    })

    test("archiving an already-archived tag is a no-op, not a second audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const tag = await makeTag(owner, "Double Archive")
      await archiveTagForFamily({
        data: { id: tag.id, idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        userId: owner.user.id,
      })

      const second = await archiveTagForFamily({
        data: { id: tag.id, idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(second.archivedAt).not.toBeNull()

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Tag", entityId: tag.id, action: "update" },
        })
      )
      expect(audits).toHaveLength(1)
    })
  })

  describe("setTransactionTagsForFamily", () => {
    test("attaches tags to a transaction and writes an audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const trx = await seedTransaction(owner)
      const tagA = await makeTag(owner, "Tag A")
      const tagB = await makeTag(owner, "Tag B")

      const result = await applyTags(owner, trx.id, [tagA.id, tagB.id])

      expect(result.tags.map((t) => t.name)).toEqual(["Tag A", "Tag B"])
      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transactionTag.findMany({ where: { transactionId: trx.id } })
      )
      expect(rows).toHaveLength(2)
      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "TransactionTag", entityId: trx.id },
        })
      )
      expect(audits).toHaveLength(1)
    })

    test("re-attaching the exact same set is idempotent — no duplicate rows, no new audit row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const trx = await seedTransaction(owner)
      const tag = await makeTag(owner, "Solo Tag")

      await applyTags(owner, trx.id, [tag.id])
      await applyTags(owner, trx.id, [tag.id])

      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transactionTag.findMany({ where: { transactionId: trx.id } })
      )
      expect(rows).toHaveLength(1)
      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "TransactionTag", entityId: trx.id },
        })
      )
      // Only the FIRST call actually changed the tag set (toAdd/toRemove
      // non-empty); the second call is a genuine no-op and skips the audit
      // write entirely (see setTransactionTagsForFamily's `if (toAdd.length >
      // 0 || toRemove.length > 0)` guard).
      expect(audits).toHaveLength(1)
    })

    test("a full-replace call removes tags no longer in the set and adds new ones", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const trx = await seedTransaction(owner)
      const tagA = await makeTag(owner, "Keep")
      const tagB = await makeTag(owner, "Remove Me")
      const tagC = await makeTag(owner, "Newly Added")

      await applyTags(owner, trx.id, [tagA.id, tagB.id])
      const result = await applyTags(owner, trx.id, [tagA.id, tagC.id])

      expect(result.tags.map((t) => t.id).sort(byId)).toEqual(
        [tagA.id, tagC.id].sort(byId)
      )
      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transactionTag.findMany({ where: { transactionId: trx.id } })
      )
      expect(rows.map((r) => r.tagId).sort(byId)).toEqual(
        [tagA.id, tagC.id].sort(byId)
      )
    })

    test("an empty tagIds array clears every attached tag", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const trx = await seedTransaction(owner)
      const tag = await makeTag(owner, "Only Tag")
      await applyTags(owner, trx.id, [tag.id])

      const result = await applyTags(owner, trx.id, [])

      expect(result.tags).toHaveLength(0)
      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transactionTag.findMany({ where: { transactionId: trx.id } })
      )
      expect(rows).toHaveLength(0)
    })

    test("replaying the same idempotency key does not double-attach", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const trx = await seedTransaction(owner)
      const tag = await makeTag(owner, "Replay Attach")
      const key = factories.createIdempotencyKey()
      const payload = {
        data: { transactionId: trx.id, tagIds: [tag.id], idempotencyKey: key },
        familyId: owner.family.id,
        userId: owner.user.id,
      }

      const first = await setTransactionTagsForFamily(payload)
      const second = await setTransactionTagsForFamily(payload)

      expect(second).toEqual(first)
      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transactionTag.findMany({ where: { transactionId: trx.id } })
      )
      expect(rows).toHaveLength(1)
    })

    test("rejects a tagId belonging to another family (tenant-owned reference)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const trx = await seedTransaction(owner)
      const intruderTag = await makeTag(intruder, "Foreign Tag")

      let captured: unknown
      try {
        await applyTags(owner, trx.id, [intruderTag.id])
        expect.fail("Expected TagNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(TagNotFoundError)

      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transactionTag.findMany({ where: { transactionId: trx.id } })
      )
      expect(rows).toHaveLength(0)
    })

    test("rejects a transactionId belonging to another family (tenant-owned reference)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderTrx = await seedTransaction(intruder)
      const tag = await makeTag(owner, "Owner Tag")

      let captured: unknown
      try {
        await applyTags(owner, intruderTrx.id, [tag.id])
        expect.fail("Expected TagTransactionNotFoundError")
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(TagTransactionNotFoundError)
    })

    // -------------------------------------------------------------------
    // Regression: editing ANY field on a transaction replaces the row
    // (soft-delete + a new row, `supersededBy`-linked —
    // `replaceTransactionWithinTenantTransaction`). The transaction form
    // fires the tag-picker's save as a SEPARATE, unawaited request
    // alongside the edit's own save, so either can land first in real
    // usage. Both orderings must end with the tags attached to whichever
    // transaction row is live, never silently orphaned on a superseded one.
    // -------------------------------------------------------------------
    describe("surviving a transaction edit (row replacement)", () => {
      const editTransaction = (
        actor: AuthenticatedOnboardedUser,
        opts: { id: string; accountId: string; categoryId: string }
      ) =>
        updateTransactionForFamily({
          data: {
            id: opts.id,
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: opts.accountId,
            amount: 20_000n,
            categoryId: opts.categoryId,
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Edited description",
            currency: "IDR",
            isSplit: false,
            status: "CLEARED" as const,
            type: "expense" as const,
          },
          familyId: actor.family.id,
          user: { id: actor.user.id, familyId: actor.family.id },
        }) as Promise<{ id: string }>

      test("tags attached BEFORE an edit are carried forward onto the replacement row", async () => {
        const owner = await factories.createAuthenticatedOnboardedUser()
        const category = await factories.createCategory({
          familyId: owner.family.id,
          type: "expense",
        })
        const trx = await seedTransaction(owner)
        const tag = await makeTag(owner, "Survives Edit")

        // 1. Attach the tag to the ORIGINAL row.
        await applyTags(owner, trx.id, [tag.id])

        // 2. Edit the transaction — this replaces the row.
        const { id: newTransactionId } = await editTransaction(owner, {
          id: trx.id,
          accountId: trx.accountId,
          categoryId: category.id,
        })
        expect(newTransactionId).not.toBe(trx.id)

        // 3. The tag now lives on the NEW row, not the superseded one.
        const oldRows = await harness.withFamily(owner.family.id, async (tx) =>
          tx.transactionTag.findMany({ where: { transactionId: trx.id } })
        )
        expect(oldRows).toHaveLength(0)
        const newRows = await harness.withFamily(owner.family.id, async (tx) =>
          tx.transactionTag.findMany({
            where: { transactionId: newTransactionId },
          })
        )
        expect(newRows).toHaveLength(1)
        expect(newRows[0]?.tagId).toBe(tag.id)
      })

      test("attaching tags via a since-superseded transactionId resolves onto the current live row", async () => {
        const owner = await factories.createAuthenticatedOnboardedUser()
        const category = await factories.createCategory({
          familyId: owner.family.id,
          type: "expense",
        })
        const trx = await seedTransaction(owner)
        const tag = await makeTag(owner, "Late Attach")

        // 1. Edit FIRST — the original id is now soft-deleted/superseded.
        const { id: newTransactionId } = await editTransaction(owner, {
          id: trx.id,
          accountId: trx.accountId,
          categoryId: category.id,
        })

        // 2. The client (unaware the replace already happened) still
        // attaches tags using the ORIGINAL, now-stale id.
        const result = await applyTags(owner, trx.id, [tag.id])

        // 3. It resolves onto the CURRENT live transaction, not a rejection.
        expect(result.transactionId).toBe(newTransactionId)
        const rows = await harness.withFamily(owner.family.id, async (tx) =>
          tx.transactionTag.findMany({
            where: { transactionId: newTransactionId },
          })
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.tagId).toBe(tag.id)
      })
    })
  })
})
