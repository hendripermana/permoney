import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
} from "./middleware/with-family"

// =============================================================================
// PER-113 — Settings hub: family preferences + profile/theme (Phase 1).
//
// These are settings-grade mutations, not balance-affecting ledger writes, but
// they obey the same durable invariants the project mandates for every
// mutation: an interactive tenant transaction (app.family_id + app.user_id GUCs
// drive RLS, including the AuditLog insert policy), tenant-scoped writes, and an
// append-only `AuditLog` row in the SAME transaction. They are naturally
// idempotent (last-write-wins on a scalar field), so they do not need the
// `IdempotencyRecord` replay machinery the ledger mutations use.
//
// Base reporting currency is deliberately NOT editable here: ADR-0035 fixes
// `Family.currency` for the life of the ledger (it anchors every historical
// report and the materialized base projection). The family pane shows it
// read-only and links to /currencies; never add a base-currency mutation to the
// settings surface.
// =============================================================================

// `Intl.DateTimeFormat` throws a RangeError for an unknown IANA zone, so this is
// the most runtime-portable validation (no hard-coded zone list to rot).
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value })
    return true
  } catch {
    return false
  }
}

const THEME_VALUES = ["light", "dark", "system"] as const
export type Theme = (typeof THEME_VALUES)[number]

const updateFamilyPreferencesInputSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1, "Timezone is required")
    .refine(isValidTimeZone, "Unknown IANA timezone"),
})
export type UpdateFamilyPreferencesInput = z.infer<
  typeof updateFamilyPreferencesInputSchema
>

const updateProfileInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  theme: z.enum(THEME_VALUES),
})
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>

export interface FamilyPreferences {
  currency: string
  timezone: string
}
export interface ProfilePreferences {
  name: string
  email: string
  image: string | null
  theme: Theme
}
export interface SettingsOverview {
  family: FamilyPreferences
  profile: ProfilePreferences
}

// PER-186 — shared react-query key for the current user's identity (name,
// email, avatar). Defined once here, next to `getSettingsOverviewFn`, so every
// consumer (settings pages, the sidebar identity indicator, the Sure importer
// confirm step) reads the SAME cache entry instead of re-fetching or drifting
// out of sync with each other.
export const SETTINGS_OVERVIEW_KEY = ["settings-overview"] as const

// ---------------------------------------------------------------------------
// Domain helpers (test-injectable tenant runner, exactly like family-members).
// ---------------------------------------------------------------------------

export async function readSettingsOverviewForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<SettingsOverview> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const family = await tx.family.findUniqueOrThrow({
      where: { id: familyId },
      select: { currency: true, timezone: true },
    })
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, image: true, theme: true },
    })
    return {
      family: { currency: family.currency, timezone: family.timezone },
      profile: {
        name: user.name,
        email: user.email,
        image: user.image,
        theme: normalizeTheme(user.theme),
      },
    }
  })
}

export async function updateFamilyPreferencesForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: UpdateFamilyPreferencesInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<FamilyPreferences> {
  const data = updateFamilyPreferencesInputSchema.parse(rawData)
  const auditCtx = await createAuditContext({ user: { id: userId, familyId } })

  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const before = await tx.family.findUniqueOrThrow({
      where: { id: familyId },
      select: { currency: true, timezone: true },
    })
    const after = await tx.family.update({
      where: { id: familyId },
      data: { timezone: data.timezone },
      select: { currency: true, timezone: true },
    })
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "Family",
      entityId: familyId,
      before: { timezone: before.timezone },
      after: { timezone: after.timezone },
    })
    return { currency: after.currency, timezone: after.timezone }
  })
}

export async function updateProfileForUser({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: UpdateProfileInput
  familyId: string
  userId: string
  runInTenantTransaction?: typeof scopedTenantTransaction
}): Promise<ProfilePreferences> {
  const data = updateProfileInputSchema.parse(rawData)
  const auditCtx = await createAuditContext({ user: { id: userId, familyId } })

  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const before = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, image: true, theme: true },
    })
    const after = await tx.user.update({
      where: { id: userId },
      data: { name: data.name, theme: data.theme },
      select: { name: true, email: true, image: true, theme: true },
    })
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "User",
      entityId: userId,
      before: { name: before.name, theme: normalizeTheme(before.theme) },
      after: { name: after.name, theme: normalizeTheme(after.theme) },
    })
    return {
      name: after.name,
      email: after.email,
      image: after.image,
      theme: normalizeTheme(after.theme),
    }
  })
}

// Persisted theme is a free-form String column; coerce any legacy/unknown value
// back to the safe "system" default so the client never receives a junk theme.
function normalizeTheme(value: string): Theme {
  return (THEME_VALUES as readonly string[]).includes(value)
    ? (value as Theme)
    : "system"
}

// ---------------------------------------------------------------------------
// Server functions.
// ---------------------------------------------------------------------------

export const getSettingsOverviewFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await readSettingsOverviewForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

export const updateFamilyPreferencesFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("settings:write")])
  .inputValidator((data: UpdateFamilyPreferencesInput) =>
    updateFamilyPreferencesInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await updateFamilyPreferencesForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

export const updateProfileFn = createServerFn({ method: "POST" })
  .middleware([familyMiddleware])
  .inputValidator((data: UpdateProfileInput) =>
    updateProfileInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await updateProfileForUser({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })
