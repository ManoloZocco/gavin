import { describe, it, expect } from "vitest";
import {
  columnRunAction,
  columnRunTargets,
  columnRunTip,
  columnRunMenuLabel,
  columnRunAllConfirm,
  checkoutShareChoice,
  RESUME_STAYS_IN_CHECKOUT,
  cardSessionState,
  type CardSessionState,
} from "$lib/board/columnRunAction";
import type { CardView } from "$lib/core/planBoard";
import { launchEstimate } from "$lib/agents/launchEstimate";

function card(id: string, kind: "note" | "task" | "plan" = "task"): CardView {
  return {
    id,
    title: id,
    status: null,
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "root",
    contextFolder: "/repo",
    fileName: `${id}.md`,
    parseWarning: false,
    nestedChildren: [],
  };
}

describe("columnRunAction", () => {
  it("gives each permanent column its own verb, matched by slug", () => {
    for (const name of ["To Do", "to-do", " TO  DO "]) {
      expect(columnRunAction(name), name).toMatchObject({ mode: "start", label: "Start all" });
    }
    for (const name of ["In Progress", "in_progress", "in-progress"]) {
      expect(columnRunAction(name), name).toMatchObject({ mode: "resume", label: "Resume" });
    }
  });

  it("gives Done no run button at all", () => {
    for (const name of ["Done", "done", "DONE"]) {
      expect(columnRunAction(name), name).toBeNull();
    }
  });

  it("leaves custom columns the neutral Run all", () => {
    for (const name of ["Blocked", "Review", "Ideas", ""]) {
      expect(columnRunAction(name), name).toMatchObject({ mode: "run", label: "Run all" });
    }
  });
});

describe("columnRunTargets", () => {
  const cards = [
    card("note", "note"),
    card("free"),
    card("live"),
    card("exited"),
    card("interrupted"),
    card("failed"),
    card("plan", "plan"),
  ];
  const state = (id: string): CardSessionState =>
    id === "live" || id === "exited" || id === "interrupted" || id === "failed"
      ? (id as CardSessionState)
      : "none";
  const nothingDeveloping = () => false;

  it("start and run skip notes and every bound card, whatever became of its session", () => {
    for (const mode of ["start", "run"] as const) {
      expect(columnRunTargets(cards, mode, state, nothingDeveloping).map((c) => c.id)).toEqual(["free", "plan"]);
    }
  });

  it("resume adds the cards whose session exited, was interrupted, or broke — that is what it is for", () => {
    expect(columnRunTargets(cards, "resume", state, nothingDeveloping).map((c) => c.id)).toEqual([
      "free",
      "exited",
      "interrupted",
      "failed",
      "plan",
    ]);
  });

  it("never targets a live session in any mode", () => {
    for (const mode of ["start", "resume", "run"] as const) {
      expect(columnRunTargets(cards, mode, state, nothingDeveloping).some((c) => c.id === "live")).toBe(false);
    }
  });

  // The count on the button is the reason this is a filter rather than
  // left to the launch's own refusal: "Start all (7 unbound)" that starts
  // six is a button that lied about its own scope.
  it("never targets a card being developed, in any mode", () => {
    for (const mode of ["start", "resume", "run"] as const) {
      const targets = columnRunTargets(cards, mode, state, (id) => id === "free" || id === "exited");
      expect(targets.some((c) => c.id === "free"), mode).toBe(false);
      expect(targets.some((c) => c.id === "exited"), mode).toBe(false);
      expect(targets.some((c) => c.id === "plan"), mode).toBe(true);
    }
  });
});

