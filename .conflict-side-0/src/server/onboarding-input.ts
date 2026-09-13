import { z } from "zod"
import { CURRENCIES } from "@/lib/data/currencies"

export const onboardingIdempotencyKeySchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "idempotencyKey must be a UUIDv7"
  )
  .transform((value) => value.toLowerCase())

// Base reporting currency for the new family. Chosen ONCE at onboarding and
// immutable thereafter (ADR-0035): it is the anchor of every historical report
// and the materialized base projection, so changing it would re-denominate all
// history. Required — Permoney is global and must not silently assume a default.
export const onboardingCurrencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((code) => code in CURRENCIES, {
    message: "Unsupported currency code",
  })

export const initializeOnboardingInputSchema = z.object({
  idempotencyKey: onboardingIdempotencyKeySchema,
  currency: onboardingCurrencySchema,
})

export type InitializeOnboardingInput = z.infer<
  typeof initializeOnboardingInputSchema
>
