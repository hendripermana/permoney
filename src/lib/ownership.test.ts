import { describe, expect, it } from "vite-plus/test"

import {
  EMPTY_OWNER_DRAFT,
  OWNER_NONE_KEY,
  isOwnerDraftDirty,
  ownerDraftFromAccount,
  ownerDraftToInput,
  ownerKeyToRef,
  ownerRefToKey,
  shouldShowOwnerControls,
} from "./ownership"

describe("shouldShowOwnerControls (ADR-0058 D1)", () => {
  it("hides for a one-member household with at most one person", () => {
    expect(
      shouldShowOwnerControls({ activeMemberCount: 1, peopleCount: 0 })
    ).toBe(false)
    expect(
      shouldShowOwnerControls({ activeMemberCount: 1, peopleCount: 1 })
    ).toBe(false)
  })

  it("shows with two or more active members, even with zero people", () => {
    expect(
      shouldShowOwnerControls({ activeMemberCount: 2, peopleCount: 0 })
    ).toBe(true)
  })

  it("shows with two or more people, even for a single member", () => {
    expect(
      shouldShowOwnerControls({ activeMemberCount: 1, peopleCount: 2 })
    ).toBe(true)
  })
})

describe("owner key encoding", () => {
  it("round-trips person and member refs", () => {
    for (const ref of [{ personId: "p1" }, { memberUserId: "u1" }] as const) {
      expect(ownerKeyToRef(ownerRefToKey(ref))).toEqual(ref)
    }
  })

  it("maps the none sentinel and junk to null", () => {
    expect(ownerKeyToRef(OWNER_NONE_KEY)).toBeNull()
    expect(ownerKeyToRef("person:")).toBeNull()
    expect(ownerKeyToRef("whatever")).toBeNull()
  })
})

describe("account owner draft", () => {
  it("seeds from a stored account with a default 50 share", () => {
    expect(
      ownerDraftFromAccount({
        zakatPayerId: null,
        zakatJointPayerId: null,
        zakatJointSharePercent: null,
      })
    ).toEqual(EMPTY_OWNER_DRAFT)
    expect(
      ownerDraftFromAccount({
        zakatPayerId: "a",
        zakatJointPayerId: "b",
        zakatJointSharePercent: 30,
      })
    ).toEqual({
      ownerKey: "person:a",
      jointKey: "person:b",
      sharePercent: "30",
    })
  })

  it("converts to the server input, dropping a co-owner without a primary owner", () => {
    expect(
      ownerDraftToInput({
        ownerKey: OWNER_NONE_KEY,
        jointKey: "person:b",
        sharePercent: "50",
      })
    ).toEqual({
      ok: true,
      owner: null,
      jointOwner: null,
      jointSharePercent: null,
    })
    expect(
      ownerDraftToInput({
        ownerKey: "member:u1",
        jointKey: "person:b",
        sharePercent: "40",
      })
    ).toEqual({
      ok: true,
      owner: { memberUserId: "u1" },
      jointOwner: { personId: "b" },
      jointSharePercent: 40,
    })
  })

  it("rejects a duplicate co-owner and an out-of-range share", () => {
    expect(
      ownerDraftToInput({
        ownerKey: "person:a",
        jointKey: "person:a",
        sharePercent: "50",
      }).ok
    ).toBe(false)
    for (const share of ["0", "100", "abc", "12.5", ""]) {
      expect(
        ownerDraftToInput({
          ownerKey: "person:a",
          jointKey: "person:b",
          sharePercent: share,
        }).ok
      ).toBe(false)
    }
  })

  it("is dirty only when something the server stores changed", () => {
    const initial = EMPTY_OWNER_DRAFT
    expect(isOwnerDraftDirty(initial, initial)).toBe(false)
    // A share typed while there is no co-owner is not a change.
    expect(isOwnerDraftDirty({ ...initial, sharePercent: "30" }, initial)).toBe(
      false
    )
    expect(
      isOwnerDraftDirty({ ...initial, ownerKey: "person:a" }, initial)
    ).toBe(true)
  })
})
