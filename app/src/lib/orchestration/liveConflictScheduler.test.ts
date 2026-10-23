// The scheduler's half of lc-06: a rail that opted in holds its next
// launch while a LIVE same-worktree conflict with other rails involves
// it, and every other rail is scheduled exactly as rule O4 says.
import { describe, it, expect } from "vitest";
import {
  attentionTip,
  detectConflicts,
  nextActions,
  railAttention,
  retryLabel,
  setRailHoldOnLiveConflict,
  stepAttentions,
} from "$lib/orchestration/orchestration";
import type { Orchestration, Rail } from "$lib/orchestration/orchestration";
import { LIVE_CONFLICT_HOLD_REASON, liveConflictKey } from "$lib/orchestration/liveConflictHold";
import type { Board } from "$lib/board/kanban";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";
import { attentionIndicator } from "$lib/ui/indicators";
import { source } from "$lib/sources";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

const BOARD: Board = {
  columns: ["To Do", "In Progress", "Done"].map((name, i) => ({ id: `c${i}`, name, position: i })),
  labels: [],
  cardSessions: [],
};

function plan(fileName: string): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: null,
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
}

const TREE: GavinTree = {
  rootPath: "/ws",
  rootMissing: false,
  contexts: [
    {
      folderPath: "/ws/.gavin-root",
      kind: "root",
      name: "ws",
      plans: ["a.md", "b.md", "c.md"].map(plan),
      docs: [],
      specs: [],
      hasPrd: true,
      configWarning: false,
    },
  ],
} as unknown as GavinTree;

function rail(id: string, steps: Array<[string, string]>, holdOnLiveConflict?: boolean): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    ...(holdOnLiveConflict === undefined ? {} : { holdOnLiveConflict }),
    stages: [
      {
        id: `${id}-s0`,
        position: 0,
        steps: steps.map(([stepId, card], pi) => ({ id: stepId, position: pi, cardPath: `/ws/.gavin-root/plans/${card}` })),
      },
    ],
  } as Rail;
}

/// Mine: one pending step on the shared root checkout. Theirs: two
/// rails with an agent running each in that same checkout -- a live
/// same-worktree conflict that names one of my steps.
function plan3(hold?: boolean): Orchestration {
  return {
    rails: [rail("mine", [["a1", "a.md"]], hold), rail("r2", [["b1", "b.md"]]), rail("r3", [["c1", "c.md"]])],
    conflictNotes: [],
    railRuns: [
      { railId: "mine", state: "running", currentStageId: "mine-s0" },
      { railId: "r2", state: "running", currentStageId: "r2-s0" },
      { railId: "r3", state: "running", currentStageId: "r3-s0" },
    ],
    stepRuns: [
      { stepId: "b1", state: "running", sessionId: "s-b", reason: null },
      { stepId: "c1", state: "running", sessionId: "s-c", reason: null },
    ],
  };
}

const LIVE = new Set(["s-b", "s-c"]);

function actionsFor(orch: Orchestration, acknowledged: ReadonlySet<string> = new Set()) {
  const conflicts = detectConflicts(orch, TREE, []);
  return nextActions(
    orch, BOARD, TREE, [], LIVE, null, new Map(), new Map(), new Set(), new Map(), {},
    0, new Set(), new Map(), new Map(), { conflicts, acknowledged }
  ).filter((a) => "stepId" in a && a.stepId === "a1");
}

