---
kind: task
title: Guard parallel runs in one checkout
parent: learning-curve.md
status: To Do
priority: high
complexity: complex
labels: needs-triage
---
Board Run, Start all, Resume and spawned sessions always launch in the main checkout (`app/src/lib/cards/cardRun.ts:106-108`); only Best-of-N and the orchestration agent pick worktrees. Start all's confirm lists titles and a memory estimate and says nothing about a shared checkout (`app/src/lib/board/columnRunAction.ts:174-189`). Commit via agent and `builtin:commit` commit the whole checkout, other agents' half-written files included, while `builtin:consolidate-repo` already stages per path (`app/src/lib/orchestration/orchestrationTools.ts:495-510, 870-900`). `gavin_get_orchestration` gives dirty paths only to rails bound to a worktree (`crates/gavin-mcp/src/main.rs:1468-1476`). Context: report §4.

Do:
- Before a board launch, when other live sessions run in the same checkout (the `coTenants` logic in `app/src/lib/git/git.ts`), say so in the confirm and offer "each in its own worktree", reusing `defaultWorktreePath` / `freeBranchNameFrom` (`app/src/lib/git/git.ts:267, 308`), as Best-of-N does, and `[worktree] setup`.
- Make commit via agent and `builtin:commit` stage per path from the run's own touched files when other sessions are live in the checkout, the way `consolidate-repo` does.
- Give unbound rails the root checkout's dirty paths in `gavin_get_orchestration`.

Needs a decision before coding, file it with `gavin_request_human`: should a live same-worktree conflict hold the next stage launch as an opt-in, which is an exception to rule O4 ("never blocks a run")? Options: A) yes, opt-in per rail B) yes, workspace setting C) no, warn only.
