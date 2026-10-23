---
kind: task
title: Desktop demo workspace and overloaded names
parent: learning-curve.md
status: To Do
priority: medium
complexity: complex
labels: ready-for-human
---
A new user meets about 75 concepts and 13 views per workspace (`app/src/lib/hub/hubViewMeta.ts:20-65`), and some names cover several things: "Review" six (Review tab, Manual review steps that show on Decisions, first-Run review, code review, critical review, a wizard step), "Memory" three (memory cards, the search index wizard step, the RAM wall), "Hub" three (`CONTEXT.md:79` has to warn). "Waiting on you" shows in at least six places. The Companion has a Demo Workstation; the desktop has no sample workspace. Context: report §3.

Product decisions for the owner, one `Decision:` each, before any code:
- Rename the Review tab and the "Memory" wizard step? Proposed: "Results" and "Memory search".
- Fold the waiting-on-you surfaces into one list with filters, or keep Decisions and the attention inbox apart as `decisions.ts:4-15` intends?
- Ship a desktop demo workspace: one card of each kind, a nested task, a two-stage rail, one open decision and one human test, created in a temp folder and deletable in one click?

Once decided, the renames go through `CONTEXT.md` first (it is the glossary the code follows), then the UI copy.
