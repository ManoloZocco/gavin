// The card linter: the card rules that act without a word, named.
//
// Several of the board's rules are silent by construction. A status that
// matches no column conjures an auto column; a `parent:` that resolves to
// a task, to the card itself or to another context draws a broken chip
// that used to say "file not found" whatever the reason; the daemon files
// a card into `plans/done/` only when its status slugs to `done` while the
// rails call the RIGHTMOST column done; open `Decision:` / `Human test:`
// items on a Done card drop off both tabs (`decisions.cardFinished`).
// Nothing is wrong with any one rule. What hurts is that a human or an
// agent who trips one is told nothing, or told the wrong thing.
//
// This module reads the tree and the board the app already has and says,
// per card, which field is wrong, why, and what would fix it. Every
// finding is one of two kinds of fix (report 2026-10-22 §7):
//
//   safe    reversible, local, and changes nothing the board SHOWS: a
//           status respelled to its column's own name, a file re-filed
//           to the folder its status already puts it in on the board.
//           Returned as a field write the daemon's own `set_plan_field`
//           applies -- a status write re-files the card as a side effect
//           (`relocate_for_status`), so re-writing the status IS the move.
//   decide  the human's call, with the options a person would weigh.
//
// Nothing here applies anything. `safeFixes` hands the writes out; the
// app or the orchestrator applies them and leaves the dated line.
//
// WIRE SHAPE, for the daemon/MCP side (`gavin_get_tree`'s per-card
// warnings, lc-02) to mirror field for field. Every value is plain JSON:
//
//   LintFinding {
//     code:          LintCode            -- kebab-case, stable, see below
//     path:          string | null       -- card file (wire spelling); null
//                                           for a board-scoped finding
//     contextFolder: string | null       -- null for a board-scoped finding
//     fileName:      string | null       -- null for a board-scoped finding
//     columnId?:     string              -- board-scoped findings only
//     field:         string              -- the frontmatter key ("status",
//                                           "parent", "labels"), or "file"
//                                           (its folder or name), "body",
//                                           "checklist", "column"
//     message:       string              -- one sentence naming the field
//                                           and the reason
//     fix: { kind: "safe", write: { path, key, value }, summary: string }
//        | { kind: "decide", options: string[] }
//   }
//
// Rules a daemon-side linter must add that this one CANNOT see: the
// daemon drops `parent:` and `direct:` on a card that is not a task, and
// an unreadable kind / priority / order / complexity, before the tree is
// sent -- all that reaches the app is `parseWarning: true`. Those findings
// need the raw frontmatter, so they belong to the Rust side
// (`plan_file_info`), which should name them with the codes
// "parent-on-non-task", "direct-on-non-task" and "bad-<field>".

import type { Board, Column } from "$lib/board/kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "$lib/core/gavin";
import { isArchivedCard, planKey, slugStatus } from "$lib/core/planBoard";
import { cardFinished, pendingItems, type DecisionCard } from "$lib/decisions/decisions";
import { doneColumnOf, planIndex } from "$lib/orchestration/orchestration";
import { stripFrontmatter } from "$lib/cards/planChecklist";
import { MEMORY_LABEL } from "$lib/cards/memoryCard";

export type LintCode =
  | "status-unknown"
  | "status-spelling"
  | "parent-missing"
  | "parent-self"
  | "parent-not-plan"
  | "parent-other-context"
  | "done-outside-done-folder"
  | "done-folder-not-done"
  | "column-right-of-done"
  | "human-items-on-done"
  | "label-unknown"
  | "direct-empty-body"
  | "duplicate-file-name";

/// One frontmatter write, in exactly the shape `set_plan_field` takes.
export interface FieldWrite {
  path: string;
  key: string;
  value: string;
}

export type LintFix =
  | {
      kind: "safe";
      write: FieldWrite;
      /// What the write changes, for the dated `## Comments` line whoever
      /// applies it leaves behind.
      summary: string;
    }
  | { kind: "decide"; options: string[] };

export interface LintFinding {
  code: LintCode;
  path: string | null;
  contextFolder: string | null;
  fileName: string | null;
  /// Board-scoped findings only: the column the finding is about.
  columnId?: string;
  field: string;
  message: string;
  fix: LintFix;
}

export interface LintInput {
  tree: GavinTree | undefined;
  board: Board | undefined;
  /// Raw file contents by card path, for the one rule that reads a body.
  /// The tree carries no bodies, so the board lints without this and the
  /// card detail modal, which has read the file, adds that rule on top
  /// (`findingsForCard`).
  contents?: ReadonlyMap<string, string>;
}

