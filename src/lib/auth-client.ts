import { createAuthClient } from "better-auth/react"

// PER-166 — do NOT pin the auth client to a hardcoded host/port. `process.env`
// is not a thing in the browser bundle, and `localhost:3006` silently breaks on
// any other origin (preview, prod, a different dev port). When `baseURL` is
// omitted better-auth targets the current origin, so auth requests follow
// wherever the app is actually served. Prod can still override via VITE_APP_URL.
const appUrl = import.meta.env.VITE_APP_URL

export const authClient = createAuthClient(
  typeof appUrl === "string" && appUrl.length > 0 ? { baseURL: appUrl } : {}
)

export const { signIn, signUp, signOut, useSession } = authClient
