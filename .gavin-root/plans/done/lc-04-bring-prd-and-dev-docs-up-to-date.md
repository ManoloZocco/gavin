---
kind: task
title: Bring the PRD and dev docs up to date
parent: learning-curve.md
status: Done
priority: high
complexity: trivial
labels: ready-for-agent
---
The docs a newcomer reads first disagree with the code. Context: report §6.

- `.gavin-root/PRD.md` says `PROTOCOL_VERSION` (41); the code is at 78 (`crates/protocol/src/lib.rs:1027`). Current focus #1 asks for machine-independent MCP configs and a gavin-mcp self re-exec: both shipped (`scripts/gavin-mcp`, `crates/gavin-mcp/src/main.rs:229-255`, archived card `gavin-mcp-self-reexec-when-daemon-newer.md`). Item 5 says "no transport exists yet" for the Companion, which the README contradicts.
- `docs/dev-setup.md:130-134` says there is no production sidecar bundling; `app/src-tauri/tauri.bundle.conf.json:4` bundles gavin-daemon, gavin-mcp and gavin-relay.

Fix the facts in place. Do NOT rewrite the Current focus priorities: for each stale item, file a `gavin_request_human(card, "decision", …)` on this card asking whether to drop it or what replaces it, with options. Check every other number and version the PRD and README state against the code while you are there and list what you changed in the commit body.

## Comments

2026-10-23: Done: PROTOCOL_VERSION is no longer repeated in the PRD, Current focus items 1 and 5 carry a dated status line, dev-setup.md describes the bundled sidecars. Whether to drop those two focus items is the owner's call, asked in chat.
