---
kind: task
title: Card linter with safe fixes
parent: learning-curve.md
status: In Progress
priority: medium
complexity: complex
labels: ready-for-agent
---
Blocked by: lc-02-name-card-warnings-for-agents.md

Several card rules act without a word (report §3): Done moves a file only when the status slugs to `done` while rails treat the rightmost column as done (`crates/daemon/src/gavin.rs:1239`, `app/src/lib/orchestration/orchestration.ts:321-327`); a move into `done/` is skipped with only an `eprintln` when the name is taken (`gavin.rs:1535-1541`); open `Decision:` / `Human test:` items on a Done or archived card vanish from both tabs (`app/src/lib/decisions/decisions.ts:23-29`); duplicate file names in one context break `parent:` resolution.

Build on lc-02's named warnings a linter the daemon runs over a context on change, and surface its findings on the card and in `gavin_get_tree`. Split them:
- Safe to fix without asking (do it, and leave a dated line under `## Comments` on the card saying what changed): status and folder out of step, a status differing from a column only by case or spacing.
- Needs the human (file a `Decision:` with options via the existing human-item path): an unknown status (offer the nearest columns), a name collision blocking a move, a custom column right of Done, open human items on a Done card, labels outside the board's vocabulary.

Follow the precedent of the "Clean stale" action (`app/src/lib/decisions/cleanStale.ts`). Done when the touched suites are green with a test per rule.

- [ ] Human test: On the board, a card with a misspelt status, a broken parent pointing at a task, and a Shipped column placed after Done each show a warning that names the field and the reason.

2026-10-23: Done: `cardLint.ts` names status, parent, done-folder, column, human-item, label, direct and duplicate-name problems on the card and column; safe fixes reach agents through gavin_doctor, which lists the exact gavin_set_plan_field writes, and the orchestrate skill applies them. The app itself still applies no fix automatically.
