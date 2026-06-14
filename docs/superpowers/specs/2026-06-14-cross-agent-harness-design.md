# Cross-Agent Harness Design

## Goal

Permoney should retain the same project understanding when work moves between
Codex, CommandCode, Serena-enabled clients, and other coding agents. A new
agent should discover the issue workflow, domain invariants, engineering
commands, and architectural decisions without requiring the user to repeat the
project setup.

The harness must not turn continuously learned preferences into authoritative
financial rules. Durable correctness remains explicit, reviewable, and
versioned.

## Guidance Layers

Each guidance mechanism has one owner:

| Layer | Purpose | Authority |
| --- | --- | --- |
| Database constraints and accepted ADRs | Financial and tenant invariants | Highest |
| `AGENTS.md` and `docs/agents/` | Repository-wide operating contract | Mandatory |
| Linear ticket | Scope and acceptance criteria for current work | Mandatory for the ticket |
| Agent skills | Reusable task workflows | Mandatory when triggered |
| Serena project memories | Stable codebase map and retrieval hints | Advisory, versioned |
| CommandCode Taste | Learned micro-preferences and interaction style | Advisory, continuously learned |

When two layers conflict, the higher layer wins. Taste must never override an
ADR, repository rule, ticket acceptance criterion, security requirement, or
ledger invariant.

## CommandCode Taste

`.commandcode/taste/` remains ignored by Git because CommandCode updates it
continuously. Committing auto-learned files would create persistent worktree
noise and allow unreviewed probabilistic preferences to enter pull requests.

Project Taste is bootstrapped from existing Codex, Claude Code, and other
supported agent sessions, then synchronized through the authenticated
CommandCode profile:

```bash
cmd learn-taste
cmd taste lint --all
cmd taste push --all
```

The project documentation records these commands and the authority boundary.
Taste may learn preferences such as naming, module depth, review style, or
communication tone. It must not be used as the only location for durable
project knowledge.

## Serena

`.serena/project.yml` and stable project memories remain versioned. Serena owns:

- semantic symbol navigation and reference analysis;
- the durable source map and toolchain summary;
- concise retrieval hints for relevant ADRs and project commands.

Serena does not duplicate complete ADRs, tickets, or `AGENTS.md`. Its initial
prompt directs an activated agent to read `mem:core`, then the current Linear
ticket and relevant domain documents before implementation.

Local caches, logs, and machine-specific overrides remain ignored. The
maintenance checks are:

```bash
serena memories check
serena project health-check .
serena project index .
```

## Repository Contract

`AGENTS.md` contains the short, always-visible cross-agent contract.
`docs/agents/agent-harness.md` contains detailed ownership, precedence,
bootstrap, synchronization, and troubleshooting instructions.

No automated bidirectional synchronization is introduced between Taste,
Serena memories, and repository rules. Their data models have different trust
levels; automatic copying would erase those boundaries and create stale or
unsafe guidance.

## Failure Behavior

- If CommandCode is unavailable or unauthenticated, normal development
  continues using repository rules and Serena. Taste synchronization is
  skipped and reported.
- If Taste lint fails, do not push the profile until the generated package is
  reviewed or corrected.
- If Serena health or memory checks fail, fix the project configuration before
  claiming the harness is ready.
- If learned Taste conflicts with durable guidance, correct or remove the Taste
  learning rather than weakening the durable rule.

## Verification

The completed harness must pass:

```bash
cmd taste lint --all
serena memories check
serena project health-check .
vp check
vp test
```

The PR should include only versioned repository guidance and Serena metadata.
CommandCode Taste remains local/remote-managed and does not appear in Git.
