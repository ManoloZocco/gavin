---
kind: task
title: Propose worktree setup from lockfiles
parent: learning-curve.md
status: To Do
priority: medium
complexity: moderate
labels: ready-for-agent
---
`[worktree] setup` has no editor: it is hand-written in `.gavin-root/config.toml` and stays off until a human approves it through the trust hash (`app/src/lib/workspace/workspaceTrust.ts`). Most workspaces therefore cut worktrees with no install step, and every parallel agent starts in a tree that does not build. Context: report §2 and §7.

Do:
- Detect install commands from what the repo holds (at least `package-lock.json`/`npm ci`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`/`cargo fetch`, `uv.lock`/`uv sync`, `poetry.lock`; nested packages such as `app/` included). Pure module, table-driven tests.
- Write the proposal into `[worktree] setup` only when the key is absent, and let the existing trust gate hold it off. Tell the human in the Settings worktree section and as a `Decision:` on the workspace's setup, with Approve / Edit / Discard.
- Add a minimal editor for `[worktree] setup` in the workspace Settings, so approving is not a hand-edit.

Never run a proposed command before approval. Done when the touched suites are green.
