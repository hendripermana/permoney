import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  baseURL: process.env.VITE_APP_URL || "http://localhost:3006",
})

export const { signIn, signUp, signOut, useSession } = authClient
