import { randomBytes } from "node:crypto"
import { prismaAdapter } from "@better-auth/prisma-adapter"
import type {
  Account,
  Category,
  Family,
  FamilyMember,
  Merchant,
  PrismaClient,
  Session,
  Transaction,
  User,
} from "@prisma/client"
import type { FamilyRole } from "../../../src/server/middleware/authz"
import { betterAuth } from "better-auth"
import { testUtils } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import {
  normalizeAccountTaxonomy,
  type AccountClass,
  type AccountType,
} from "../../../src/lib/accounts"
import type { IntegrationHarness } from "./database"

type CategoryType = "expense" | "income"
type TransactionType = "expense" | "income" | "transfer"

export interface AuthenticatedServerContext {
  familyId: string | null
  session: Session
  user: User
}

export interface AuthenticatedOnboardedUser {
  family: Family
  request: Request
  serverContext: AuthenticatedServerContext
  session: Session
  user: User
}

export interface AuthenticatedUserWithoutFamily {
  request: Request
  serverContext: AuthenticatedServerContext
  session: Session
  user: User
}

interface CreateFamilyInput {
  currency?: string
  name?: string
  timezone?: string
}

interface CreateUserInput {
  email?: string
  familyId?: string | null
  name?: string
}

interface CreateAccountInput {
  accountClass?: AccountClass
  accountSubtype?: string | null
  accountType?: AccountType
  balance?: bigint
  color?: string | null
  currency?: string
  familyId: string
  name?: string
  status?: string
}

interface CreateCategoryInput {
  color?: string
  familyId: string
  icon?: string
  name?: string
  type?: CategoryType
}

interface CreateMerchantInput {
  color?: string | null
  familyId: string
  logoUrl?: string | null
  name?: string
}

interface CreateTransactionInput {
  accountId: string
  amount?: bigint
  categoryId?: string | null
  currency?: string
  date?: Date
  description?: string
  familyId: string
  merchantId?: string | null
  status?: string
  type?: TransactionType
  userId: string
}

export interface TestFactories {
  createAccount: (input: CreateAccountInput) => Promise<Account>
  createAuthenticatedOnboardedUser: () => Promise<AuthenticatedOnboardedUser>
  createAuthenticatedUserWithoutFamily: () => Promise<AuthenticatedUserWithoutFamily>
  createCategory: (input: CreateCategoryInput) => Promise<Category>
  createFamily: (input?: CreateFamilyInput) => Promise<Family>
  createFamilyMember: (input: {
    familyId: string
    userId: string
    role?: FamilyRole
    status?: "active" | "invited" | "revoked"
  }) => Promise<FamilyMember>
  createIdempotencyKey: () => string
  createMerchant: (input: CreateMerchantInput) => Promise<Merchant>
  createTransaction: (input: CreateTransactionInput) => Promise<Transaction>
  createUser: (input?: CreateUserInput) => Promise<User>
}

