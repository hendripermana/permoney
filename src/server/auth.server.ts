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
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Create Family and update user with familyId
          const family = await db.family.create({
            data: { name: `${user.name}'s Family` },
          })
          await db.user.update({
            where: { id: user.id },
            data: { familyId: family.id },
          })
        },
      },
    },
  },
  user: {
    modelName: "User",
    additionalFields: {
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
