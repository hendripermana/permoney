# Issue Tracker: Linear

Issues, PRDs, milestones, and implementation tickets for Permoney live in
Linear. GitHub is used for source code, pull requests, and CI; do not create a
GitHub issue unless the user explicitly requests one.

## Workspace

- Team: `Permana`
- Canonical issue identifiers: `PER-<number>`
- Primary project: `Permoney v1.0 — Production Readiness Foundation`
- Milestones are Linear project milestones such as `M2 — Data Integrity` and
  `M2.5 — Core Domain Foundation`.

Use the installed Linear connector for all issue operations. If the connector
requires reauthentication or cannot access the `Permana` team, stop and ask the
user to reconnect it. Do not silently fall back to GitHub Issues or local
markdown.

## Conventions

- Read the complete Linear issue, including its project milestone, status,
  labels, relations, and comments, before implementation.
- Preserve the `PER-<number>` identifier in branch names, plans, PR
  descriptions, and handoffs.
- Create implementation work as Linear issues in the `Permana` team and attach
  it to the relevant project and milestone.
- Publish a PRD as a Linear issue unless the user explicitly requests a Linear
  document or project.
- Use parent/sub-issue and blocking relations when work has real dependency
  structure. Do not encode dependencies only in prose.
- Use Linear priority plus the existing `priority:P0`, `priority:P1`, or
  `priority:P2` labels consistently with the surrounding milestone.
- Use existing `area:*`, `type:*`, `Bug`, `Feature`, and `Improvement` labels
  rather than inventing near-duplicates.

## Workflow

Linear status represents execution progress:

| Status        | Meaning                                      |
| ------------- | -------------------------------------------- |
| `Backlog`     | Valid work not yet selected                  |
| `Todo`        | Selected and ready to begin                  |
| `In Progress` | Implementation is active                     |
| `In Review`   | Implementation is awaiting review or merge   |
| `Done`        | Acceptance criteria and verification are met |
| `Canceled`    | Work will not proceed                        |

Triage readiness is separate from execution status. Apply the labels defined
in `docs/agents/triage-labels.md`; for example, an issue can be in `Backlog`
and carry `ready-for-agent`.

## Skill Translation

- "Publish to the issue tracker" means create a Linear issue in `Permana`.
- "Fetch the relevant ticket" means retrieve the full Linear issue by its
  `PER-<number>` identifier.
- "Comment on the ticket" means add a Linear issue comment.
- "Close as won't fix" means apply `wontfix`, explain the decision in a
  comment, and move the issue to `Canceled`.
