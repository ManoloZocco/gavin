---
kind: plan
title: Flatten the learning curve: silent failures, settings, conflicts
status: In Progress
priority: high
labels: needs-triage
---
Follow-up of the audit in `docs/research/2026-10-22-curva-di-apprendimento.md` (Italian; every claim there carries a file:line). Read it before working any child.

Three threads run through it:
- Failures that make no sound: an agent with no `gavin_*` tools, a card that leaves its plan, a status that makes a column. The daemon often already holds the signal and shows nothing.
- About 60 settings, none of which an agent can read; only four per-card fields are writable over MCP.
- Conflict prevention lives in prompt lines ("never `git add -A`") while the measured signals (`shell-writes`, dirty paths) never block or warn before a launch.

The criterion for who sets what (report §7): derivable from the environment with certainty → the agent sets it and says so; reversible and local → the agent acts and leaves a visible line; runs a command, spends quota or sends data off the machine → the agent proposes, the trust gate or a `Decision:` decides; security or identity → manual.

## Checklist

- [x] Flag agent sessions that never got their gavin tools (child `lc-01-flag-agent-sessions-without-gavin-tools.md`)
- [x] Name card warnings for agents (child `lc-02-name-card-warnings-for-agents.md`)
- [x] Setup progress counts what matters (child `lc-03-setup-progress-counts-what-matters.md`)
- [x] Bring the PRD and dev docs up to date (child `lc-04-bring-prd-and-dev-docs-up-to-date.md`)
- [x] Show the effective agent config (child `lc-05-show-the-effective-agent-config.md`)
- [x] Guard parallel runs in one checkout (child `lc-06-guard-parallel-runs-in-one-checkout.md`)
- [x] Card linter with safe fixes (child `lc-07-card-linter-with-safe-fixes.md`)
- [x] Propose worktree setup from lockfiles (child `lc-08-propose-worktree-setup-from-lockfiles.md`)
- [x] One prerequisite check at startup (child `lc-09-one-prerequisite-check-at-startup.md`)
- [ ] Detect two sessions writing one file (child `lc-10-detect-two-sessions-writing-one-file.md`)
- [ ] Desktop demo workspace and overloaded names (child `lc-11-desktop-demo-workspace-and-overloaded-names.md`)
- [ ] Orchestration store: busy timeout and guarded transitions (child `lc-12-orchestration-store-busy-timeout-and-guarded-transitions.md`)

## Comments

2026-10-23: lc-01 to lc-09 are implemented (protocol v79 to v81) and waiting on the human tests filed on each card. lc-10 (design for detecting two sessions writing one file) and lc-11 (renames and a desktop demo, deferred by the owner) are open; lc-12 turned out half wrong, see its card.
