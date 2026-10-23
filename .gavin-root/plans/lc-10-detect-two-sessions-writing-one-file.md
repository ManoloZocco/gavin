---
kind: task
title: Detect two sessions writing one file
parent: learning-curve.md
status: To Do
priority: medium
complexity: intricate
labels: needs-triage
---
Blocked by: lc-06-guard-parallel-runs-in-one-checkout.md

Nothing detects two agents editing the same file in one checkout; you find out from a broken build or a mixed diff. Predicting it from card text was tried and dropped: it missed 34 of 37 real collisions (`docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`, E6). The measured signals exist: per-call `shell-writes` records (`crates/gavin-mcp/src/shell_writes.rs`, observation only) and transcript edits (`app/src-tauri/src/agent_edits.rs`). Their known limit: a write window credits anything written in the checkout during the call to that call (`shell_writes.rs:13-20`). Context: report §4.

Write a short design first under `docs/superpowers/specs/` and stop for review (`gavin_request_human` decision): how to cross-check those records across live sessions sharing a checkout, how to avoid false alarms from the shared write window, and what to do on a hit (a tab mark for the human; a line in each agent's next prompt via the follow-up queue). Implementation is a separate card once the design is approved.
