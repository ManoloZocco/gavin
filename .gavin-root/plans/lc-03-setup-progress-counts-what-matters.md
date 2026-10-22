---
kind: task
title: Setup progress counts what matters
parent: learning-curve.md
status: To Do
priority: high
complexity: simple
labels: ready-for-agent
---
Two small lies in the setup wizard. Context: report §1 and §5.

1. The Home banner reads "{done} of {SETUP_STEPS.length} done" (`app/src/lib/hub/HomeHubView.svelte:401`), but `configured` ignores launch, git, review, headroom and memory (`app/src/lib/workspace/setupWizard.ts:260-268`). "5 of 10" can mean nothing is left. Count only the steps that gate `configured`, and name the missing ones.
2. The Integration step is done as soon as the agent file holds `<!-- gavin:start -->` (`setupWizard.ts:205`). Make it done only when the profile's MCP config has the gavin entry AND its command resolves to an executable (the absolute binary, or `scripts/gavin-mcp` with a binary it can find). Reuse the entry check in `agent_setup.rs` (the one `workspace_delete.rs:325` calls) and add the executable check; for an ssh workspace the check must go through `WorkspaceFiles`, never the local disk. When the entry exists but the command is dead, the step says so and its button repairs it.

Done when `cd app && npm test && npm run check` and the touched Rust tests are green, with tests for: entry present + dead command → not done; entry present + live command → done.
