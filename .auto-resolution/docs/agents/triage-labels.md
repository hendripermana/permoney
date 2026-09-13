# Triage Labels

The engineering skills use five canonical triage roles. The matching labels
exist on the Linear `Permana` team.

| Canonical role    | Linear label      | Meaning                                               |
| ----------------- | ----------------- | ----------------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer evaluation is required                     |
| `needs-info`      | `needs-info`      | Blocked pending clarification or evidence             |
| `ready-for-agent` | `ready-for-agent` | Fully specified and safe for an AI agent to implement |
| `ready-for-human` | `ready-for-human` | Requires human judgment, access, or ownership         |
| `wontfix`         | `wontfix`         | Reviewed and intentionally not planned                |

## Rules

- Apply exactly one readiness label during normal triage:
  `needs-triage`, `needs-info`, `ready-for-agent`, or `ready-for-human`.
- Remove the previous readiness label when the issue changes state.
- `ready-for-agent` means the issue contains explicit scope, acceptance
  criteria, relevant invariants, dependencies, and verification requirements.
- Do not mark an ambiguous ticket `ready-for-agent`; use `needs-info`.
- `wontfix` is terminal and may coexist with no readiness label. Pair it with a
  decision comment and the Linear `Canceled` status.
- Execution statuses such as `Todo` or `In Progress` do not replace these
  labels.
