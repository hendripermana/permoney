# Issue Tracker: Linear (+ GitHub Issues fallback)

Issues, PRDs, milestones, and implementation tickets for Permoney live in
Linear. GitHub is used for source code, pull requests, and CI.

**Since the 2026-10-11 head-of-eng audit the repo's GitHub Issues are an
official secondary ledger.** Linear's free plan allows comments only, so
roadmap/audit work that outgrows a comment thread (and anything the user asks
to track as an issue) is filed as a GitHub issue — labels `roadmap/p0`,
`roadmap/p1`, `roadmap/p2`, `audit/<date>` (e.g. `audit/2026-10-11`), with an
index issue collecting the map (currently #448). Do not track the same work in
both systems at once; each item has one owner system.

## Workspace

- Team: `Permana`
- Canonical issue identifiers: `PER-<number>` (Linear) or `#<number>` (GitHub)
- Primary project: `Permoney v1.0 — Production Readiness Foundation`
- Milestones are Linear project milestones such as `M2 — Data Integrity` and
  `M2.5 — Core Domain Foundation`.
- Projects V2 board: pending a token with the `project` scope
  (`gh auth refresh -s project`); until then the label set plus the index issue
  are the board.

Use the installed Linear connector for Linear issue operations. If the
connector requires reauthentication or cannot access the `Permana` team, stop
and ask the user to reconnect it — except when the user explicitly directs an
item to GitHub Issues, which is then the correct ledger for that item.

## Conventions

- Read the complete issue in its owning system — description, milestone,
  status, labels, relations, and comments — before implementation.
- Preserve the identifier in branch names, plans, PR descriptions, and
  handoffs: `PER-<number>` for Linear items, `#<number>` for GitHub items.
- Create implementation work in the owning system: Linear when it can accept
  new issues, otherwise GitHub Issues with the labels above.
- Publish a PRD as a Linear issue unless the user explicitly requests a Linear
  document or project (or a GitHub issue).
- Use parent/sub-issue and blocking relations when work has real dependency
  structure. Do not encode dependencies only in prose.
- Use Linear priority plus the existing `priority:P0`, `priority:P1`, or
  `priority:P2` labels consistently with the surrounding milestone; on GitHub
  use the equivalent `roadmap/p0…p2` labels.
- Use existing `area:*`, `type:*`, `Bug`, `Feature`, and `Improvement` labels
  rather than inventing near-duplicates.
- **The repository is PUBLIC.** Never write personal, family, or financial
  data (account names, balances, amounts) into GitHub issues, PRs, or comments
  — describe the shape of the problem, not the person's ledger.

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

For GitHub items, `open` ↔ `closed` carries the same meaning; closing happens
when the implementing PR merges (reference the issue in the PR body).

Triage readiness is separate from execution status. Apply the labels defined
in `docs/agents/triage-labels.md`; for example, an issue can be in `Backlog`
and carry `ready-for-agent`.

## Skill Translation

- "Publish to the issue tracker" means create a Linear issue in `Permana`, or
  a GitHub issue when Linear's plan cannot accept it (or the user says so).
- "Fetch the relevant ticket" means retrieve the full issue by its identifier:
  `PER-<number>` from Linear, `#<number>` from GitHub.
- "Comment on the ticket" means add a comment in the owning system.
- "Close as won't fix" means apply `wontfix`, explain the decision in a
  comment, and move the issue to `Canceled` (Linear) or close it with a reason
  (GitHub).
