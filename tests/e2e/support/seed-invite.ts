import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Client } from "pg"

// ADR-0057 e2e support. The invite email is sent through Resend and the raw
// token exists only inside that email, so an e2e spec cannot read it back from
// the app. Rather than adding a "capture emails in test mode" branch to
// production code, specs seed a `FamilyInvite` row straight into the e2e
// database (with a raw token they choose) and drive the REAL accept UI with it.
// The row is exactly what `createFamilyInviteForFamily` writes: only
// sha256(rawToken) is stored.

interface E2eState {
  databaseUrl: string
}

function readE2eDatabaseUrl(): string {
  const statePath = resolve(
    process.cwd(),
    ".playwright/permoney-e2e-state.json"
  )
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as E2eState
    return state.databaseUrl
  } catch (cause) {
    throw new Error(
      `Cannot seed a family invite: the e2e server state file is missing at ${statePath}. ` +
        `Seeding needs the locally started e2e server (not PERMONEY_E2E_BASE_URL).`,
      { cause }
    )
  }
}

/**
 * Inserts a live invite from `inviterEmail`'s family to `inviteeEmail` and
 * returns the RAW token to put in `/invite/accept?token=…`.
 */
export async function seedFamilyInvite({
  inviterEmail,
  inviteeEmail,
  role = "member",
}: {
  inviterEmail: string
  inviteeEmail: string
  role?: "admin" | "member" | "viewer"
}): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url")
  const tokenHash = createHash("sha256").update(rawToken).digest("hex")

  const client = new Client({ connectionString: readE2eDatabaseUrl() })
  await client.connect()
  try {
    const result = await client.query(
      `INSERT INTO "FamilyInvite"
         (id, "familyId", email, role, "tokenHash", "invitedById", "expiresAt", "updatedAt")
       SELECT $1, u."familyId", $2, $3, $4, u.id, now() + interval '7 days', now()
       FROM "User" u
       WHERE u.email = $5 AND u."familyId" IS NOT NULL`,
      [
        randomUUID(),
        inviteeEmail.trim().toLowerCase(),
        role,
        tokenHash,
        inviterEmail,
      ]
    )
    if (result.rowCount !== 1) {
      throw new Error(
        `Expected to seed exactly one invite for inviter ${inviterEmail}, seeded ${result.rowCount}`
      )
    }
  } finally {
    await client.end()
  }
  return rawToken
}
