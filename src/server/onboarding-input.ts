import { z } from "zod"
import { CURRENCIES } from "@/lib/data/currencies"
import { uuidV7Schema } from "./mutation-kit"

// The idempotency-key contract is the shared UUIDv7 schema from mutation-kit
// (trimmed, v7 + variant nibbles enforced, lower-cased). The onboarding input
// used to carry a second copy of the same regex/message.

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
  idempotencyKey: uuidV7Schema,
  currency: onboardingCurrencySchema,
})

export type InitializeOnboardingInput = z.infer<
  typeof initializeOnboardingInputSchema
>