describe("cardSessionState", () => {
  function state(tabs: string[], interrupted: string[] = [], failed: Record<string, string> = {}) {
    return {
      workspaces: [
        {
          id: "ws-1",
          name: "A",
          pages: [
            {
              id: "p1",
              name: "Agents",
              focusedSessionId: null,
              layout: { type: "leaf" as const, tabs, activeTabIndex: 0 },
            },
          ],
          activePageId: "p1",
        },
      ],
      activeWorkspaceId: "ws-1",
      interruptedSessionIds: new Set(interrupted),
      failureReasonById: failed,
    };
  }

  it("says none for a card nothing is bound to", () => {
    expect(cardSessionState(state([]), null)).toBe("none");
  });

  it("says live for a binding whose session is in a tree and untouched", () => {
    expect(cardSessionState(state(["s1"]), { sessionId: "s1" })).toBe("live");
  });

  // The bug: the tab is there and findSessionLocation finds it, so every
  // "is this card busy?" check said yes for a plain shell.
  it("says interrupted for a binding whose run was killed with the daemon", () => {
    expect(cardSessionState(state(["s1"], ["s1"]), { sessionId: "s1" })).toBe("interrupted");
  });

  it("says exited for a binding whose session no tree holds", () => {
    expect(cardSessionState(state([]), { sessionId: "s1" })).toBe("exited");
  });

  // The same bug with a different cause of death: the process is still
  // there and still at its prompt, so every check said "live" for a run
  // that had broken. Jumping to it would present it as work in progress.
  it("says failed for a binding whose agent broke", () => {
    expect(
      cardSessionState(state(["s1"], [], { s1: "API Error: x" }), { sessionId: "s1" })
    ).toBe("failed");
  });

  // Both can only happen if the daemon restarted and then the shell's
  // replacement broke; the failure is the newer fact, and the only one
  // of the two with a resumable conversation behind it.
  it("prefers failed over interrupted when a session is both", () => {
    expect(
      cardSessionState(state(["s1"], ["s1"], { s1: "API Error: x" }), { sessionId: "s1" })
    ).toBe("failed");
  });

  // `gone` first, unchanged: nothing is offered to resume a tab that is
  // not there.
  it("still says exited for a failed session whose tab has gone", () => {
    expect(cardSessionState(state([], [], { s1: "API Error: x" }), { sessionId: "s1" })).toBe("exited");
  });
});

describe("copy", () => {
  it("names the verb and pluralizes the count", () => {
    expect(columnRunTip(columnRunAction("To Do")!, 1)).toContain("Start 1 unbound card ");
    expect(columnRunTip(columnRunAction("To Do")!, 2)).toContain("Start 2 unbound cards ");
    expect(columnRunTip(columnRunAction("In Progress")!, 1)).toContain("Resume 1 stopped card ");
    expect(columnRunTip(columnRunAction("Blocked")!, 3)).toContain("Run 3 unbound cards ");
  });

  it("counts stopped cards for Resume and unbound ones everywhere else", () => {
    expect(columnRunMenuLabel(columnRunAction("In Progress")!, 2)).toBe("Resume (2 stopped)");
    expect(columnRunMenuLabel(columnRunAction("To Do")!, 2)).toBe("Start all (2 unbound)");
    expect(columnRunMenuLabel(columnRunAction("Blocked")!, 2)).toBe("Run all (2 unbound)");
  });
});

describe("columnRunAllConfirm", () => {
  const targets = [card("Fix login"), card("Add tests")];

  it("names the verb, the count, and the column in the title", () => {
    expect(columnRunAllConfirm(columnRunAction("To Do")!, "To Do", targets).title).toBe(
      'Start 2 cards in "To Do"?'
    );
    expect(columnRunAllConfirm(columnRunAction("In Progress")!, "In Progress", targets).title).toBe(
      'Resume 2 cards in "In Progress"?'
    );
    expect(columnRunAllConfirm(columnRunAction("Blocked")!, "Blocked", targets).title).toBe(
      'Run 2 cards in "Blocked"?'
    );
  });

  it("names every card it is about to launch", () => {
    const content = columnRunAllConfirm(columnRunAction("To Do")!, "To Do", targets);
    expect(content.lines).toContain("Starts: Fix login, Add tests.");
  });

  // Last line, after the list of names: who runs, then what it takes.
  it("carries the memory estimate as its last line", () => {
    const content = columnRunAllConfirm(
      columnRunAction("To Do")!,
      "To Do",
      targets,
      launchEstimate({
        count: 2,
        profileId: "claude-code",
        means: {},
        storedMeans: {},
        measuredAgents: 0,
        sample: {
          supported: true,
          totalBytes: 32 * 1024 ** 3,
          freePercent: 50,
          pressureLevel: 1,
          swapUsedBytes: 0,
          sampledAtMs: 0,
        },
        maxInFlight: 1,
        inFlight: 0,
      })
    );
    expect(content.lines[content.lines.length - 1]).toBe(
      "2 agents ≈ 3 GB (1.5 GB each) on top of 16 of 32 GB. 1 starts now, 1 queues."
    );
  });

  it("says nothing about memory when no estimate is passed", () => {
    const content = columnRunAllConfirm(columnRunAction("To Do")!, "To Do", targets);
    expect(content.lines.some((l) => l.includes("GB"))).toBe(false);
  });

  it("singularizes the confirm label for one card", () => {
    expect(columnRunAllConfirm(columnRunAction("To Do")!, "To Do", [card("Only one")]).confirmLabel).toBe(
      "Start 1 card"
    );
  });
});

