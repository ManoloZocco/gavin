---
kind: task
title: Guard parallel runs in one checkout
parent: learning-curve.md
status: In Progress
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

- [ ] Human test: Start all on a column of two cards while an agent already runs in the root checkout: the confirm warns about the shared checkout and Each in its own worktree launches each card in a worktree of its own.
- [ ] Human test: Turn on Hold on a live conflict on an unbound rail, run two other rails in the root checkout and start it: its next step stalls with needs you and a Confirm and start button that launches it.

## Comments

2026-10-23: Done: board launches warn when the checkout is shared and offer "Each in its own worktree"; commit via agent and builtin:commit stage per path when others are live in the checkout; the per-rail "Hold on a live conflict" opt-in (owner's decision: off by default, per rail) is stored (v81) and wired into the scheduler with "Confirm and start"; unbound rails get the root checkout's dirty paths in gavin_get_orchestration.
