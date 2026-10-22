---
kind: task
title: Name card warnings for agents
parent: learning-curve.md
status: To Do
priority: high
complexity: simple
labels: ready-for-agent
---
`gavin_get_tree` promises "warnings" (`crates/gavin-mcp/src/main.rs:691`) but each card carries one bare boolean, `parseWarning` (`crates/gavin-mcp/src/cards.rs:99`). An agent cannot tell which field is wrong, that a `parent:` is broken, or that a status matches no column. Status is free text in the daemon (`crates/daemon/src/gavin.rs:1688`), so a typo from an agent silently creates an auto column. Context: report §3.

Do:
- Add to each card in `gavin_get_tree` a list of named warnings: the field and why (bad kind/priority/order/complexity, `parent:` or `direct:` on a non-task, broken parent with its reason: missing, is a task, is itself, other context; status matching no board column). Keep `parseWarning` for older readers. Omit the list when empty, as the tree already omits empty fields (`cards.rs:751`).
- Make `gavin_set_plan_field` with key `status` say in its reply when the value matches no column, naming the nearest column. Still write it: a new column may be intended.
- Fix `gavin_get_board`'s description, which promises "the human's free-form cards" but returns columns and labels only (`main.rs:732`).
- Fix the board chip text "file not found in this context" (`app/src/lib/board/BoardCard.svelte:435`, `CardDetailModal.svelte:1406`) to give the real reason when the file exists but is not a plan.

Done when `cargo test --workspace` and `cd app && npm test` are green with tests for each warning kind.
