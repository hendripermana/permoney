import { useQuery } from "@tanstack/react-query"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  OWNER_NONE_KEY,
  ownerRefToKey,
  shouldShowOwnerControls,
  type AccountOwnerDraft,
} from "@/lib/ownership"
import { listOwnerCandidatesFn } from "@/server/ownership"

// =============================================================================
// ADR-0058 D1 — the neutral "Owner" controls.
//
// One query feeds every owner select (account dialog, holding dialog). The
// controls exist only when the family has 2+ active members or 2+ people
// (`shouldShowOwnerControls`); a one-member household never sees them. This is
// deliberately independent of whether Zakat is enabled.
// =============================================================================

export const OWNER_CANDIDATES_QUERY_KEY = ["owner-candidates"] as const

type OwnerCandidatesResult = Awaited<ReturnType<typeof listOwnerCandidatesFn>>
export type OwnerCandidateRecord = OwnerCandidatesResult["candidates"][number]

export function useOwnerCandidates(): {
  candidates: OwnerCandidateRecord[]
  visible: boolean
} {
  const { data } = useQuery({
    queryKey: OWNER_CANDIDATES_QUERY_KEY,
    queryFn: () => listOwnerCandidatesFn(),
    // People and members change on other routes (Zakat settings, invites);
    // refetch on mount rather than trusting the default 1-minute cache.
    staleTime: 0,
  })
  return {
    candidates: data?.candidates ?? [],
    visible: data
      ? shouldShowOwnerControls({
          activeMemberCount: data.activeMemberCount,
          peopleCount: data.peopleCount,
        })
      : false,
  }
}

/** A single owner select whose value is an `ownerRefToKey` string. */
export function OwnerSelect({
  id,
  label,
  value,
  onValueChange,
  candidates,
  noneLabel,
  excludeKey,
  disabled,
}: {
  id: string
  label: string
  value: string
  onValueChange: (key: string) => void
  candidates: OwnerCandidateRecord[]
  noneLabel: string
  /** A key that must not be offered (e.g. the primary owner for the co-owner). */
  excludeKey?: string
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={noneLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={OWNER_NONE_KEY}>{noneLabel}</SelectItem>
          {candidates
            .filter((c) => ownerRefToKey(c.ref) !== excludeKey)
            .map((c) => {
              const key = ownerRefToKey(c.ref)
              return (
                <SelectItem key={key} value={key}>
                  {c.displayName}
                </SelectItem>
              )
            })}
        </SelectContent>
      </Select>
    </div>
  )
}

/** Account-level owner + optional joint co-owner and their share. */
export function AccountOwnerFields({
  candidates,
  draft,
  onChange,
}: {
  candidates: OwnerCandidateRecord[]
  draft: AccountOwnerDraft
  onChange: (next: AccountOwnerDraft) => void
}) {
  const hasOwner = draft.ownerKey !== OWNER_NONE_KEY
  const hasJoint = hasOwner && draft.jointKey !== OWNER_NONE_KEY
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <Label>Ownership</Label>
      <p className="text-xs text-muted-foreground">
        Who this account belongs to. It drives wealth by person. Leave it unset
        if it isn't anyone's in particular.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <OwnerSelect
          id="account-owner"
          label="Owner"
          value={draft.ownerKey}
          onValueChange={(ownerKey) =>
            onChange({
              ...draft,
              ownerKey,
              // Clearing the owner also clears the co-owner (a share needs a
              // primary owner); picking the co-owner as owner drops the dup.
              jointKey:
                ownerKey === OWNER_NONE_KEY || ownerKey === draft.jointKey
                  ? OWNER_NONE_KEY
                  : draft.jointKey,
            })
          }
          candidates={candidates}
          noneLabel="No owner"
        />
        <OwnerSelect
          id="account-shared-with"
          label="Shared with (optional)"
          value={hasOwner ? draft.jointKey : OWNER_NONE_KEY}
          onValueChange={(jointKey) => onChange({ ...draft, jointKey })}
          candidates={candidates}
          noneLabel="Nobody"
          excludeKey={draft.ownerKey}
          disabled={!hasOwner}
        />
      </div>
      {hasJoint ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="account-shared-share" className="text-xs">
            Their share (%, 1–99 — default 50)
          </Label>
          <Input
            id="account-shared-share"
            type="number"
            min={1}
            max={99}
            value={draft.sharePercent}
            onChange={(event) =>
              onChange({ ...draft, sharePercent: event.target.value })
            }
          />
        </div>
      ) : null}
    </div>
  )
}