describe("the scheduler and the live-conflict hold", () => {
  it("holds an opted-in rail's launch as a stall carrying the hold's reason", () => {
    expect(actionsFor(plan3(true))).toEqual([{ kind: "stall", stepId: "a1", reason: LIVE_CONFLICT_HOLD_REASON }]);
  });

  it("launches a rail that did not opt in -- rule O4 is the default", () => {
    expect(actionsFor(plan3())).toEqual([{ kind: "launch", stepId: "a1" }]);
    expect(actionsFor(plan3(false))).toEqual([{ kind: "launch", stepId: "a1" }]);
  });

  it("launches once the human confirmed that conflict", () => {
    const orch = plan3(true);
    const live = detectConflicts(orch, TREE, []).find((c) => c.kind === "same-worktree" && c.severity === "live");
    expect(live?.kind).toBe("same-worktree");
    if (live?.kind !== "same-worktree") return;
    expect(actionsFor(orch, new Set([liveConflictKey(live)]))).toEqual([{ kind: "launch", stepId: "a1" }]);
  });

  it("retries a held step that was stalled, and holds it again while nothing changed", () => {
    const orch = plan3(true);
    orch.stepRuns.push({ stepId: "a1", state: "stalled", sessionId: null, reason: LIVE_CONFLICT_HOLD_REASON });
    expect(actionsFor(orch)).toEqual([{ kind: "stall", stepId: "a1", reason: LIVE_CONFLICT_HOLD_REASON }]);
  });

  it("never holds when the caller passes no conflicts, which is every caller that does not know", () => {
    const actions = nextActions(plan3(true), BOARD, TREE, [], LIVE).filter(
      (a) => "stepId" in a && a.stepId === "a1"
    );
    expect(actions).toEqual([{ kind: "launch", stepId: "a1" }]);
  });

  it("does not hold when only one agent is running there -- a potential conflict is not a live one", () => {
    const orch = plan3(true);
    orch.stepRuns = orch.stepRuns.filter((r) => r.stepId !== "c1");
    expect(actionsFor(orch)).toEqual([{ kind: "launch", stepId: "a1" }]);
  });
});

describe("a held step needs the human", () => {
  const held = (): Orchestration => {
    const orch = plan3(true);
    orch.railRuns[0] = { railId: "mine", state: "paused", currentStageId: "mine-s0" };
    orch.stepRuns.push({ stepId: "a1", state: "stalled", sessionId: null, reason: LIVE_CONFLICT_HOLD_REASON });
    return orch;
  };

  it("is marked live-conflict, which rolls up to its rail's \"needs you\"", () => {
    const orch = held();
    const marks = stepAttentions(orch, BOARD, TREE, null, new Map());
    expect(marks.get("a1")).toBe("live-conflict");
    expect(railAttention(orch.rails[0], marks)).toBe("live-conflict");
  });

  it("says what the wait is, draws a badge, and names its Retry for what it does", () => {
    expect(attentionTip("live-conflict", "Done")).toContain("Confirm and start");
    expect(attentionIndicator("live-conflict").tone).toBe("warning");
    expect(retryLabel("live-conflict")).toBe("Confirm and start");
    expect(retryLabel(null)).toBe("Retry");
    expect(retryLabel("unreviewed")).toBe("Retry");
  });

  it("leaves an ordinary stall unmarked", () => {
    const orch = held();
    orch.stepRuns[2] = { stepId: "a1", state: "stalled", sessionId: null, reason: "agent exited" };
    expect(stepAttentions(orch, BOARD, TREE, null, new Map()).get("a1")).toBeUndefined();
  });
});

describe("setRailHoldOnLiveConflict", () => {
  it("sets the opt-in on that rail only", () => {
    const next = setRailHoldOnLiveConflict(plan3(), "mine", true);
    expect(next.rails.map((r) => r.holdOnLiveConflict)).toEqual([true, undefined, undefined]);
    expect(setRailHoldOnLiveConflict(next, "mine", false).rails[0].holdOnLiveConflict).toBe(false);
  });
});

// The templates and the store are thin over the rules above; what they
// must carry is checked on their source, since mounting them needs a
// daemon.
describe("the surfaces", () => {
  it("feeds the tick the conflicts and this window's confirmations", () => {
    const state = source("orchestrationState.ts");
    expect(state).toContain("liveConflictsFor(orch, tree, worktrees)");
    expect(state).toContain("const acknowledgedLiveConflicts = new Set<string>();");
  });

  it("makes a held step's Retry the confirmation, which resumes the rail", () => {
    const state = source("orchestrationState.ts");
    expect(state).toContain("if (verdict.hold) acknowledgedLiveConflicts.add(verdict.key);");
    expect(state).toContain("await resumeRail(workspaceId, held.id);");
  });

  it("gates the rail header's toggle on the daemon that can store it", () => {
    expect(source("OrchestrationHubView.svelte")).toContain(
      'featureBlockedReason($daemonCompat, "liveConflictHold")'
    );
    const header = source("OrchestrationRail.svelte");
    expect(header).toContain("disabled={holdOnLiveConflictBlocked !== null}");
    expect(header).toContain("onToggleHoldOnLiveConflict(!rail.holdOnLiveConflict)");
    expect(FEATURE_MIN_VERSION.liveConflictHold).toBe(81);
  });
});