export function createTestFactories(
  harness: IntegrationHarness
): TestFactories {
  const testAuth = createTestAuth(harness.prisma)
  const authContext = testAuth.$context
  let sequence = 0

  const nextValue = (prefix: string) => {
    sequence += 1
    return `${prefix} ${sequence}`
  }

  const createFamily = async (
    input: CreateFamilyInput = {}
  ): Promise<Family> => {
    return await harness.prisma.family.create({
      data: {
        currency: input.currency ?? "IDR",
        name: input.name ?? nextValue("Test family"),
        timezone: input.timezone ?? "Asia/Jakarta",
      },
    })
  }

  const createUser = async (input: CreateUserInput = {}): Promise<User> => {
    sequence += 1
    return await harness.prisma.user.create({
      data: {
        email: input.email ?? `test-${sequence}@permoney.local`,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        familyId: input.familyId ?? null,
        name: input.name ?? `Test User ${sequence}`,
        passwordHash: `test-hash-${sequence}`,
        theme: "system",
      },
    })
  }

  const authenticateUser = async (
    user: User
  ): Promise<{
    request: Request
    serverContext: AuthenticatedServerContext
    session: Session
  }> => {
    const context = await authContext
    const login = await context.test.login({ userId: user.id })
    const session = await harness.prisma.session.findUniqueOrThrow({
      where: { token: login.token },
    })

    return {
      request: new Request("http://localhost.test/__server_fn", {
        headers: login.headers,
      }),
      serverContext: {
        familyId: user.familyId,
        session,
        user,
      },
      session,
    }
  }

  // ADR-0036: a family is only usable once it has an active owner. The real
  // path is onboarding-service; this factory bypasses it, so it must seed the
  // owner membership itself (otherwise the RLS membership guard blocks every
  // tenant write). The insert runs inside withFamily so FamilyMember's
  // tenant-isolation WITH CHECK (familyId = GUC) passes.
  const createFamilyMember = async (input: {
    familyId: string
    userId: string
    role?: FamilyRole
    status?: "active" | "invited" | "revoked"
  }): Promise<FamilyMember> => {
    // withMember (not withFamily) so we don't run withFamily's owner
    // auto-resolve scan of FamilyMember — that extra Serializable read makes
    // parallel member creation across families false-conflict. The insert only
    // needs app.family_id (FamilyMember RLS is plain tenant isolation).
    return await harness.withMember(
      input.familyId,
      input.userId,
      async (tx) => {
        return await tx.familyMember.create({
          data: {
            familyId: input.familyId,
            userId: input.userId,
            role: input.role ?? "member",
            status: input.status ?? "active",
            joinedAt: new Date(),
          },
        })
      }
    )
  }

  const createAuthenticatedOnboardedUser =
    async (): Promise<AuthenticatedOnboardedUser> => {
      const family = await createFamily()
      const user = await createUser({ familyId: family.id })
      await createFamilyMember({
        familyId: family.id,
        userId: user.id,
        role: "owner",
      })
      const authenticated = await authenticateUser(user)
      return {
        family,
        ...authenticated,
        user,
      }
    }

  const createAuthenticatedUserWithoutFamily =
    async (): Promise<AuthenticatedUserWithoutFamily> => {
      const user = await createUser({ familyId: null })
      const authenticated = await authenticateUser(user)
      return {
        ...authenticated,
        user,
      }
    }

  const createAccount = async (input: CreateAccountInput): Promise<Account> => {
    const taxonomy = normalizeAccountTaxonomy({
      accountClass: input.accountClass,
      accountSubtype: input.accountSubtype,
      accountType: input.accountType ?? "DEPOSITORY",
    })

    return await harness.withFamily(input.familyId, async (tx) => {
      return await tx.account.create({
        data: {
          accountClass: taxonomy.accountClass,
          accountSubtype: taxonomy.accountSubtype,
          accountType: taxonomy.accountType,
          balanceSource: taxonomy.balanceSource,
          balance: input.balance ?? 0n,
          color: input.color ?? "#2563eb",
          currency: input.currency ?? "IDR",
          familyId: input.familyId,
          name: input.name ?? nextValue("Test account"),
          status: input.status ?? "active",
        },
      })
    })
  }

  const createCategory = async (
    input: CreateCategoryInput
  ): Promise<Category> => {
    return await harness.withFamily(input.familyId, async (tx) => {
      return await tx.category.create({
        data: {
          color: input.color ?? "#6172F3",
          familyId: input.familyId,
          icon: input.icon ?? "shapes",
          name: input.name ?? nextValue("Test category"),
          type: input.type ?? "expense",
        },
      })
    })
  }

  const createMerchant = async (
    input: CreateMerchantInput
  ): Promise<Merchant> => {
    return await harness.withFamily(input.familyId, async (tx) => {
      return await tx.merchant.create({
        data: {
          color: input.color ?? "#0f766e",
          familyId: input.familyId,
          logoUrl: input.logoUrl ?? null,
          name: input.name ?? nextValue("Test merchant"),
        },
      })
    })
  }

  const createTransaction = async (
    input: CreateTransactionInput
  ): Promise<Transaction> => {
    return await harness.withFamily(input.familyId, async (tx) => {
      return await tx.transaction.create({
        data: {
          accountId: input.accountId,
          amount: input.amount ?? -12_345n,
          categoryId: input.categoryId ?? null,
          currency: input.currency ?? "IDR",
          date: input.date ?? new Date("2026-01-15T00:00:00.000Z"),
          description: input.description ?? nextValue("Test transaction"),
          familyId: input.familyId,
          merchantId: input.merchantId ?? null,
          status: input.status ?? "CLEARED",
          type: input.type ?? "expense",
          userId: input.userId,
        },
      })
    })
  }

  return {
    createAccount,
    createAuthenticatedOnboardedUser,
    createAuthenticatedUserWithoutFamily,
    createCategory,
    createFamily,
    createFamilyMember,
    createIdempotencyKey,
    createMerchant,
    createTransaction,
    createUser,
  }
}

function createTestAuth(prisma: PrismaClient) {
  const isProduction = process.env.NODE_ENV === "production"

  return betterAuth({
    advanced: {
      cookiePrefix: isProduction ? "__Host-permoney" : "permoney",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
      },
      useSecureCookies: isProduction,
    },
    baseURL: "http://localhost.test",
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    user: {
      modelName: "User",
      additionalFields: {
        familyId: {
          required: false,
          type: "string",
        },
        theme: {
          required: false,
          type: "string",
        },
      },
    },
    session: {
      modelName: "Session",
    },
    account: {
      modelName: "AuthAccount",
    },
    verification: {
      modelName: "Verification",
    },
    plugins: [tanstackStartCookies(), testUtils()],
  })
}

function createIdempotencyKey(): string {
  const bytes = randomBytes(16)
  let timestamp = BigInt(Date.now())

  for (let index = 5; index >= 0; index -= 1) {
    bytes.writeUInt8(Number(timestamp & 0xffn), index)
    timestamp >>= 8n
  }

  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)

  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
