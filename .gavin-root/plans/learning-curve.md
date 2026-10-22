---
kind: plan
title: Flatten the learning curve: silent failures, settings, conflicts
status: To Do
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

- [ ] Flag agent sessions that never got their gavin tools (child `lc-01-flag-agent-sessions-without-gavin-tools.md`)
- [ ] Name card warnings for agents (child `lc-02-name-card-warnings-for-agents.md`)
- [ ] Setup progress counts what matters (child `lc-03-setup-progress-counts-what-matters.md`)
- [ ] Bring the PRD and dev docs up to date (child `lc-04-bring-prd-and-dev-docs-up-to-date.md`)
- [ ] Show the effective agent config (child `lc-05-show-the-effective-agent-config.md`)
- [ ] Guard parallel runs in one checkout (child `lc-06-guard-parallel-runs-in-one-checkout.md`)
- [ ] Card linter with safe fixes (child `lc-07-card-linter-with-safe-fixes.md`)
- [ ] Propose worktree setup from lockfiles (child `lc-08-propose-worktree-setup-from-lockfiles.md`)
- [ ] One prerequisite check at startup (child `lc-09-one-prerequisite-check-at-startup.md`)
- [ ] Detect two sessions writing one file (child `lc-10-detect-two-sessions-writing-one-file.md`)
- [ ] Desktop demo workspace and overloaded names (child `lc-11-desktop-demo-workspace-and-overloaded-names.md`)
- [ ] Orchestration store: busy timeout and guarded transitions (child `lc-12-orchestration-store-busy-timeout-and-guarded-transitions.md`)
