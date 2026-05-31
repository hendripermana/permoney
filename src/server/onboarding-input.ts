import { z } from "zod"

export const onboardingIdempotencyKeySchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "idempotencyKey must be a UUIDv7"
  )
  .transform((value) => value.toLowerCase())

export const initializeOnboardingInputSchema = z.object({
  idempotencyKey: onboardingIdempotencyKeySchema,
})

export type InitializeOnboardingInput = z.infer<
  typeof initializeOnboardingInputSchema
>
