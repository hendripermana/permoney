import { betterAuth } from "better-auth"
import { prismaAdapter } from "@better-auth/prisma-adapter"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { prisma as db } from "./db.server"
import { hash, verify, type Options } from "@node-rs/argon2"
export { signupSchema, loginSchema } from "./auth-schemas"
const argonOpts: Options = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
  outputLen: 32, // 32 bytes
  algorithm: 2, // Argon2id
}

const isProduction = process.env.NODE_ENV === "production"
const BETTER_AUTH_PASSWORD_HASH_SENTINEL = "better-auth-managed-credential"

export const auth = betterAuth({
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
        defaultValue: BETTER_AUTH_PASSWORD_HASH_SENTINEL,
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

export type Auth = typeof auth
