# Security Policy

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

Email **hendri@permana.icu** with:

- A description of the issue and the impact
- Steps to reproduce (proof-of-concept code if applicable)
- Affected versions / commits
- Your contact info for follow-up

You should receive an acknowledgement within **72 hours**. We aim to publish a fix within **14 days** for high-severity issues, longer for low-severity. We will credit you in the changelog unless you prefer to remain anonymous.

## Scope

In scope:

- The `permoney` web application source code in this repository
- Database schema, migrations, and server functions (`src/server/**`)
- Authentication / authorization flows (when wired)
- Third-party dependency vulnerabilities surfaced via this codebase

Out of scope:

- Vulnerabilities in upstream packages already disclosed by their maintainers (report to them first)
- Self-hosted deployments where the operator has modified the code
- Social-engineering attacks against contributors
- Physical access attacks

## Security-Relevant Architecture

- **Server / client boundary** is enforced by `.server.ts` file naming + TanStack Start `import-protection` plugin. See [`AGENTS.md` §6](./AGENTS.md). Any PR weakening this fence will be rejected.
- **Database access** is only allowed inside `createServerFn(...).handler(...)` bodies. No `prisma` imports in route loaders, components, or hooks.
- **Secrets** never appear in client-bundled code. `.env` is gitignored; `.env.example` documents required keys.
- **Pre-commit hook** runs `vp check` (format + lint + type-check) and `intent stale` (skill-mapping drift detection). CI re-runs the same gates server-side; commits cannot bypass via `--no-verify` once merged.

## Supported Versions

Permoney is pre-1.0; only the `main` branch receives security updates. Pin to a specific commit SHA in production deployments.