/// The sentence a card's ⚠ adds when the daemon flagged its frontmatter
/// but no finding here explains it. Lists what the daemon degrades
/// silently, so the reader knows where to look until the daemon names the
/// field itself.
export const PARSE_WARNING_TEXT =
  "Some frontmatter could not be read: a kind, priority, order or complexity value gavin does " +
  "not know, or parent:/direct: on a card that is not a task.";

// --- small pure helpers ---------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// A context's `plans/` folder: the one whose parent is a `.gavin` or
// `.gavin-root` marker, exactly the daemon's `is_plans_dir`.
const PLANS_DIR_RE = /\/\.gavin(?:-root)?\/plans$/;

/// Where a card file sits among the three locations the daemon's filing
/// rules own (`governed_plans_root`), with that `plans/` root. "other" is
/// a hand-made subfolder the daemon never moves anything out of, so no
/// folder rule applies to it.
type Filing = { at: "plans" | "done" | "archive"; plansRoot: string } | { at: "other" };

function filingOf(path: string): Filing {
  const dir = dirOf(path);
  if (PLANS_DIR_RE.test(dir)) return { at: "plans", plansRoot: dir };
  const up = dirOf(dir);
  if (PLANS_DIR_RE.test(up)) {
    const leaf = baseOf(dir);
    if (leaf === "done") return { at: "done", plansRoot: up };
    if (leaf === "archive") return { at: "archive", plansRoot: up };
  }
  return { at: "other" };
}

/// The daemon's `nested_under`: a task with a parent and no status of its
/// own lives wherever its parent lives, so its own folder is not a fact
/// about its status.
function nestedByFrontmatter(plan: PlanFileInfo): boolean {
  return plan.kind === "task" && plan.parent !== null && plan.status === null;
}

function isDone(status: string | null): boolean {
  return status !== null && slugStatus(status) === "done";
}