// Start all on a To Do column puts every card's agent in the workspace's
// own checkout. The confirm used to say nothing about that; now it does,
// and it offers each card a worktree of its own instead.
describe("columnRunAllConfirm in a shared checkout", () => {
  const targets = [card("Fix login"), card("Add tests")];
  const toDo = columnRunAction("To Do")!;
  const SHARED_2 =
    "Started here, 2 agents would edit one checkout at the same time — each sees the others' half-written files, and a commit can sweep them in.";

  it("says nothing and offers nothing when no share is passed", () => {
    const content = columnRunAllConfirm(toDo, "To Do", targets);
    expect(content.worktreeLabel).toBeNull();
    expect(content.lines.some((l) => l.includes("checkout"))).toBe(false);
  });

  it("says nothing for one card in a checkout nobody else is in", () => {
    const content = columnRunAllConfirm(toDo, "To Do", [card("Only one")], null, { peers: [] });
    expect(content.worktreeLabel).toBeNull();
    expect(content.lines).toEqual(["Start 1 unbound card with the workspace agent.", "Starts: Only one."]);
  });

  it("warns and offers worktrees when the press itself starts two or more", () => {
    const content = columnRunAllConfirm(toDo, "To Do", targets, null, { peers: [] });
    expect(content.worktreeLabel).toBe("Each in its own worktree");
    expect(content.lines).toContain(SHARED_2);
  });

  it("names the live agents already in the checkout, after the cards", () => {
    const content = columnRunAllConfirm(toDo, "To Do", [card("Only one")], null, { peers: ["Refactor auth"] });
    expect(content.lines).toEqual([
      "Start 1 unbound card with the workspace agent.",
      "Starts: Only one.",
      "1 agent already works in this checkout: Refactor auth.",
      SHARED_2,
    ]);
    expect(content.worktreeLabel).toBe("Each in its own worktree");
  });

  it("offers worktrees to the custom column's Run all too", () => {
    const content = columnRunAllConfirm(columnRunAction("Blocked")!, "Blocked", targets, null, { peers: [] });
    expect(content.worktreeLabel).toBe("Each in its own worktree");
  });

  it("warns a Resume but never offers to move it", () => {
    const content = columnRunAllConfirm(columnRunAction("In Progress")!, "In Progress", targets, null, {
      peers: ["Refactor auth"],
    });
    expect(content.worktreeLabel).toBeNull();
    expect(content.lines).toContain("1 agent already works in this checkout: Refactor auth.");
    expect(content.lines[content.lines.length - 1]).toBe(RESUME_STAYS_IN_CHECKOUT);
  });

  it("keeps the memory estimate last, after the checkout lines", () => {
    const content = columnRunAllConfirm(
      toDo,
      "To Do",
      targets,
      launchEstimate({
        count: 2,
        profileId: "claude-code",
        means: {},
        storedMeans: {},
        measuredAgents: 0,
        sample: {
          supported: true,
          totalBytes: 32 * 1024 ** 3,
          freePercent: 50,
          pressureLevel: 1,
          swapUsedBytes: 0,
          sampledAtMs: 0,
        },
        maxInFlight: 1,
        inFlight: 0,
      }),
      { peers: ["Refactor auth"] }
    );
    expect(content.lines[2]).toBe("1 agent already works in this checkout: Refactor auth.");
    expect(content.lines[content.lines.length - 1]).toBe(
      "2 agents ≈ 3 GB (1.5 GB each) on top of 16 of 32 GB. 1 starts now, 1 queues."
    );
  });
});

describe("checkoutShareChoice", () => {
  it("is empty without a share or without a shared checkout", () => {
    expect(checkoutShareChoice(null, 5, true)).toEqual({ lines: [], worktreeLabel: null });
    expect(checkoutShareChoice(undefined, 5, true)).toEqual({ lines: [], worktreeLabel: null });
    expect(checkoutShareChoice({ peers: [] }, 1, true)).toEqual({ lines: [], worktreeLabel: null });
    expect(checkoutShareChoice({ peers: [] }, 0, true)).toEqual({ lines: [], worktreeLabel: null });
  });

  it("offers the action when the cards can move", () => {
    expect(checkoutShareChoice({ peers: ["A"] }, 1, true).worktreeLabel).toBe("Each in its own worktree");
  });

  it("adds the stay-put line instead of the action when the cards cannot move", () => {
    const choice = checkoutShareChoice({ peers: [] }, 2, false);
    expect(choice.worktreeLabel).toBeNull();
    expect(choice.lines).toEqual([SHARED_LINE_2, RESUME_STAYS_IN_CHECKOUT]);
  });
});

const SHARED_LINE_2 =
  "Started here, 2 agents would edit one checkout at the same time — each sees the others' half-written files, and a commit can sweep them in.";
