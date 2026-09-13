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