/// Plain Levenshtein distance, for "the nearest column / label / plan".
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/// Up to `max` names nearest to `want`, compared by slug so spacing and
/// case cost nothing. Ties keep the input order, which for columns is the
/// board's left-to-right order.
export function nearestNames(want: string, names: readonly string[], max = 3): string[] {
  const target = slugStatus(want);
  return names
    .map((name, i) => ({ name, i, d: editDistance(target, slugStatus(name)) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, max)
    .map((x) => x.name);
}

function sortedColumns(columns: readonly Column[]): Column[] {
  return [...columns].sort((a, b) => a.position - b.position);
}

/// The status a card ought to carry: its column's own spelling when its
/// status already lands in one, else the status as written. The folder
/// rules write THIS, so a card that is both misspelt and misfiled gets
/// one write that answers both findings rather than two that disagree.
function canonicalStatus(status: string, columns: readonly Column[]): string {
  const slug = slugStatus(status);
  return columns.find((c) => slugStatus(c.name) === slug)?.name ?? status;
}

function cardFinding(
  plan: PlanFileInfo,
  ctx: GavinContext,
  code: LintCode,
  field: string,
  message: string,
  fix: LintFix
): LintFinding {
  return { code, path: plan.path, contextFolder: ctx.folderPath, fileName: plan.fileName, field, message, fix };
}

function decide(...options: string[]): LintFix {
  return { kind: "decide", options };
}

// --- the rules --------------------------------------------------------------

/// A status that lands in no column, or in one only by the board's slug
/// match. Archived cards are off the board, so what column their status
/// would name is moot; nested children have no status of their own.
function lintStatus(plan: PlanFileInfo, ctx: GavinContext, columns: readonly Column[]): LintFinding[] {
  if (plan.status === null || columns.length === 0 || isArchivedCard(plan.path)) return [];
  const slug = slugStatus(plan.status);
  // An empty slug ("—") is no status at all: the board files it in the
  // first column, which is the same answer as leaving the line out.
  if (!slug) return [];
  const column = columns.find((c) => slugStatus(c.name) === slug);
  if (column) {
    if (column.name === plan.status) return [];
    return [
      cardFinding(
        plan,
        ctx,
        "status-spelling",
        "status",
        `status: "${plan.status}" is the "${column.name}" column spelt another way.`,
        {
          kind: "safe",
          write: { path: plan.path, key: "status", value: column.name },
          summary: `status "${plan.status}" respelled "${column.name}", the column's own name`,
        }
      ),
    ];
  }
  const names = sortedColumns(columns).map((c) => c.name);
  const nearest = nearestNames(plan.status, names);
  return [
    cardFinding(
      plan,
      ctx,
      "status-unknown",
      "status",
      `status: "${plan.status}" matches no column, so the board shows it in a column of its own. ` +
        `Nearest: ${nearest.join(", ")}.`,
      decide(...nearest.map((n) => `Set status to "${n}"`), `Keep "${plan.status}" as a new column`)
    ),
  ];
}

/// Why a task's `parent:` does not nest it -- exactly the board's test
/// (`mergePlanCards`: no plan of that file name in the same context, or
/// the card itself), with the reason the board's chip used to collapse
/// into "file not found".
function lintParent(
  plan: PlanFileInfo,
  ctx: GavinContext,
  plans: ReadonlyMap<string, DecisionCard>,
  byName: ReadonlyMap<string, Array<{ plan: PlanFileInfo; ctx: GavinContext }>>
): LintFinding[] {
  if (plan.kind !== "task" || !plan.parent) return [];
  const parent = plan.parent;
  if (parent === plan.fileName) {
    return [
      cardFinding(
        plan,
        ctx,
        "parent-self",
        "parent",
        `parent: ${parent} is this card itself, so it nests under nothing.`,
        decide("Clear parent:")
      ),
    ];
  }
  if (plans.has(planKey(ctx.folderPath, parent))) return [];
  const same = (byName.get(parent) ?? []).filter((e) => e.ctx.folderPath === ctx.folderPath);
  if (same.length > 0) {
    const kind = same[0].plan.kind;
    return [
      cardFinding(
        plan,
        ctx,
        "parent-not-plan",
        "parent",
        `parent: ${parent} is a ${kind}, not a plan — only a plan can hold tasks.`,
        decide(`Make ${parent} a plan (kind: plan)`, "Clear parent:")
      ),
    ];
  }
  const elsewhere = (byName.get(parent) ?? []).filter((e) => e.ctx.folderPath !== ctx.folderPath);
  if (elsewhere.length > 0) {
    const other = (elsewhere.find((e) => e.plan.kind === "plan") ?? elsewhere[0]).ctx;
    return [
      cardFinding(
        plan,
        ctx,
        "parent-other-context",
        "parent",
        `parent: ${parent} lives in the "${other.name}" context; a parent must be in this card's own context.`,
        decide(`Move this card into "${other.name}"`, "Clear parent:")
      ),
    ];
  }
  // A hand-typed `parent: foo` or `parent: ./plans/foo.md` names a real
  // plan in a spelling the daemon never resolves. Offer the spelling it
  // does, without applying it: re-nesting moves the card on the board.
  const options: string[] = [];
  const bare = baseOf(parent);
  const respelt = bare.endsWith(".md") ? bare : `${bare}.md`;
  if (respelt !== parent && plans.has(planKey(ctx.folderPath, respelt))) options.push(`Set parent: to ${respelt}`);
  options.push("Clear parent:");
  return [
    cardFinding(
      plan,
      ctx,
      "parent-missing",
      "parent",
      `parent: ${parent} — no card of that name in this context.`,
      decide(...options)
    ),
  ];
}

/// Status and folder out of step. The daemon files a card when its status
/// is WRITTEN (`relocate_for_status`), so a status set by hand, or a file
/// moved by hand, leaves the two disagreeing until the next write. The
/// board always follows the status, so re-writing the status re-files the
/// card without changing anything the board shows -- the safe fix -- as
/// long as nothing of that name already sits where it would go, which
/// the daemon would skip with only a log line (`move_card`).
function lintFolder(
  plan: PlanFileInfo,
  ctx: GavinContext,
  paths: ReadonlySet<string>,
  columns: readonly Column[]
): LintFinding[] {
  if (nestedByFrontmatter(plan)) return [];
  const filing = filingOf(plan.path);
  if (filing.at === "plans" && isDone(plan.status)) {
    const dest = `${filing.plansRoot}/done/${plan.fileName}`;
    if (paths.has(dest)) {
      return [
        cardFinding(
          plan,
          ctx,
          "done-outside-done-folder",
          "file",
          `status: ${plan.status} but the file is not in plans/done/: a card named ${plan.fileName} ` +
            "is already there, so the daemon cannot move it.",
          decide("Rename this card", `Rename the one in plans/done/`)
        ),
      ];
    }
    const value = canonicalStatus(plan.status as string, columns);
    return [
      cardFinding(
        plan,
        ctx,
        "done-outside-done-folder",
        "file",
        `status: ${plan.status} but the file is not in plans/done/.`,
        {
          kind: "safe",
          write: { path: plan.path, key: "status", value },
          summary: "moved into plans/done/ to match its Done status",
        }
      ),
    ];
  }
  if (filing.at === "done" && !isDone(plan.status)) {
    if (plan.status === null) {
      // The folder says Done and the status says nothing: the board puts
      // it in the first column, but whoever moved it into done/ meant
      // something else. Which one was right is a person's call.
      return [
        cardFinding(
          plan,
          ctx,
          "done-folder-not-done",
          "file",
          "The file is in plans/done/ but the card has no status, so the board shows it as not started.",
          decide("Set status to Done", "Move it back out of plans/done/")
        ),
      ];
    }
    const dest = `${filing.plansRoot}/${plan.fileName}`;
    if (paths.has(dest)) {
      return [
        cardFinding(
          plan,
          ctx,
          "done-folder-not-done",
          "file",
          `status: ${plan.status} but the file is in plans/done/, and a card named ${plan.fileName} ` +
            "already sits in plans/, so the daemon cannot move it back.",
          decide("Set status to Done", "Rename this card")
        ),
      ];
    }
    const value = canonicalStatus(plan.status, columns);
    return [
      cardFinding(
        plan,
        ctx,
        "done-folder-not-done",
        "file",
        `status: ${plan.status} but the file is in plans/done/.`,
        {
          kind: "safe",
          write: { path: plan.path, key: "status", value },
          summary: `moved out of plans/done/ to match its ${value} status`,
        }
      ),
    ];
  }
  return [];
}

/// Open items on a card whose work is closed. `cardFinished` is the rule
/// both tabs drop such a card by, used here rather than restated so the
/// warning fires on exactly the cards whose items have gone missing.
/// Archived cards are left alone: archiving is itself the explicit act
/// that closes a card's record, unticked boxes and all.
function lintHumanItems(
  plan: PlanFileInfo,
  ctx: GavinContext,
  planEntries: ReadonlyMap<string, DecisionCard>,
  doneStatus: string | null
): LintFinding[] {
  // Absent means an older daemon that never parsed the items: unknown,
  // never "none" (gavin.ts), so no claim either way.
  if (!plan.humanItems || isArchivedCard(plan.path)) return [];
  if (!cardFinished({ plan, contextFolder: ctx.folderPath }, planEntries, doneStatus)) return [];
  const open = pendingItems(plan);
  if (open.length === 0) return [];
  const decisions = open.filter((i) => i.kind === "decision").length;
  const tests = open.length - decisions;
  const parts = [
    decisions > 0 ? `${decisions} open Decision: ${decisions === 1 ? "item" : "items"}` : null,
    tests > 0 ? `${tests} open Human test: ${tests === 1 ? "item" : "items"}` : null,
  ].filter((p): p is string => p !== null);
  return [
    cardFinding(
      plan,
      ctx,
      "human-items-on-done",
      "checklist",
      `${parts.join(" and ")} on a Done card — neither the Decisions nor the Review tab lists them.`,
      decide("Re-open the card", "Close the items with a dated line")
    ),
  ];
}

/// Labels outside the board's vocabulary. A board that has never defined
/// a label has no vocabulary to be outside of, so every card would warn
/// for nothing; and `memory` is gavin's own label (memoryCard.ts), which
/// means something whether or not the board lists it.
function lintLabels(plan: PlanFileInfo, ctx: GavinContext, vocabulary: readonly string[]): LintFinding[] {
  if (vocabulary.length === 0 || isArchivedCard(plan.path)) return [];
  const known = new Set(vocabulary.map(slugStatus));
  const out: LintFinding[] = [];
  const seen = new Set<string>();
  for (const label of plan.labels) {
    const slug = slugStatus(label);
    if (!slug || known.has(slug) || slug === MEMORY_LABEL || seen.has(slug)) continue;
    seen.add(slug);
    const near = nearestNames(label, vocabulary, 1).filter((n) => editDistance(slug, slugStatus(n)) <= 2);
    out.push(
      cardFinding(
        plan,
        ctx,
        "label-unknown",
        "labels",
        `labels: "${label}" is not one of the board's labels, so it has no colour and no filter matches it.`,
        decide(
          ...near.map((n) => `Rename it to "${n}"`),
          `Add "${label}" to the board's labels`,
          `Remove "${label}" from this card`
        )
      )
    );
  }
  return out;
}

/// A direct task sends its body as the whole prompt, so an empty one
/// sends nothing -- the launch refuses with `EMPTY_DIRECT_PROMPT`, but
/// only when somebody presses Run.
export function lintDirectBody(
  card: { id: string; kind: string; direct?: boolean; contextFolder: string; fileName: string },
  content: string | null | undefined
): LintFinding | null {
  if (card.kind !== "task" || card.direct !== true || content === null || content === undefined) return null;
  if (isArchivedCard(card.id)) return null;
  if (stripFrontmatter(content).trim() !== "") return null;
  return {
    code: "direct-empty-body",
    path: card.id,
    contextFolder: card.contextFolder,
    fileName: card.fileName,
    field: "body",
    message: "direct: true sends the body as the whole prompt, and the body is empty.",
    fix: decide("Write the prompt in the body", "Turn off direct:"),
  };
}

/// Two cards of one name in one context. `parent:` resolves on (context,
/// file name) and the daemon's moves look a name up across the whole
/// `plans/` tree, so only one of them is ever the one a link or a move
/// finds. Archived cards count: the daemon's lookup walks `archive/` too.
function lintDuplicates(ctx: GavinContext): LintFinding[] {
  const groups = new Map<string, PlanFileInfo[]>();
  for (const plan of ctx.plans) {
    const group = groups.get(plan.fileName) ?? [];
    group.push(plan);
    groups.set(plan.fileName, group);
  }
  const out: LintFinding[] = [];
  const rel = (p: string): string =>
    p.startsWith(`${ctx.folderPath}/`) ? p.slice(ctx.folderPath.length + 1) : p;
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    for (const plan of group) {
      const others = group.filter((p) => p.path !== plan.path).map((p) => rel(p.path));
      out.push(
        cardFinding(
          plan,
          ctx,
          "duplicate-file-name",
          "file",
          `Another card in this context is also named ${name} (${others.join(", ")}); parent: links ` +
            "and moves into plans/done/ find only one of them.",
          decide("Rename this card", "Rename the other card")
        )
      );
    }
  }
  return out;
}

/// Columns placed right of Done. The rails and the Decisions tab call the
/// RIGHTMOST column done (`doneColumnOf`), while the daemon files only a
/// status that slugs to `done` into `plans/done/`: a "Shipped" after Done
/// splits the two, and a card in either column is finished by one rule
/// and unfinished by the other.
function lintColumns(columns: readonly Column[]): LintFinding[] {
  const done = columns.find((c) => slugStatus(c.name) === "done");
  if (!done) return [];
  return sortedColumns(columns)
    .filter((c) => c.position > done.position)
    .map((c) => ({
      code: "column-right-of-done" as const,
      path: null,
      contextFolder: null,
      fileName: null,
      columnId: c.id,
      field: "column",
      message:
        `"${c.name}" sits right of ${done.name}: rails treat "${c.name}" as done, but only ` +
        `${done.name} files a card into plans/done/.`,
      fix: decide(`Move "${c.name}" left of ${done.name}`, `Keep "${c.name}" as the done column for rails`),
    }));
}

// --- entry points -----------------------------------------------------------

/// Every finding for one workspace, cards in (context, path) order then
/// the board's own. Empty for a tree that has not loaded or whose root is
/// missing, and the board rules are skipped without a board: no claim
/// about a vocabulary nobody has read.
export function lintCards(input: LintInput): LintFinding[] {
  const { tree, board } = input;
  if (!tree || tree.rootMissing) return board ? lintColumns(board.columns) : [];
  const columns = board?.columns ?? [];
  const vocabulary = (board?.labels ?? []).map((l) => l.name);
  const doneStatus = doneColumnOf(columns)?.name ?? null;

  const byName = new Map<string, Array<{ plan: PlanFileInfo; ctx: GavinContext }>>();
  const cards = new Map<string, DecisionCard>();
  for (const ctx of tree.contexts) {
    for (const plan of ctx.plans) {
      const named = byName.get(plan.fileName) ?? [];
      named.push({ plan, ctx });
      byName.set(plan.fileName, named);
      cards.set(plan.path, { plan, contextFolder: ctx.folderPath });
    }
  }
  // The decisions module's own index, so `cardFinished` resolves a nested
  // task's parent exactly as both tabs do.
  const planEntries = planIndex(cards);

  const out: LintFinding[] = [];
  const contexts = [...tree.contexts].sort((a, b) => a.folderPath.localeCompare(b.folderPath));
  for (const ctx of contexts) {
    const paths = new Set(ctx.plans.map((p) => p.path));
    const duplicates = lintDuplicates(ctx);
    const ordered = [...ctx.plans].sort((a, b) => a.path.localeCompare(b.path));
    for (const plan of ordered) {
      out.push(
        ...lintStatus(plan, ctx, columns),
        ...lintParent(plan, ctx, planEntries, byName),
        // Needs no board: the daemon's Done is a slug, not a column.
        ...lintFolder(plan, ctx, paths, columns),
        ...lintHumanItems(plan, ctx, planEntries, doneStatus),
        ...(board ? lintLabels(plan, ctx, vocabulary) : []),
        ...duplicates.filter((f) => f.path === plan.path)
      );
      const content = input.contents?.get(plan.path);
      const body = lintDirectBody(
        { id: plan.path, kind: plan.kind, direct: plan.direct, contextFolder: ctx.folderPath, fileName: plan.fileName },
        content
      );
      if (body) out.push(body);
    }
  }
  if (board) out.push(...lintColumns(board.columns));
  return out;
}

/// The safe fixes as field writes, one per (card, key): two findings on
/// one card can propose the same status write (misspelt AND misfiled),
/// and sending it twice would re-file the card twice and log two lines
/// for one change. The first finding's write wins; `canonicalStatus`
/// makes them agree anyway.
export function safeFixes(findings: readonly LintFinding[]): FieldWrite[] {
  const seen = new Set<string>();
  const out: FieldWrite[] = [];
  for (const f of findings) {
    if (f.fix.kind !== "safe") continue;
    const key = `${f.fix.write.path}\u0000${f.fix.write.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...f.fix.write });
  }
  return out;
}

/// The findings grouped the way surfaces look them up: by card path, and
/// by column id for the board's own.
export interface LintIndex {
  byPath: Map<string, LintFinding[]>;
  byColumn: Map<string, LintFinding[]>;
}

export function lintIndex(findings: readonly LintFinding[]): LintIndex {
  const byPath = new Map<string, LintFinding[]>();
  const byColumn = new Map<string, LintFinding[]>();
  for (const f of findings) {
    const [map, key] = f.path !== null ? [byPath, f.path] : [byColumn, f.columnId ?? ""];
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return { byPath, byColumn };
}

/// One card's findings for a surface that has read its file: the
/// workspace's findings for that path, plus the body rule the tree cannot
/// answer.
export function findingsForCard(
  index: LintIndex | undefined,
  card: { id: string; kind: string; direct?: boolean; contextFolder: string; fileName: string },
  content?: string | null
): LintFinding[] {
  const listed = index?.byPath.get(card.id) ?? [];
  const body = listed.some((f) => f.code === "direct-empty-body") ? null : lintDirectBody(card, content);
  return body ? [...listed, body] : listed;
}

/// The ⚠ chip's tooltip: every finding, one per line, and the daemon's
/// bare parse warning when it is set. Null when there is nothing to say,
/// which is what hides the chip.
export function cardWarningText(findings: readonly LintFinding[], parseWarning: boolean): string | null {
  const lines = findings.map((f) => f.message);
  if (parseWarning) lines.push(PARSE_WARNING_TEXT);
  return lines.length > 0 ? lines.join("\n") : null;
}

const PARENT_CODES: ReadonlySet<LintCode> = new Set([
  "parent-missing",
  "parent-self",
  "parent-not-plan",
  "parent-other-context",
]);

const PARENT_SHORT: Record<string, string> = {
  "parent-missing": "not found",
  "parent-self": "is this card",
  "parent-not-plan": "not a plan",
  "parent-other-context": "in another context",
};

/// Why this card's parent chip is broken, as the board's tooltip says it.
/// Falls back to the old wording only for a broken chip the linter has
/// no finding for -- which happens while the board has not loaded.
export function parentBrokenText(parent: string | null, findings: readonly LintFinding[]): string {
  const f = findings.find((x) => PARENT_CODES.has(x.code));
  return f ? f.message : `parent: ${parent} — not found in this context`;
}

/// The same reason in two or three words, for the detail modal's "Part
/// of" line where the whole sentence does not fit.
export function parentBrokenShort(findings: readonly LintFinding[]): string {
  const f = findings.find((x) => PARENT_CODES.has(x.code));
  return f ? PARENT_SHORT[f.code] : "not found";
}
