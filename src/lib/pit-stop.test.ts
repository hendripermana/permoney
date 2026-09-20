import { describe, expect, test } from "vite-plus/test"
import {
  buildPitStopSubmission,
  describeLastChecked,
  displayBalance,
  isPitStopEligibleAccountType,
  parsePitStopRow,
  pitStopEntriesSchema,
  pitStopPayloadFingerprint,
  selectPitStopAccounts,
  unrecordedDirection,
} from "./pit-stop"

const idrBank = {
  accountType: "DEPOSITORY",
  accountClass: "ASSET",
  currency: "IDR",
  balance: "15000000", // Rp 150,000 in minor units
}
const idrCard = {
  accountType: "CREDIT",
  accountClass: "LIABILITY",
  currency: "IDR",
  balance: "-30000000",
}
const idrCash = {
  accountType: "CASH",
  accountClass: "ASSET",
  currency: "IDR",
  balance: "2000000",
}

describe("isPitStopEligibleAccountType", () => {
  test("accepts cash-like types and rejects holdings/debt/other types", () => {
    for (const type of ["DEPOSITORY", "CASH", "E_WALLET", "CREDIT"]) {
      expect(isPitStopEligibleAccountType(type)).toBe(true)
    }
    for (const type of ["INVESTMENT", "TRACKED_ASSET", "LOAN", "RECEIVABLE"]) {
      expect(isPitStopEligibleAccountType(type)).toBe(false)
    }
  })
})

describe("pitStopEntriesSchema", () => {
  test("accepts a normal batch", () => {
    expect(
      pitStopEntriesSchema.safeParse([{ accountId: "a", actualBalance: "100" }])
        .success
    ).toBe(true)
  })

  test("rejects empty, duplicate and malformed entries", () => {
    expect(pitStopEntriesSchema.safeParse([]).success).toBe(false)
    expect(
      pitStopEntriesSchema.safeParse([
        { accountId: "a", actualBalance: "1" },
        { accountId: "a", actualBalance: "2" },
      ]).success
    ).toBe(false)
    expect(
      pitStopEntriesSchema.safeParse([{ accountId: "a", actualBalance: "1.5" }])
        .success
    ).toBe(false)
    expect(
      pitStopEntriesSchema.safeParse([
        { accountId: "a", actualBalance: "1".repeat(19) },
      ]).success
    ).toBe(false)
  })

  test("caps the batch size", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      accountId: `a${i}`,
      actualBalance: "1",
    }))
    expect(pitStopEntriesSchema.safeParse(many).success).toBe(false)
  })
})

describe("parsePitStopRow", () => {
  test("a blank row is skipped, not an error", () => {
    expect(parsePitStopRow("", idrBank)).toEqual({ kind: "blank" })
    expect(parsePitStopRow("   ", idrBank)).toEqual({ kind: "blank" })
  })

  test("garbage is invalid", () => {
    expect(parsePitStopRow("abc", idrBank)).toEqual({ kind: "invalid" })
    expect(parsePitStopRow("1.2.3", idrBank)).toEqual({ kind: "invalid" })
  })

  test("computes the difference against the canonical balance", () => {
    // Rp 120,000 typed against Rp 150,000 in the app.
    const parsed = parsePitStopRow("120000", idrBank)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind !== "ok") return
    expect(parsed.delta).toBe(parsed.signedActual - 15000000n)
    expect(parsed.delta < 0n).toBe(true)
  })

  test("locale-agnostic: '120.000' and '120,000' read as the same IDR amount", () => {
    const dot = parsePitStopRow("120.000", idrBank)
    const comma = parsePitStopRow("120,000", idrBank)
    expect(dot).toEqual(comma)
  })

  test("an unchanged balance is a zero difference (still a valid entry)", () => {
    const parsed = parsePitStopRow("150000", idrBank)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.delta).toBe(0n)
  })

  test("a credit card is asserted as the amount owed and signed negative", () => {
    const parsed = parsePitStopRow("500000", idrCard)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind !== "ok") return
    expect(parsed.signedActual).toBe(-parsed.actualBalance)
    expect(parsed.delta).toBe(parsed.signedActual + 30000000n)
    expect(parsed.delta < 0n).toBe(true) // owing more = less net worth
  })

  test("a negative value is only valid for a carve-out asset (overdraft)", () => {
    expect(parsePitStopRow("-5000", idrBank).kind).toBe("ok")
    expect(parsePitStopRow("-5000", idrCash)).toEqual({ kind: "invalid" })
    expect(parsePitStopRow("-5000", idrCard)).toEqual({ kind: "invalid" })
  })
})

