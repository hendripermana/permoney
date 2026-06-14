# Cross-Agent Harness

Permoney uses multiple coding agents. The harness makes durable project
understanding portable so moving between Codex, CommandCode, Serena-enabled
clients, and other tools does not require rebuilding context manually.

The layers complement each other. They are not interchangeable.

## Authority and Ownership

Use this precedence order when guidance conflicts:

1. Database constraints and accepted ADRs.
2. `AGENTS.md` and `docs/agents/`.
3. The current Linear ticket and its acceptance criteria.
4. Triggered agent skills.
5. Serena project memories.
6. CommandCode Taste.

Higher layers always win.

| Layer               | Owns                                                              |
| ------------------- | ----------------------------------------------------------------- |
| Database and ADRs   | Financial meaning, tenant isolation, and durable architecture     |
| Repository guidance | Mandatory engineering and operating rules                         |
| Linear              | Current scope, dependencies, priority, and definition of done     |
| Skills              | Reusable task-specific workflows                                  |
| Serena              | Stable source map, semantic retrieval, and concise project memory |
| Taste               | Learned micro-preferences, review habits, and interaction style   |

Do not copy an invariant into Taste and then treat its confidence score as
authority. Do not copy complete tickets or ADRs into Serena memories. Each
layer should reference the canonical source instead of creating a second
source of truth.

## First Session in Any Agent

Before implementation:

1. Read `AGENTS.md`.
2. Read `docs/agents/issue-tracker.md`, this file, and
   `docs/agents/domain.md`.
3. Fetch the complete current Linear ticket.
4. Read `CONTEXT.md` when present and the relevant accepted ADRs.
5. Load the task-specific skills.
6. If Serena is available, activate `permoney` and read `mem:core`.

If no Linear ticket or explicit acceptance criteria exist, ask for them before
changing code. Do not infer financial behavior from UI code, Taste, or an old
session.

## CommandCode Taste

Project Taste lives under `.commandcode/taste/` and is intentionally ignored
by Git because CommandCode updates it continuously.

Bootstrap or refresh it from prior Codex, Claude Code, and other supported
agent sessions:

```bash
cmd learn-taste
cmd taste lint --all
```

Synchronize it through the authenticated CommandCode profile:

```bash
cmd taste push --all
cmd taste pull hendripermana/permoney
```

After learning or pulling, inspect every `taste.md`. Remove or correct:

- secrets, credentials, personal data, or machine-specific paths;
- preferences that contradict Vite+, strict TypeScript, no-use-effect, tenant
  isolation, ledger invariants, or accepted ADRs;
- probabilistic copies of durable rules that belong in versioned guidance.

If CommandCode is unavailable or unauthenticated, continue using the
repository contract and Serena. Report that Taste synchronization was skipped.

## Serena

Versioned Serena state:

- `.serena/project.yml` configures the TypeScript project and activation
  prompt.
- `.serena/memories/` stores stable, concise project knowledge.

Local Serena state remains ignored:

- `.serena/cache/`
- `.serena/logs/`
- `.serena/project.local.yml`

Maintenance commands:

```bash
serena memories check
serena project health-check .
serena project index .
```

Serena memories are retrieval aids. If a memory conflicts with `AGENTS.md`, a
Linear ticket, or an ADR, update the memory; do not weaken the canonical rule.

## Updating the Harness

- Change `AGENTS.md` or `docs/agents/` when a mandatory workflow changes.
- Add or update an ADR when architectural meaning changes.
- Update Serena memory only for stable, non-obvious context that avoids
  repeated discovery.
- Let CommandCode learn micro-preferences through normal work; review before
  pushing.
- Never automate bidirectional copying between these layers. Their trust and
  lifecycle models are intentionally different.
