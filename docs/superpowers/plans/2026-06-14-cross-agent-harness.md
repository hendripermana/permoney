# Cross-Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Permoney's durable project understanding portable across Codex, CommandCode, Serena-enabled clients, and other coding agents without treating continuously learned Taste as authoritative policy.

**Architecture:** Keep mandatory guidance in versioned repository documents, stable retrieval context in versioned Serena configuration/memories, and continuously learned micro-preferences in ignored CommandCode Taste packages synchronized through CommandCode. Define an explicit precedence order and maintenance workflow so each agent knows which layer owns which information.

**Tech Stack:** Markdown repository guidance, CommandCode CLI/Taste, Serena CLI/MCP, Vite+ verification.

---

### Task 1: Document Cross-Agent Ownership and Precedence

**Files:**

- Modify: `AGENTS.md`
- Create: `docs/agents/agent-harness.md`
- Modify: `docs/agents/domain.md`

- [ ] **Step 1: Add the short always-visible contract**

Add an `Agent harness` subsection to `AGENTS.md` that:

- points to `docs/agents/agent-harness.md`;
- names the precedence order;
- states that Taste is advisory and may not override durable guidance.

- [ ] **Step 2: Add the detailed harness guide**

Create `docs/agents/agent-harness.md` with:

- portability goal;
- layer ownership table;
- precedence rules;
- first-session bootstrap for any agent;
- CommandCode Taste learning/lint/push/pull commands;
- Serena memory/health/index commands;
- conflict and failure behavior.

- [ ] **Step 3: Link the harness from domain guidance**

Add a concise reference in `docs/agents/domain.md` without duplicating the
full precedence contract.

- [ ] **Step 4: Verify formatting**

Run: `vp check`

Expected: formatting, lint, and type checks pass.

### Task 2: Harden Serena Activation

**Files:**

- Modify: `.serena/project.yml`
- Modify: `.serena/memories/core.md`
- Modify: `.serena/memories/task_completion.md`
- Modify: `.serena/.gitignore`

- [ ] **Step 1: Add a concise Serena initial prompt**

Set `initial_prompt` to require:

1. reading `mem:core`;
2. reading the current Linear ticket and relevant ADRs;
3. treating `AGENTS.md` as mandatory;
4. treating Serena memories as retrieval aids rather than policy overrides.

- [ ] **Step 2: Add cross-agent references to core memory**

Point `mem:core` to `docs/agents/agent-harness.md` and preserve the existing
memory graph.

- [ ] **Step 3: Add harness checks to task completion**

Record `serena memories check` as a required check when Serena metadata changes.

- [ ] **Step 4: Keep generated Serena state local**

Ensure `/cache`, `/logs`, and `/project.local.yml` remain ignored.

- [ ] **Step 5: Validate Serena**

Run:

```bash
serena memories check
serena project health-check .
serena project index .
```

Expected: referential integrity and health checks pass; index completes without
repository changes outside ignored cache/log paths.

### Task 3: Bootstrap and Synchronize CommandCode Taste

**Files:**

- Local only: `.commandcode/taste/**`
- No Git-tracked Taste files

- [ ] **Step 1: Confirm authentication and current packages**

Run:

```bash
cmd status
cmd taste list
```

Expected: authenticated CommandCode account and existing project Taste package.

- [ ] **Step 2: Learn project taste**

Run:

```bash
cmd learn-taste
```

Expected: CommandCode updates `.commandcode/taste/` from supported prior agent
sessions.

- [ ] **Step 3: Review learned preferences**

Inspect every generated `taste.md`. Remove or correct any learning that:

- duplicates an ADR or mandatory rule as a probabilistic preference;
- contradicts Vite+, strict TypeScript, no-use-effect, tenant isolation, or
  ledger invariants;
- contains secrets or machine-specific paths.

- [ ] **Step 4: Validate and synchronize**

Run:

```bash
cmd taste lint --all
cmd taste push --all
```

Expected: all packages validate and the project Taste is synchronized to the
authenticated remote profile.

- [ ] **Step 5: Verify Git isolation**

Run: `git status --short`

Expected: no `.commandcode/` paths appear.

### Task 4: Final Verification and Publish

**Files:**

- All modified versioned harness files

- [ ] **Step 1: Run repository gates**

Run:

```bash
vp check
vp test
```

Expected: all checks and tests pass.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended versioned harness files changed.

- [ ] **Step 3: Commit implementation**

Commit message:

```text
chore: add portable cross-agent harness
```

- [ ] **Step 4: Push to PR #98**

Push `ai-agent-guidance-20260614` and verify PR #98 contains the new commit.
