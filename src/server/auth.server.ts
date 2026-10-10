import { betterAuth } from "better-auth"
import { prismaAdapter } from "@better-auth/prisma-adapter"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { prisma as db } from "./db.server"
import { hash, verify, type Options } from "@node-rs/argon2"
export { signupSchema, loginSchema } from "./auth-schemas"
export const argonOpts: Options = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
  outputLen: 32, // 32 bytes
  algorithm: 2, // Argon2id
}

const isProduction = process.env.NODE_ENV === "production"
const LEGACY_AUTH_USER_FIELD_PLACEHOLDER = "better-auth-managed-user-field"

// Lazy construction, on purpose: this module must stay side-effect free at
// import time (AGENTS.md's `*.server.ts` rule). `betterAuth(...)` initializes
// the Prisma adapter, and since @better-auth/prisma-adapter 1.7.7 that init
// READS THE PRISMA DATA MODEL (`readPrismaDataModel`), i.e. it touches `db` —
// and touching `db` constructs the Prisma client and its connection pool. At
// module scope that made `import` itself a database side effect: it threw
// wherever DATABASE_URL was absent at import time (the first integration-test
// import in a fresh worker — onboarding-contract, seed-demo-login), and built a
// client bound to whatever DATABASE_URL happened to linger otherwise. The proxy
// defers construction to the first real use, exactly like `db.server.ts`
// defers its client; `advanced.useSecureCookies` stays read at import, so the
// cookies are unaffected.
const createAuth = () =>
  betterAuth({
    advanced: {
      useSecureCookies: isProduction,
      cookiePrefix: isProduction ? "__Host-permoney" : "permoney",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
      },
    },
    database: prismaAdapter(db, {
      provider: "postgresql",
    }),
    user: {
      modelName: "User",
      additionalFields: {
        passwordHash: {
          type: "string",
          required: false,
          input: false,
          returned: false,
          defaultValue: LEGACY_AUTH_USER_FIELD_PLACEHOLDER,
        },
        familyId: {
          type: "string",
          required: false,
        },
        theme: {
          type: "string",
          required: false,
        },
      },
    },
    session: {
      modelName: "Session",
    },
    account: {
      modelName: "AuthAccount", // Mapped to AuthAccount to avoid clash with Bank Account
    },
    verification: {
      modelName: "Verification",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      password: {
        hash: async (password) => {
          return await hash(password, argonOpts)
        },
        verify: async ({ hash: passwordHash, password }) => {
          return await verify(passwordHash, password, argonOpts)
        },
      },
    },
    plugins: [tanstackStartCookies()],
  })

let cachedAuth: ReturnType<typeof createAuth> | null = null

export const auth: ReturnType<typeof createAuth> = /* @__PURE__ */ new Proxy(
  {} as ReturnType<typeof createAuth>,
  {
    get(_target, prop) {
      const instance = (cachedAuth ??= createAuth())
      const value = Reflect.get(instance, prop) as unknown
      return typeof value === "function"
        ? (value as (...args: Array<unknown>) => unknown).bind(instance)
        : value
    },
  }
)

export type Auth = ReturnType<typeof createAuth>
