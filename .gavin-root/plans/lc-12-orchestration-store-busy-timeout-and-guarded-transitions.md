---
kind: task
title: Orchestration store: busy timeout and guarded transitions
parent: learning-curve.md
status: To Do
priority: low
complexity: simple
labels: ready-for-agent
---
The dev and release daemons share `orchestration.sqlite` by design (`docs/superpowers/specs/2026-09-11-per-build-daemon-isolation-design.md`). `kanban.sqlite` sets a 5 s busy timeout and claims fires atomically (`crates/daemon/src/kanban.rs:93-97, 941`); `OrchestrationStore::open` (`crates/daemon/src/orchestration.rs:16`) appears to set none, and `set_rail_run` / `set_step_run` (`:627`, `:647`) appear to overwrite without checking the current state. Both are read from code, not reproduced. Context: report §4.

Do:
- Confirm both by reading the code, then reproduce with two store handles on one file (the way `kanban.rs` tests its fire claim).
- Set the same busy timeout as `kanban.sqlite`.
- Make step and rail run transitions compare-and-set on the expected current state, so two daemons cannot both start one step; the loser reports "already started" instead of overwriting.

Done when `cargo test -p gavin-daemon` is green (re-run `gavin::tests` alone if it flakes) with the two-handle tests. Never restart the shared daemon.

## Comments

2026-10-23: the busy-timeout half was wrong. rusqlite 0.31 sets a 5 s busy timeout on every `Connection::open` (`src/inner_connection.rs:121`), and a test holding `BEGIN IMMEDIATE` on a second connection showed `set_rail_run` already waits it out with no change. Only the guarded transitions remain. A daemon-side compare-and-set cannot tell a legitimate resume (running sess-1 → running sess-2 in one daemon, see the existing test near `orchestration.rs:2207`) from the other build starting the same step, so this needs the app to send the state it expects, which widens `SetStepRun` and needs the FEATURE_MIN_VERSION treatment. Left for a decision on whether it is worth that.