describe("buildPitStopSubmission", () => {
  test("skips blank rows and counts invalid ones", () => {
    const submission = buildPitStopSubmission([
      { accountId: "a", facts: idrBank, raw: "120000" },
      { accountId: "b", facts: idrCash, raw: "" },
      { accountId: "c", facts: idrCash, raw: "nope" },
      { accountId: "d", facts: idrCard, raw: "500000" },
    ])
    expect(submission.invalidCount).toBe(1)
    expect(submission.entries.map((e) => e.accountId)).toEqual(["a", "d"])
    // The wire value is the magnitude (owed amount for the card), not signed.
    expect(submission.entries[1]?.actualBalance).toBe(
      (submission.entries[1]?.actualBalance ?? "").replace("-", "")
    )
  })

  test("nothing filled means nothing to send", () => {
    const submission = buildPitStopSubmission([
      { accountId: "a", facts: idrBank, raw: "" },
    ])
    expect(submission).toEqual({ entries: [], invalidCount: 0 })
  })
})

describe("pitStopPayloadFingerprint", () => {
  test("is order-independent and value-sensitive", () => {
    const a = { accountId: "a", actualBalance: "1" }
    const b = { accountId: "b", actualBalance: "2" }
    expect(pitStopPayloadFingerprint([a, b])).toBe(
      pitStopPayloadFingerprint([b, a])
    )
    expect(pitStopPayloadFingerprint([a, b])).not.toBe(
      pitStopPayloadFingerprint([a, { ...b, actualBalance: "3" }])
    )
  })
})

describe("displayBalance", () => {
  test("liabilities show what is owed as a positive number", () => {
    expect(displayBalance("LIABILITY", -300000n)).toBe(300000n)
    expect(displayBalance("ASSET", 150000n)).toBe(150000n)
  })
})

describe("selectPitStopAccounts", () => {
  const accounts = [
    { id: "1", ownerPersonId: "me", jointOwnerPersonId: null },
    { id: "2", ownerPersonId: "her", jointOwnerPersonId: null },
    { id: "3", ownerPersonId: "her", jointOwnerPersonId: "me" },
    { id: "4", ownerPersonId: null, jointOwnerPersonId: null },
  ]

  test("mine = owned by, or jointly owned with, the current person", () => {
    const { visible, ownsNothing } = selectPitStopAccounts(
      accounts,
      "me",
      "mine"
    )
    expect(visible.map((a) => a.id)).toEqual(["1", "3"])
    expect(ownsNothing).toBe(false)
  })

  test("everyone shows all eligible accounts", () => {
    const { visible } = selectPitStopAccounts(accounts, "me", "everyone")
    expect(visible).toHaveLength(4)
  })

  test("a person who owns nothing (or no person) falls back to all accounts", () => {
    for (const personId of ["nobody", null]) {
      const { visible, ownsNothing } = selectPitStopAccounts(
        accounts,
        personId,
        "mine"
      )
      expect(ownsNothing).toBe(true)
      expect(visible).toHaveLength(4)
    }
  })
})

describe("describeLastChecked", () => {
  const today = new Date("2026-09-20T10:00:00Z")
  test("never / today / yesterday / days / months", () => {
    expect(describeLastChecked(null, today)).toBe("Never checked")
    expect(describeLastChecked("2026-09-20", today)).toBe("Checked today")
    expect(describeLastChecked("2026-09-19", today)).toBe(
      "Last checked yesterday"
    )
    expect(describeLastChecked("2026-09-10", today)).toBe(
      "Last checked 10 days ago"
    )
    expect(describeLastChecked("2026-06-20", today)).toBe(
      "Last checked 3 months ago"
    )
  })

  test("a future or malformed date never renders nonsense", () => {
    expect(describeLastChecked("2026-09-25", today)).toBe("Checked today")
    expect(describeLastChecked("garbage", today)).toBe("Never checked")
  })
})

describe("unrecordedDirection", () => {
  test("classifies the net movement", () => {
    expect(unrecordedDirection(10n)).toBe("more")
    expect(unrecordedDirection(-10n)).toBe("less")
    expect(unrecordedDirection(0n)).toBe("none")
  })
})
