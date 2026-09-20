// =============================================================================
// ADR-0058 — People & ownership: pure, client-safe helpers.
//
// A "person" is the existing `ZakatPayer` row (D1: no rename yet). An owner is
// referenced by an `OwnerRef`: either an existing person, or an ACTIVE family
// member who may not have a person row yet (the server get-or-creates it).
// Everything here is pure so the visibility rule and the select-value encoding
// are unit-testable without React or Postgres.
// =============================================================================

export type OwnerRef = { personId: string } | { memberUserId: string }

/** Value used by owner selects for "no owner" (Radix forbids empty strings). */
export const OWNER_NONE_KEY = "__none__"

const PERSON_PREFIX = "person:"
const MEMBER_PREFIX = "member:"

/** Encode an OwnerRef as a stable string for a `<Select>` value. */
export function ownerRefToKey(ref: OwnerRef): string {
  return "personId" in ref
    ? `${PERSON_PREFIX}${ref.personId}`
    : `${MEMBER_PREFIX}${ref.memberUserId}`
}

/** Inverse of `ownerRefToKey`; `null` for the "none" sentinel or a bad value. */
export function ownerKeyToRef(key: string): OwnerRef | null {
  if (key.startsWith(PERSON_PREFIX) && key.length > PERSON_PREFIX.length) {
    return { personId: key.slice(PERSON_PREFIX.length) }
  }
  if (key.startsWith(MEMBER_PREFIX) && key.length > MEMBER_PREFIX.length) {
    return { memberUserId: key.slice(MEMBER_PREFIX.length) }
  }
  return null
}

/**
 * D1 visibility rule: the owner control is shown when the family has two or
 * more ACTIVE members OR two or more people — independent of whether Zakat is
 * enabled. A one-member family with at most one person sees nothing.
 */
export function shouldShowOwnerControls({
  activeMemberCount,
  peopleCount,
}: {
  activeMemberCount: number
  peopleCount: number
}): boolean {
  return activeMemberCount >= 2 || peopleCount >= 2
}

// -----------------------------------------------------------------------------
// Account owner draft — the form-side model of {owner, jointOwner, share}.
// -----------------------------------------------------------------------------

export interface AccountOwnerDraft {
  /** `ownerRefToKey(...)` of the primary owner, or `OWNER_NONE_KEY`. */
  ownerKey: string
  /** `ownerRefToKey(...)` of the joint co-owner, or `OWNER_NONE_KEY`. */
  jointKey: string
  /** Joint co-owner's share, as typed (1-99). Ignored without a joint owner. */
  sharePercent: string
}

export const DEFAULT_JOINT_SHARE_PERCENT = "50"

export const EMPTY_OWNER_DRAFT: AccountOwnerDraft = {
  ownerKey: OWNER_NONE_KEY,
  jointKey: OWNER_NONE_KEY,
  sharePercent: DEFAULT_JOINT_SHARE_PERCENT,
}

/** Seeds the draft from a stored account (owners are always persons there). */
export function ownerDraftFromAccount(account: {
  zakatPayerId: string | null
  zakatJointPayerId: string | null
  zakatJointSharePercent: number | null
}): AccountOwnerDraft {
  return {
    ownerKey: account.zakatPayerId
      ? ownerRefToKey({ personId: account.zakatPayerId })
      : OWNER_NONE_KEY,
    jointKey: account.zakatJointPayerId
      ? ownerRefToKey({ personId: account.zakatJointPayerId })
      : OWNER_NONE_KEY,
    sharePercent:
      account.zakatJointSharePercent != null
        ? String(account.zakatJointSharePercent)
        : DEFAULT_JOINT_SHARE_PERCENT,
  }
}

export type OwnerDraftInput =
  | {
      ok: true
      owner: OwnerRef | null
      jointOwner: OwnerRef | null
      jointSharePercent: number | null
    }
  | { ok: false; message: string }

/** Validates the draft and converts it to the server input shape. */
export function ownerDraftToInput(draft: AccountOwnerDraft): OwnerDraftInput {
  const owner = ownerKeyToRef(draft.ownerKey)
  const jointOwner = owner === null ? null : ownerKeyToRef(draft.jointKey)
  if (jointOwner === null) {
    return { ok: true, owner, jointOwner: null, jointSharePercent: null }
  }
  if (draft.jointKey === draft.ownerKey) {
    return {
      ok: false,
      message: "Pick two different people for a shared account.",
    }
  }
  const share = Number(draft.sharePercent)
  if (!Number.isInteger(share) || share < 1 || share > 99) {
    return {
      ok: false,
      message: "Enter a share between 1 and 99 for the co-owner.",
    }
  }
  return { ok: true, owner, jointOwner, jointSharePercent: share }
}

/** Whether the draft differs from the stored ownership in a way worth saving. */
export function isOwnerDraftDirty(
  draft: AccountOwnerDraft,
  initial: AccountOwnerDraft
): boolean {
  if (draft.ownerKey !== initial.ownerKey) return true
  if (draft.jointKey !== initial.jointKey) return true
  return (
    draft.jointKey !== OWNER_NONE_KEY &&
    draft.sharePercent !== initial.sharePercent
  )
}
