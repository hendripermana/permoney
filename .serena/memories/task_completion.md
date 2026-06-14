# Task Completion

- After dependency/remote changes, run `vp install`; if unavailable/failing, stop and report the exact error without package-manager substitution.
- Mandatory validation for repository changes: `vp check`, then `vp test`.
- If either fails, report the first failing command/error and do not claim completion until fixed or explicitly accepted as partial.
- Add boundary-specific validation: `vp run test:integration` for ledger/data-integrity changes; `vp run test:e2e` for routes, auth guards, hydration, or client-bundle behavior.
- Before completion, inspect `git diff`/`git status` and preserve unrelated user changes.
