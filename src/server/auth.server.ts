import { betterAuth } from "better-auth"
import { prismaAdapter } from "@better-auth/prisma-adapter"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { prisma as db } from "./db.server"
import { hash, verify, type Options } from "@node-rs/argon2"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { z } from "zod"

export const signupSchema = z.object({
  fullname: z.string().min(1, "Name is required"),
  username: z.string().min(1, "Username is required").optional(),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
})
const argonOpts: Options = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
  outputLen: 32, // 32 bytes
  algorithm: 2, // Argon2id
}

export const auth = betterAuth({
  advanced: {
    useSecureCookies: true,
    cookiePrefix: "__Host-permoney",
    defaultCookieAttributes: {
      httpOnly: true,
      secure: true,
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

import { requireSession } from "./middleware/session"

export const meFn = createServerFn({ method: "GET" }).handler(async () => {
  const { user } = await requireSession()
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      familyId: user.familyId,
      theme: user.theme,
    },
  }
})

import { checkRateLimit } from "./middleware/rate-limit"

export const signupFn = createServerFn({ method: "POST" })
  .inputValidator(signupSchema)
  .handler(async ({ data }) => {
    const request = getRequest()
    await checkRateLimit(request, data.email, "signup")
    const res = await auth.api.signUpEmail({
      body: {
        email: data.email,
        password: data.password,
        name: data.fullname,
      },
      headers: request.headers,
    })
    return { success: true, user: res?.user }
  })

export const loginFn = createServerFn({ method: "POST" })
  .inputValidator(loginSchema)
  .handler(async ({ data }) => {
    const request = getRequest()
    // M1-6: Rate-limit hook
    await checkRateLimit(request, data.email, "login")
    const res = await auth.api.signInEmail({
      body: {
        email: data.email,
        password: data.password,
      },
      headers: request.headers,
    })
    return { success: true, user: res?.user }
  })

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const request = getRequest()
  await auth.api.signOut({
    headers: request.headers,
  })
  return { success: true }
})
