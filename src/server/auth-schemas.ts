import { z } from "zod"

export const signupSchema = z.object({
  fullname: z.string().min(1, "Name is required"),
  username: z.string().min(1, "Username is required").optional(),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // ADR-0057 — raw family-invite token carried from /invite/accept. Optional
  // and deliberately unvalidated beyond being text: a stale, malformed, or
  // mismatched token must never block account creation (signupFn ignores it).
  inviteToken: z.string().max(256).optional(),
})

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
})
