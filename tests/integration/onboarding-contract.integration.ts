import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { auth } from "../../src/server/auth.server"
import { initializeOnboardingForUser } from "../../src/server/onboarding-service"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

describe("onboarding contract", () => {
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

  test("newly signed-up users are created without a family", async () => {
    const email = "signup-contract@permoney.local"

    const result = await auth.api.signUpEmail({
      body: {
        email,
        name: "Signup Contract",
        password: "password123",
      },
      headers: new Headers(),
    })

    const [user, familyCount] = await Promise.all([
      harness.prisma.user.findUniqueOrThrow({
        where: { id: result.user.id },
      }),
      harness.prisma.family.count(),
    ])

    expect(user.email).toBe(email)
    expect(user.familyId).toBeNull()
    expect(familyCount).toBe(0)
  })

  test("onboarding initialization creates one family and replay returns it", async () => {
    const user = await factories.createUser({
      email: "onboarding-replay@permoney.local",
      familyId: null,
      name: "Onboarding Replay",
    })

    const first = await initializeOnboardingForUser(harness.prisma, user.id)
    const second = await initializeOnboardingForUser(harness.prisma, user.id)

    const [storedUser, families] = await Promise.all([
      harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      harness.prisma.family.findMany(),
    ])

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.familyId).toBe(first.familyId)
    expect(storedUser.familyId).toBe(first.familyId)
    expect(families).toHaveLength(1)
    expect(families[0]?.name).toBe("Onboarding Replay's Family")
  })

  test("concurrent onboarding initialization does not duplicate families", async () => {
    const user = await factories.createUser({
      email: "onboarding-concurrent@permoney.local",
      familyId: null,
      name: "Onboarding Concurrent",
    })

    const [first, second] = await Promise.all([
      initializeOnboardingForUser(harness.prisma, user.id),
      initializeOnboardingForUser(harness.prisma, user.id),
    ])

    const [storedUser, familyCount] = await Promise.all([
      harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      harness.prisma.family.count(),
    ])

    expect(first.familyId).toBe(second.familyId)
    expect(storedUser.familyId).toBe(first.familyId)
    expect(familyCount).toBe(1)
  })
})
