---
kind: task
title: Show the effective agent config
parent: learning-curve.md
status: To Do
priority: high
complexity: moderate
labels: ready-for-agent
---
Which agent, model and effort a card runs on is resolved through five layers: card fields → complexity row → workspace `[agent]` → app per-profile default → `claude-code` (`app/src/lib/cards/cardAgent.ts:1-16`, `cards/complexity.ts:285-380`, `core/settings.ts:560-593`). Complexity tables ship empty (`app/src-tauri/src/config.rs:861-868`), so an agent's `complexity:` rating does nothing until a human fills them, and nothing says so. In a workspace, an empty value overrides the app's (`agentPrimary.ts:6-13`). No MCP tool reads any setting. Context: report §2.

Do:
- A pure resolver (extend the existing modules, don't fork them) that returns, for a workspace, the effective agent/model/effort/advisor per complexity level and for an unrated card, the fallback chain and both thresholds (fallback 90, pause limit 95), each value tagged with the layer it came from.
- A read-only MCP tool `gavin_get_effective_config` returning that. Read-only: no setting becomes writable here.
- In the card detail, a line "Runs on: <agent> · <model> · <effort> (from <layer>)". In the Agents settings, a note when the complexity table is empty that ratings have no effect yet.

Done when `cd app && npm test && npm run check` and `cargo test --workspace` are green, with resolver tests covering each layer winning and the empty-override case. Gate the new request type in `daemonCompat.ts` if it crosses the daemon.
