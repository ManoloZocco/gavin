import { describe, it, expect } from "vitest";
import {
  cardWarningText,
  editDistance,
  findingsForCard,
  lintCards,
  lintDirectBody,
  lintIndex,
  nearestNames,
  parentBrokenShort,
  parentBrokenText,
  PARSE_WARNING_TEXT,
  safeFixes,
  type LintFinding,
} from "$lib/board/cardLint";
import type { Board, Column, Label } from "$lib/board/kanban";
import type { GavinContext, GavinTree, HumanItem, PlanFileInfo } from "$lib/core/gavin";

const ROOT = "/ws";
const PLANS = `${ROOT}/.gavin-root/plans`;
const AUTH = "/ws/auth";
const AUTH_PLANS = `${AUTH}/.gavin/plans`;

function col(id: string, name: string, position: number): Column {
  return { id, name, position };
}

const COLUMNS = [col("c1", "To Do", 0), col("c2", "In Progress", 1), col("c3", "Done", 2)];

function board(columns: Column[] = COLUMNS, labels: Label[] = []): Board {
  return { columns, labels, cardSessions: [] };
}

function label(name: string): Label {
  return { id: `l-${name}`, name, color: "#888" };
}

/// A card at `rel` under `plansDir` -- `done/x.md` lands in plans/done/.
function card(rel: string, status: string | null, overrides: Partial<PlanFileInfo> = {}, plansDir = PLANS): PlanFileInfo {
  const fileName = rel.slice(rel.lastIndexOf("/") + 1);
  return {
    path: `${plansDir}/${rel}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status,
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...overrides,
  };
}

function ctx(folderPath: string, name: string, plans: PlanFileInfo[], kind: "root" | "context" = "context"): GavinContext {
  return { folderPath, kind, name, plans, docs: [], specs: [], hasPrd: false, configWarning: false };
}

function tree(...contexts: GavinContext[]): GavinTree {
  return { rootPath: ROOT, rootMissing: false, contexts };
}

function root(...plans: PlanFileInfo[]): GavinTree {
  return tree(ctx(ROOT, "root", plans, "root"));
}

function item(kind: HumanItem["kind"], text: string, overrides: Partial<HumanItem> = {}): HumanItem {
  return {
    kind,
    text,
    done: false,
    options: [],
    latest: null,
    state: "open",
    lineText: `${kind === "decision" ? "Decision" : "Human test"}: ${text}`,
    lineIndex: 10,
    ...overrides,
  };
}

function codes(findings: readonly LintFinding[]): string[] {
  return findings.map((f) => f.code);
}

function only(findings: readonly LintFinding[], code: string): LintFinding[] {
  return findings.filter((f) => f.code === code);
}

describe("editDistance / nearestNames", () => {
  it("counts single-character edits", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("done", "dnoe")).toBe(2);
  });

  it("ranks by slug distance and keeps input order on ties", () => {
    expect(nearestNames("in progres", ["To Do", "In Progress", "Done"], 1)).toEqual(["In Progress"]);
    expect(nearestNames("SHIPED", ["Done", "Shipped"])).toEqual(["Shipped", "Done"]);
    expect(nearestNames("ab", ["ax", "xb"])).toEqual(["ax", "xb"]);
    expect(nearestNames("ab", ["xb", "ax"])).toEqual(["xb", "ax"]);
    expect(nearestNames("xx", ["ab", "cd"], 1)).toEqual(["ab"]);
  });
});

describe("status matching no column", () => {
  it("is a decision offering the nearest columns and keeping it as a new one", () => {
    const findings = lintCards({ tree: root(card("a.md", "In Progres")), board: board() });
    expect(codes(findings)).toEqual(["status-unknown"]);
    const [f] = findings;
    expect(f.field).toBe("status");
    expect(f.path).toBe(`${PLANS}/a.md`);
    expect(f.message).toContain('status: "In Progres" matches no column');
    expect(f.message).toContain("Nearest: In Progress");
    expect(f.fix).toEqual({
      kind: "decide",
      options: ['Set status to "In Progress"', 'Set status to "To Do"', 'Set status to "Done"', 'Keep "In Progres" as a new column'],
    });
  });

  it("lists the nearest columns in board order on a tie, not array order", () => {
    const shuffled = [col("c3", "Done", 2), col("c1", "To Do", 0), col("c2", "In Progress", 1)];
    const [f] = lintCards({ tree: root(card("a.md", "zzzzzzzzzzzz")), board: board(shuffled) });
    expect(f.fix).toEqual({
      kind: "decide",
      options: ['Set status to "To Do"', 'Set status to "In Progress"', 'Set status to "Done"', 'Keep "zzzzzzzzzzzz" as a new column'],
    });
  });

  it("is silent for no status, an empty slug, an archived card, and a board not yet loaded", () => {
    expect(lintCards({ tree: root(card("a.md", null)), board: board() })).toEqual([]);
    expect(lintCards({ tree: root(card("a.md", "—")), board: board() })).toEqual([]);
    expect(lintCards({ tree: root(card("archive/a.md", "Shipped")), board: board() })).toEqual([]);
    expect(lintCards({ tree: root(card("a.md", "Shipped")), board: undefined })).toEqual([]);
    expect(lintCards({ tree: root(card("a.md", "Shipped")), board: board([]) })).toEqual([]);
  });
});

describe("status differing from a column only by case or spacing", () => {
  it("is a safe write of the column's own name", () => {
    const findings = lintCards({ tree: root(card("a.md", " in  progress ")), board: board() });
    expect(codes(findings)).toEqual(["status-spelling"]);
    expect(findings[0].fix).toEqual({
      kind: "safe",
      write: { path: `${PLANS}/a.md`, key: "status", value: "In Progress" },
      summary: 'status " in  progress " respelled "In Progress", the column\'s own name',
    });
  });

  it("catches separators the board's slug match also forgives", () => {
    const findings = lintCards({ tree: root(card("a.md", "in_progress")), board: board() });
    expect(safeFixes(findings)).toEqual([{ path: `${PLANS}/a.md`, key: "status", value: "In Progress" }]);
  });

  it("is silent for an exact spelling", () => {
    expect(lintCards({ tree: root(card("a.md", "In Progress")), board: board() })).toEqual([]);
  });
});

describe("broken parent", () => {
  const task = (rel: string, parent: string, overrides: Partial<PlanFileInfo> = {}, dir = PLANS) =>
    card(rel, null, { kind: "task", parent, ...overrides }, dir);

  it("resolves silently to a plan in the same context", () => {
    expect(lintCards({ tree: root(card("p.md", "To Do"), task("t.md", "p.md")), board: board() })).toEqual([]);
  });

  it("names a missing file", () => {
    const findings = lintCards({ tree: root(task("t.md", "gone.md")), board: board() });
    expect(codes(findings)).toEqual(["parent-missing"]);
    expect(findings[0].field).toBe("parent");
    expect(findings[0].message).toBe("parent: gone.md — no card of that name in this context.");
    expect(findings[0].fix).toEqual({ kind: "decide", options: ["Clear parent:"] });
  });

  it("offers the spelling the daemon resolves when the parent is named without .md or as a path", () => {
    const plan = card("p.md", "To Do");
    for (const parent of ["p", "./p.md", "plans/p.md"]) {
      const [f] = lintCards({ tree: root(plan, task("t.md", parent)), board: board() });
      expect(f.code, parent).toBe("parent-missing");
      expect(f.fix, parent).toEqual({ kind: "decide", options: ["Set parent: to p.md", "Clear parent:"] });
    }
  });

  it("names a parent that is a task, or a note", () => {
    const other = card("other.md", "To Do", { kind: "task" });
    const [f] = lintCards({ tree: root(other, task("t.md", "other.md")), board: board() });
    expect(f.code).toBe("parent-not-plan");
    expect(f.message).toBe("parent: other.md is a task, not a plan — only a plan can hold tasks.");
    expect(f.fix).toEqual({ kind: "decide", options: ["Make other.md a plan (kind: plan)", "Clear parent:"] });

    const note = card("n.md", null, { kind: "note" });
    const [g] = lintCards({ tree: root(note, task("t.md", "n.md")), board: board() });
    expect(g.message).toContain("is a note, not a plan");
  });

  it("names a card that is its own parent", () => {
    const [f] = lintCards({ tree: root(task("t.md", "t.md")), board: board() });
    expect(f.code).toBe("parent-self");
    expect(f.message).toBe("parent: t.md is this card itself, so it nests under nothing.");
    expect(f.fix).toEqual({ kind: "decide", options: ["Clear parent:"] });
  });

  it("names the other context a parent lives in", () => {
    const t = tree(
      ctx(ROOT, "root", [task("t.md", "auth-plan.md")], "root"),
      ctx(AUTH, "auth", [card("auth-plan.md", "To Do", {}, AUTH_PLANS)])
    );
    const findings = lintCards({ tree: t, board: board() });
    expect(codes(findings)).toEqual(["parent-other-context"]);
    expect(findings[0].message).toBe(
      'parent: auth-plan.md lives in the "auth" context; a parent must be in this card\'s own context.'
    );
    expect(findings[0].fix).toEqual({ kind: "decide", options: ['Move this card into "auth"', "Clear parent:"] });
  });

  it("prefers the same-context reason over another context's plan", () => {
    const t = tree(
      ctx(ROOT, "root", [card("x.md", null, { kind: "note" }), task("t.md", "x.md")], "root"),
      ctx(AUTH, "auth", [card("x.md", "To Do", {}, AUTH_PLANS)])
    );
    const findings = lintCards({ tree: t, board: board() });
    expect(codes(only(findings, "parent-not-plan"))).toEqual(["parent-not-plan"]);
    expect(only(findings, "parent-other-context")).toEqual([]);
  });

  it("lints archived tasks too: the archive grid draws the same broken chip", () => {
    const findings = lintCards({ tree: root(task("archive/t.md", "gone.md")), board: board() });
    expect(codes(findings)).toEqual(["parent-missing"]);
  });

  it("ignores parent on a non-task, which the daemon never sends anyway", () => {
    expect(lintCards({ tree: root(card("p.md", "To Do", { parent: "gone.md" })), board: board() })).toEqual([]);
  });
});

describe("parent chip text", () => {
  it("uses the finding's reason, and the old wording only without one", () => {
    const [f] = lintCards({ tree: root(card("t.md", null, { kind: "task", parent: "t.md" })), board: board() });
    expect(parentBrokenText("t.md", [f])).toBe(f.message);
    expect(parentBrokenShort([f])).toBe("is this card");
    expect(parentBrokenText("x.md", [])).toBe("parent: x.md — not found in this context");
    expect(parentBrokenShort([])).toBe("not found");
  });

  it("has a short reason for every parent code", () => {
    const t = tree(
      ctx(
        ROOT,
        "root",
        [
          card("task.md", "To Do", { kind: "task" }),
          card("a.md", null, { kind: "task", parent: "gone.md" }),
          card("b.md", null, { kind: "task", parent: "task.md" }),
          card("c.md", null, { kind: "task", parent: "far.md" }),
        ],
        "root"
      ),
      ctx(AUTH, "auth", [card("far.md", "To Do", {}, AUTH_PLANS)])
    );
    const index = lintIndex(lintCards({ tree: t, board: board() }));
    const short = (rel: string) => parentBrokenShort(index.byPath.get(`${PLANS}/${rel}`) ?? []);
    expect(short("a.md")).toBe("not found");
    expect(short("b.md")).toBe("not a plan");
    expect(short("c.md")).toBe("in another context");
  });
});

describe("Done status and the plans/done/ folder", () => {
  it("is a safe status re-write for a Done card outside done/", () => {
    const findings = lintCards({ tree: root(card("a.md", "Done")), board: board() });
    expect(codes(findings)).toEqual(["done-outside-done-folder"]);
    expect(findings[0].field).toBe("file");
    expect(findings[0].fix).toEqual({
      kind: "safe",
      write: { path: `${PLANS}/a.md`, key: "status", value: "Done" },
      summary: "moved into plans/done/ to match its Done status",
    });
  });

  it("writes the column's spelling, so a misspelt AND misfiled card gets one write", () => {
    const findings = lintCards({ tree: root(card("a.md", "done")), board: board() });
    expect(codes(findings).sort()).toEqual(["done-outside-done-folder", "status-spelling"]);
    expect(safeFixes(findings)).toEqual([{ path: `${PLANS}/a.md`, key: "status", value: "Done" }]);
  });

  it("is a decision when a card of that name already sits in done/", () => {
    const findings = lintCards({ tree: root(card("a.md", "Done"), card("done/a.md", "Done")), board: board() });
    const folder = only(findings, "done-outside-done-folder");
    expect(folder).toHaveLength(1);
    expect(folder[0].fix.kind).toBe("decide");
    expect(folder[0].message).toContain("already there");
    expect(safeFixes(findings)).toEqual([]);
  });

  it("is a safe status re-write for a non-Done card inside done/", () => {
    const findings = lintCards({ tree: root(card("done/a.md", "In Progress")), board: board() });
    expect(codes(findings)).toEqual(["done-folder-not-done"]);
    expect(findings[0].fix).toEqual({
      kind: "safe",
      write: { path: `${PLANS}/done/a.md`, key: "status", value: "In Progress" },
      summary: "moved out of plans/done/ to match its In Progress status",
    });
  });

  it("is a decision for a card in done/ with no status: the folder and the board disagree", () => {
    const [f] = lintCards({ tree: root(card("done/a.md", null)), board: board() });
    expect(f.code).toBe("done-folder-not-done");
    expect(f.fix).toEqual({ kind: "decide", options: ["Set status to Done", "Move it back out of plans/done/"] });
  });

  it("is a decision when moving out of done/ would land on a taken name", () => {
    const findings = lintCards({ tree: root(card("done/a.md", "To Do"), card("a.md", "To Do")), board: board() });
    const folder = only(findings, "done-folder-not-done");
    expect(folder[0].fix.kind).toBe("decide");
  });

  it("runs without a board: the daemon's Done is a slug, not a column", () => {
    expect(codes(lintCards({ tree: root(card("a.md", "DONE")), board: undefined }))).toEqual([
      "done-outside-done-folder",
    ]);
  });

  it("leaves alone nested children, archived cards and hand-made subfolders", () => {
    const t = root(
      card("done/p.md", "Done"),
      // A nested child lives where its parent lives, whatever folder.
      card("done/child.md", null, { kind: "task", parent: "p.md" }),
      card("archive/old.md", "In Progress"),
      card("roadmap/x.md", "Done")
    );
    expect(lintCards({ tree: t, board: board() })).toEqual([]);
  });

  it("works in a sub-context's .gavin/plans as well as the root's", () => {
    const t = tree(ctx(AUTH, "auth", [card("a.md", "Done", {}, AUTH_PLANS)]));
    expect(codes(lintCards({ tree: t, board: board() }))).toEqual(["done-outside-done-folder"]);
  });
});

describe("a custom column right of Done", () => {
  it("is a board-scoped decision on each such column", () => {
    const columns = [...COLUMNS, col("c4", "Shipped", 3), col("c5", "Released", 4)];
    const findings = lintCards({ tree: root(), board: board(columns) });
    expect(codes(findings)).toEqual(["column-right-of-done", "column-right-of-done"]);
    expect(findings.map((f) => f.columnId)).toEqual(["c4", "c5"]);
    expect(findings[0]).toMatchObject({ path: null, contextFolder: null, fileName: null, field: "column" });
    expect(findings[0].message).toBe(
      '"Shipped" sits right of Done: rails treat "Shipped" as done, but only Done files a card into plans/done/.'
    );
    expect(findings[0].fix).toEqual({
      kind: "decide",
      options: ['Move "Shipped" left of Done', 'Keep "Shipped" as the done column for rails'],
    });
  });

  it("goes by position, not array order", () => {
    const columns = [col("c4", "Review", 1.5), col("c3", "Done", 2), col("c1", "To Do", 0), col("c2", "In Progress", 1)];
    expect(lintCards({ tree: root(), board: board(columns) })).toEqual([]);
  });

  it("is silent when Done is rightmost, and when there is no Done column", () => {
    expect(lintCards({ tree: root(), board: board() })).toEqual([]);
    expect(lintCards({ tree: root(), board: board([col("a", "Backlog", 0), col("b", "Shipped", 1)]) })).toEqual([]);
  });

  it("still reports with no tree loaded", () => {
    const columns = [...COLUMNS, col("c4", "Shipped", 3)];
    expect(codes(lintCards({ tree: undefined, board: board(columns) }))).toEqual(["column-right-of-done"]);
  });
});

describe("open human items on a Done card", () => {
  it("is a decision naming how many of each kind vanished from the tabs", () => {
    const plan = card("done/a.md", "Done", {
      humanItems: [item("decision", "Which?"), item("test", "Looks right", { lineIndex: 12 }), item("test", "B", { lineIndex: 14 })],
    });
    const findings = lintCards({ tree: root(plan), board: board() });
    expect(codes(findings)).toEqual(["human-items-on-done"]);
    expect(findings[0].field).toBe("checklist");
    expect(findings[0].message).toBe(
      "1 open Decision: item and 2 open Human test: items on a Done card — neither the Decisions nor the Review tab lists them."
    );
    expect(findings[0].fix).toEqual({ kind: "decide", options: ["Re-open the card", "Close the items with a dated line"] });
  });

  it("counts a failed test as still owed and skips ticked and answered items", () => {
    const plan = card("done/a.md", "Done", {
      humanItems: [
        item("test", "failed", { state: "failed" }),
        item("decision", "ticked", { done: true }),
        item("decision", "answered", { state: "answered" }),
        item("test", "passed", { state: "passed" }),
      ],
    });
    const [f] = lintCards({ tree: root(plan), board: board() });
    expect(f.message).toMatch(/^1 open Human test: item on a Done card/);
  });

  it("follows the board's done column and a nested task's effective status", () => {
    const columns = [col("c1", "To Do", 0), col("c3", "Done", 1), col("c4", "Shipped", 2)];
    const shipped = card("a.md", "Shipped", { humanItems: [item("decision", "Q")] });
    const parent = card("p.md", "Done");
    const child = card("done/c.md", null, { kind: "task", parent: "p.md", humanItems: [item("test", "T")] });
    const findings = lintCards({ tree: root(shipped, parent, child), board: board(columns) });
    expect(only(findings, "human-items-on-done").map((f) => f.fileName).sort()).toEqual(["a.md", "c.md"]);
  });

  it("is silent on open cards, archived cards, and an older daemon's unknown items", () => {
    const open = card("a.md", "In Progress", { humanItems: [item("decision", "Q")] });
    const archived = card("archive/b.md", "Done", { humanItems: [item("decision", "Q")] });
    const unknown = card("done/c.md", "Done", { humanItems: null });
    expect(only(lintCards({ tree: root(open, archived, unknown), board: board() }), "human-items-on-done")).toEqual([]);
  });
});

describe("labels outside the board's vocabulary", () => {
  const vocab = [label("bug"), label("ready-for-agent")];

  it("is one decision per unknown label, offering a near match when there is one", () => {
    const plan = card("a.md", "To Do", { labels: ["bgu", "ready-for-agent", "frontend", "Frontend"] });
    const findings = lintCards({ tree: root(plan), board: board(COLUMNS, vocab) });
    expect(codes(findings)).toEqual(["label-unknown", "label-unknown"]);
    expect(findings[0].field).toBe("labels");
    expect(findings[0].message).toContain('labels: "bgu" is not one of the board\'s labels');
    expect(findings[0].fix).toEqual({
      kind: "decide",
      options: ['Rename it to "bug"', 'Add "bgu" to the board\'s labels', 'Remove "bgu" from this card'],
    });
    expect(findings[1].fix).toEqual({
      kind: "decide",
      options: ['Add "frontend" to the board\'s labels', 'Remove "frontend" from this card'],
    });
  });

  it("matches the vocabulary by slug, like the board's chips", () => {
    const plan = card("a.md", "To Do", { labels: ["BUG", "Ready For Agent"] });
    expect(lintCards({ tree: root(plan), board: board(COLUMNS, vocab) })).toEqual([]);
  });

  it("never flags gavin's own memory label, an empty vocabulary, or an archived card", () => {
    const memo = card("m.md", null, { kind: "note", labels: ["memory"] });
    expect(lintCards({ tree: root(memo), board: board(COLUMNS, vocab) })).toEqual([]);
    const any = card("a.md", "To Do", { labels: ["whatever"] });
    expect(lintCards({ tree: root(any), board: board(COLUMNS, []) })).toEqual([]);
    const archived = card("archive/a.md", "To Do", { labels: ["whatever"] });
    expect(lintCards({ tree: root(archived), board: board(COLUMNS, vocab) })).toEqual([]);
  });
});

describe("a direct task with an empty body", () => {
  const direct = card("d.md", "To Do", { kind: "task", direct: true });
  const view = { id: direct.path, kind: "task", direct: true, contextFolder: ROOT, fileName: "d.md" };

  it("is a decision when the body is empty or whitespace", () => {
    for (const content of ["---\nkind: task\ndirect: true\n---\n", "---\nkind: task\n---\n\n   \n"]) {
      const f = lintDirectBody(view, content);
      expect(f?.code).toBe("direct-empty-body");
      expect(f?.field).toBe("body");
      expect(f?.fix).toEqual({ kind: "decide", options: ["Write the prompt in the body", "Turn off direct:"] });
    }
  });

  it("is silent with a body, on a non-direct task, without the content, and when archived", () => {
    expect(lintDirectBody(view, "---\nkind: task\n---\nDo the thing.\n")).toBeNull();
    expect(lintDirectBody({ ...view, direct: false }, "---\n---\n")).toBeNull();
    expect(lintDirectBody(view, null)).toBeNull();
    expect(lintDirectBody(view, undefined)).toBeNull();
    expect(lintDirectBody({ ...view, id: `${PLANS}/archive/d.md` }, "---\n---\n")).toBeNull();
  });

  it("runs inside lintCards only when contents are supplied", () => {
    expect(lintCards({ tree: root(direct), board: board() })).toEqual([]);
    const contents = new Map([[direct.path, "---\nkind: task\ndirect: true\n---\n"]]);
    expect(codes(lintCards({ tree: root(direct), board: board(), contents }))).toEqual(["direct-empty-body"]);
  });

  it("findingsForCard adds it to the workspace's findings once", () => {
    const empty = "---\nkind: task\n---\n";
    const index = lintIndex(lintCards({ tree: root(direct), board: board() }));
    expect(codes(findingsForCard(index, view, empty))).toEqual(["direct-empty-body"]);
    expect(codes(findingsForCard(undefined, view, empty))).toEqual(["direct-empty-body"]);
    const withBody = lintIndex(lintCards({ tree: root(direct), board: board(), contents: new Map([[direct.path, empty]]) }));
    expect(codes(findingsForCard(withBody, view, empty))).toEqual(["direct-empty-body"]);
    expect(findingsForCard(index, view, "---\n---\nbody")).toEqual([]);
  });
});

describe("duplicate file names in one context", () => {
  it("is a decision on every card sharing the name, naming where the others are", () => {
    const findings = lintCards({
      tree: root(card("a.md", "To Do"), card("archive/a.md", "To Do"), card("roadmap/a.md", "To Do")),
      board: board(),
    });
    const dups = only(findings, "duplicate-file-name");
    expect(dups).toHaveLength(3);
    const top = dups.find((f) => f.path === `${PLANS}/a.md`);
    expect(top?.field).toBe("file");
    expect(top?.message).toBe(
      "Another card in this context is also named a.md (.gavin-root/plans/archive/a.md, " +
        ".gavin-root/plans/roadmap/a.md); parent: links and moves into plans/done/ find only one of them."
    );
    expect(top?.fix).toEqual({ kind: "decide", options: ["Rename this card", "Rename the other card"] });
  });

  it("does not count the same name in two different contexts", () => {
    const t = tree(
      ctx(ROOT, "root", [card("a.md", "To Do")], "root"),
      ctx(AUTH, "auth", [card("a.md", "To Do", {}, AUTH_PLANS)])
    );
    expect(lintCards({ tree: t, board: board() })).toEqual([]);
  });
});

describe("lintCards", () => {
  it("is empty for a tree that has not loaded or whose root is missing", () => {
    expect(lintCards({ tree: undefined, board: board() })).toEqual([]);
    expect(lintCards({ tree: { ...root(card("a.md", "Done")), rootMissing: true }, board: board() })).toEqual([]);
  });

  it("orders findings by context, then path, then the board's own last", () => {
    const columns = [...COLUMNS, col("c4", "Shipped", 3)];
    const t = tree(
      ctx(AUTH, "auth", [card("z.md", "Nope", {}, AUTH_PLANS)]),
      ctx(ROOT, "root", [card("b.md", "Nope"), card("a.md", "Nope")], "root")
    );
    const findings = lintCards({ tree: t, board: board(columns) });
    expect(findings.map((f) => f.path ?? f.columnId)).toEqual([
      `${PLANS}/a.md`,
      `${PLANS}/b.md`,
      `${AUTH_PLANS}/z.md`,
      "c4",
    ]);
  });

  it("produces plain JSON: what the daemon side will mirror", () => {
    const findings = lintCards({ tree: root(card("a.md", "done"), card("b.md", "Nope")), board: board() });
    expect(JSON.parse(JSON.stringify(findings))).toEqual(findings);
  });
});

describe("safeFixes", () => {
  it("returns only safe writes, one per card and key, as copies", () => {
    const findings = lintCards({
      tree: root(card("a.md", "done"), card("b.md", "Nope"), card("done/c.md", "to do")),
      board: board(),
    });
    const writes = safeFixes(findings);
    expect(writes).toEqual([
      { path: `${PLANS}/a.md`, key: "status", value: "Done" },
      { path: `${PLANS}/done/c.md`, key: "status", value: "To Do" },
    ]);
    writes[0].value = "mutated";
    expect(findings.some((f) => f.fix.kind === "safe" && f.fix.write.value === "mutated")).toBe(false);
  });

  it("is empty when every finding needs the human", () => {
    expect(safeFixes(lintCards({ tree: root(card("a.md", "Nope")), board: board() }))).toEqual([]);
  });
});

describe("lintIndex / cardWarningText", () => {
  it("groups card findings by path and board findings by column", () => {
    const columns = [...COLUMNS, col("c4", "Shipped", 3)];
    const index = lintIndex(lintCards({ tree: root(card("a.md", "Nope")), board: board(columns) }));
    expect([...index.byPath.keys()]).toEqual([`${PLANS}/a.md`]);
    expect([...index.byColumn.keys()]).toEqual(["c4"]);
  });

  it("joins every message, adds the parse warning, and is null with nothing to say", () => {
    const findings = lintCards({ tree: root(card("a.md", "Nope", { labels: ["x"] })), board: board(COLUMNS, [label("y")]) });
    const text = cardWarningText(findings, true);
    expect(text?.split("\n")).toEqual([findings[0].message, findings[1].message, PARSE_WARNING_TEXT]);
    expect(cardWarningText([], true)).toBe(PARSE_WARNING_TEXT);
    expect(cardWarningText([], false)).toBeNull();
  });
});
