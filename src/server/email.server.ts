import { Resend } from "resend"

// =============================================================================
// ADR-0057 — Family invitation by email. Server-only (`*.server.ts` hard
// fence, CLAUDE.md §6): imports the `resend` SDK, never reachable from client
// code.
//
// Fail loudly, not silently: unlike rate-limit.ts's degrade-to-in-memory
// pattern, email delivery IS this feature's entire point. An unset
// RESEND_API_KEY/RESEND_FROM_EMAIL or a failed Resend API call throws
// `EmailDeliveryError`, which the caller (`createFamilyInviteForFamily`) lets
// propagate out of the surrounding `$transaction` so the `FamilyInvite` row it
// just created rolls back too — never a silent "succeeded" with no email
// actually sent.
// =============================================================================

export class EmailDeliveryError extends Error {
  override readonly name = "EmailDeliveryError"
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export interface FamilyInviteEmailInput {
  to: string
  familyName: string
  inviterName: string
  acceptUrl: string
  /** How long the accept link stays valid — rendered into the email copy. */
  expiresInDays: number
}

/**
 * Sends the family-invite email via Resend. Testability: callers accept an
 * injectable `sendInviteEmail` parameter that defaults to this function — the
 * same dependency-injection convention this codebase already uses for
 * `runInTenantTransaction` (see mutation-kit.ts) — so integration tests can
 * substitute a fake sender without `vi.mock` and without a real
 * `RESEND_API_KEY` or network call.
 */
export async function sendFamilyInviteEmail({
  to,
  familyName,
  inviterName,
  acceptUrl,
  expiresInDays,
}: FamilyInviteEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || apiKey.trim() === "") {
    throw new EmailDeliveryError(
      "RESEND_API_KEY is not set — cannot send the family invitation email. " +
        "Set RESEND_API_KEY (and RESEND_FROM_EMAIL) in .env; see .env.example."
    )
  }

  const from = process.env.RESEND_FROM_EMAIL
  if (!from || from.trim() === "") {
    throw new EmailDeliveryError(
      "RESEND_FROM_EMAIL is not set — cannot send the family invitation " +
        "email. Set it in .env; see .env.example."
    )
  }

  const resend = new Resend(apiKey)
  let error: { message: string } | null = null
  try {
    const result = await resend.emails.send({
      from,
      to,
      subject: `You're invited to join ${familyName} on Permoney`,
      html: renderFamilyInviteEmailHtml({
        familyName,
        inviterName,
        acceptUrl,
        expiresInDays,
      }),
    })
    error = result.error ?? null
  } catch (cause) {
    throw new EmailDeliveryError(
      `Resend request failed while sending the family invitation email: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    )
  }

  if (error) {
    throw new EmailDeliveryError(
      `Resend failed to send the family invitation email: ${error.message}`,
      { cause: error }
    )
  }
}

function renderFamilyInviteEmailHtml({
  familyName,
  inviterName,
  acceptUrl,
  expiresInDays,
}: Omit<FamilyInviteEmailInput, "to">): string {
  const safeFamilyName = escapeHtml(familyName)
  const safeInviterName = escapeHtml(inviterName)
  const safeAcceptUrl = escapeHtml(acceptUrl)

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 8px;">
                <h1 style="margin:0 0 16px;font-size:20px;color:#111827;">You're invited to Permoney</h1>
                <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">
                  <strong>${safeInviterName}</strong> invited you to join
                  <strong>${safeFamilyName}</strong> on Permoney, a shared
                  family finance ledger.
                </p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
                  Click below to accept the invitation. This link expires in
                  ${expiresInDays} ${expiresInDays === 1 ? "day" : "days"}.
                </p>
                <p style="margin:0 0 24px;text-align:center;">
                  <a href="${safeAcceptUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">
                    Accept invitation
                  </a>
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
                  If the button above doesn't work, copy and paste this link
                  into your browser:
                </p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="${safeAcceptUrl}" style="color:#2563eb;">${safeAcceptUrl}</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">
                  If you weren't expecting this invitation, you can safely
                  ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
