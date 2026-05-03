# ADR-0004 — Authentication strategy decision: Better-Auth

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-01     |
| **Accepted**      | 2026-05-01     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

Permoney is transitioning to Milestone M1 (Authentication & Tenant Isolation). The application currently has no real authentication (using mock security stubs). Picking the right authentication library and strategy is critical because rolling it back later requires rewriting all server functions, session code, RLS, and tests.

The candidates evaluated were:

1. **Better-Auth**: Official TanStack Start integration, batteries-included (MFA/OAuth/email), aligned with our stack.
2. **Lucia v3**: Mature and framework-agnostic, but requires manual wiring for OAuth/MFA.
3. **Custom (argon2id + iron-session + Postgres)**: Zero dependency surface, total control, but reinventing the wheel increases our bug surface.

## Decision

**We will use Better-Auth as the authentication library.**

Better-Auth provides seamless native integration with TanStack Start, which is the core framework for Permoney. While it is a younger library, the velocity and framework alignment make it the best choice. It handles session management, password hashing, and provides hooks for future OAuth/MFA expansion without requiring us to build those flows from scratch.

### 1. Threat Model

- **Defended against:**
  - **Credential Stuffing & Brute Force:** Mitigated via rate-limiting (see below).
  - **Session Fixation:** Session rotated on privilege changes (login, password reset).
  - **CSRF:** Mitigated by `SameSite=Lax` cookies and TanStack Start's server functions.
  - **XSS Cookie Theft:** Mitigated by `HttpOnly` and `Secure` flags on all session cookies.
  - **Account Enumeration:** Generic error messages ("Invalid credentials", "If the email exists, a reset link has been sent").
- **Accepted Risks:**
  - MFA is deferred to v1.1.

### 2. Data Shape

Better-Auth dictates a specific core schema, which we will adapt and integrate into our existing Prisma models:

- **`User` model additions:** Add `name` (if missing), `emailVerified`, `image`, and `createdAt`/`updatedAt`.
  - Add `passwordHash` to `User` (separate from any legacy mock `password` field).
  - `familyId` remains as the tenant scoping key.
- **`Session` model:** `id`, `userId`, `expiresAt`, `ipAddress`, `userAgent`, `createdAt`, `updatedAt`.
- **`Account` model:** For OAuth provider linking.
- **`Verification` model:** `id`, `identifier`, `value`, `expiresAt`.

### 3. Cookie Config

Cookies will be strictly configured using Better-Auth's advanced cookie settings:

- **Name:** `__Host-permoney.session_token` (using `__Host-` prefix to lock it to the domain and require secure context).
- **Flags:** `HttpOnly`, `Secure` (always true in prod), `SameSite=Lax`.
- **Max-Age:** 7 days (rolling-renew strategy: Better-Auth will extend the session if it's close to expiry and the user is active).

### 4. Password Policy

We will configure the `email-password` plugin to use strong hashing, specifically `argon2id`:

- **Algorithm:** argon2id
- **Parameters:** Memory ≥ 64 MB, parallelism: 4, iterations: 3 (minimums for OWASP compliance).
- **Rules:** Minimum 8 characters, no maximum length (up to bcrypt limits if fallback is used). Optional integration with `zxcvbn` for complexity checking in the frontend.
- **Rotation:** Users must rotate passwords upon confirmed breach (future feature).

### 5. Session Rotation

We adhere to OWASP ASVS V3.2 by explicitly invalidating and issuing new session tokens upon any privilege change:

- Login
- Password reset
- Email change
  Better-Auth handles this seamlessly via its session invalidation API.

### 6. Logout Semantics

We will support both "single-device" and "all-devices" logout:

- Standard logout revokes the current `Session`.
- A "Revoke All Sessions" action will iterate and delete all `Session` records for the `userId`.

### 7. Email Verification & Password Reset

- **Flow Design:** Generates a secure, cryptographically random token via Better-Auth's `email-password` plugin.
- **Token Lifetime:**
  - Password Reset: 1 hour.
  - Email Verification: 24 hours.
- Tokens are stored in the `Verification` table and one-time use.

### 8. Rate-Limiting

Rate limiting will be implemented to protect auth endpoints (M1-6):

- **Policy:** 5 failed login attempts per 15 minutes per IP.
- **Backoff:** Exponential backoff after the threshold is reached.

### 9. OAuth Roadmap

Explicitly out-of-scope for v1.0. However, Better-Auth includes an `Account` model natively, which provides a clean, schema-ready upgrade path for adding Google/GitHub OAuth in v1.1.

## Consequences

### Positive

- We gain a robust, production-ready auth system without reinventing cryptography or session management.
- Native integration with TanStack Start server functions simplifies context passing (e.g., extracting the session).
- Standardized schema for sessions and accounts future-proofs the app for OAuth.

### Negative / risks

- **Coupling:** We are heavily coupled to Better-Auth's Prisma schema requirements (`User`, `Session`, `Account`, `Verification`).
- **Maturity:** Better-Auth is newer than NextAuth/Auth.js or Lucia, meaning we might hit edge cases with TanStack Start integration.

## Alternatives Considered

- **Lucia v3:** Rejected due to more manual wiring required for OAuth and email verification flows, whereas Better-Auth includes these plugins.
- **Custom (argon2id + iron-session + Postgres sessions table):** Rejected because the bug surface area for writing our own password reset, session rotation, and cookie security logic is too high for the perceived benefit of "zero dependencies."
