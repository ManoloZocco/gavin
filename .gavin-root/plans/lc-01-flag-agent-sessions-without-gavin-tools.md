---
kind: task
title: Flag agent sessions that never got their gavin tools
parent: learning-curve.md
status: To Do
priority: high
complexity: moderate
labels: ready-for-agent
---
The most common failure in the history (16 of the last 74 `fix` commits) is an agent that starts without `gavin_*` tools and nobody notices: the client shows `gavin (CONNECTION_CLOSED)` at best, and `scripts/gavin-mcp` prints its reason to stderr, which agent UIs hide. Context: report §1 in `docs/research/2026-10-22-curva-di-apprendimento.md`.

The signal exists: the daemon records a session's gavin-mcp Hello in `note_agent_ready` (`crates/daemon/src/server.rs:492-506`), today only to time prompt delivery. `gavin-mcp` builds a `ConnectDiagnosis` (`crates/gavin-mcp/src/main.rs:109-155`) that only reaches its own log.

Do:
- Mark an agent session as "no gavin tools" when it has had no Hello within a grace period after launch (pick it from `AGENT_SETTLE` and the existing fallback timing; justify the number in a comment). Only for sessions launched as agents, never plain shells. Carry it to the app over the existing session status path, gated in `daemonCompat.ts` with a `featureBlockedReason` consumer (CLAUDE.md, "The compat gate is per request TYPE").
- Show it on the tab and the sidebar row. On click, show the last gavin-mcp log line for that session if one exists, and a "Repair integration" action that runs `setup_agent_integration` (`app/src-tauri/src/agent_setup.rs:3391`) for the workspace's profile.
- Make `scripts/gavin-mcp` and `scripts/gavin-mcp.cmd` also append their "no binary found" message to the gavin-mcp log the app reads, keeping stdout clean.

Logic in a plain `.ts` module with unit tests; the `.svelte` stays a thin template. Done when `cargo test --workspace` and `cd app && npm test && npm run check` are green, with a daemon test that a session with no Hello is flagged and one with a Hello is not. Verify under a temp `$HOME`; never restart the shared daemon.
