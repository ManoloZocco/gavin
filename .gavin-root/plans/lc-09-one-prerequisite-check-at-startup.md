---
kind: task
title: One prerequisite check at startup
parent: learning-curve.md
status: To Do
priority: medium
complexity: moderate
labels: ready-for-agent
---
Prerequisites surface one at a time and late: Node only inside the Playwright step (`app/src-tauri/src/agent_playwright.rs`), uv only inside Headroom (`app/src/lib/agents/headroomSetup.ts`), Git for Windows only when a session fails to spawn because the daemon falls back to a bare `sh.exe` (`crates/daemon/src/shell.rs:40`). Agent CLIs count as "found" from a PATH sweep that never runs them (`detect_agent_binaries`, `app/src-tauri/src/agent_setup.rs:4265`), and the wizard then makes one the primary agent without asking. Context: report §5.

Do:
- One preflight at app start, reusing the step detectors and the shell discovery, shown as a single panel in Settings and as a Home notice only when something a configured feature needs is missing. No new installs: each line says what is missing and links to the step or command that fixes it.
- Probe each detected agent CLI with a cheap, non-interactive, offline-safe call (its `--version`) with a short timeout, off the main thread (CLAUDE.md and the `perf-main-thread-*` cards: no blocking calls on the main thread). Keep "found but not runnable" distinct from "not found", and do not auto-pick an unrunnable CLI as primary.

Done when the touched suites are green. File a `Human test:` for the Windows case (Git for Windows absent) since no suite reaches it.
