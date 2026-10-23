import { describe, it, expect } from "vitest";
import {
  LIVE_CONFLICT_HOLD_REASON,
  isLiveConflictHoldStall,
  liveConflictHold,
  liveConflictKey,
  type HoldingRail,
} from "$lib/orchestration/liveConflictHold";
import type { Conflict } from "$lib/orchestration/orchestration";
import { tsSources } from "$lib/sources";

function rail(stepIds: string[], holdOnLiveConflict?: boolean): HoldingRail {
  return {
    id: "r1",
    stages: [{ steps: stepIds.slice(0, 1).map((id) => ({ id })) }, { steps: stepIds.slice(1).map((id) => ({ id })) }],
    ...(holdOnLiveConflict === undefined ? {} : { holdOnLiveConflict }),
  };
}

function sameWorktree(
  stepIds: string[],
  severity: "live" | "potential" = "live",
  scope: "stage" | "rails" = "rails"
): Extract<Conflict, { kind: "same-worktree" }> {
  return { kind: "same-worktree", scope, stageId: scope === "stage" ? "st1" : null, severity, stepIds, worktreePath: "/repo" };
}

describe("liveConflictHold", () => {
  const mine = rail(["a1", "a2"], true);
  const live = sameWorktree(["a2", "b1", "b2"]);

  it("never holds a rail that did not opt in -- rule O4 is the default", () => {
    expect(liveConflictHold(rail(["a1", "a2"]), [live])).toEqual({ hold: false });
    expect(liveConflictHold(rail(["a1", "a2"], false), [live])).toEqual({ hold: false });
  });

  it("holds an opted-in rail on a live conflict with another rail in its checkout", () => {
    const verdict = liveConflictHold(mine, [live]);
    expect(verdict.hold).toBe(true);
    if (!verdict.hold) return;
    expect(verdict.conflict).toBe(live);
    expect(verdict.key).toBe(liveConflictKey(live));
    expect(verdict.reason).toBe(
      "Waiting: other rails have agents running in this checkout right now. Confirm to start the next stage beside them."
    );
  });

  it("never holds on a merely potential conflict", () => {
    expect(liveConflictHold(mine, [sameWorktree(["a2", "b1"], "potential")])).toEqual({ hold: false });
  });

  it("never holds on a conflict that does not name one of its steps", () => {
    expect(liveConflictHold(mine, [sameWorktree(["b1", "b2"])])).toEqual({ hold: false });
  });

  it("never holds on its own parallel stage -- that is the rail waiting on itself", () => {
    expect(liveConflictHold(mine, [sameWorktree(["a1", "a2"], "live", "stage")])).toEqual({ hold: false });
  });

  it("ignores every other kind of conflict", () => {
    const others: Conflict[] = [
      { kind: "duplicate-card", severity: "potential", stepIds: ["a1", "b1"], cardPath: "/c.md" },
      { kind: "rail-unbound", severity: "potential", railId: "r1" },
      { kind: "declared", severity: "potential", id: "n1", stepIds: ["a1", "b1"], note: "x" },
    ];
    expect(liveConflictHold(mine, others)).toEqual({ hold: false });
  });

  it("lets a confirmed conflict through, and holds on the next one", () => {
    const second = sameWorktree(["a1", "c1", "c2"]);
    const acknowledged = new Set([liveConflictKey(live)]);
    expect(liveConflictHold(mine, [live], acknowledged)).toEqual({ hold: false });
    const verdict = liveConflictHold(mine, [live, second], acknowledged);
    expect(verdict.hold && verdict.conflict).toBe(second);
  });
});

describe("liveConflictKey", () => {
  it("is the checkout and the steps, whatever order they came in", () => {
    expect(liveConflictKey(sameWorktree(["b", "a"]))).toBe(liveConflictKey(sameWorktree(["a", "b"])));
  });

  it("changes when another agent joins the collision", () => {
    expect(liveConflictKey(sameWorktree(["a", "b", "c"]))).not.toBe(liveConflictKey(sameWorktree(["a", "b"])));
  });
});

describe("the hold's stall reason", () => {
  it("is the reason the verdict carries, and is told apart from every other stall", () => {
    expect(isLiveConflictHoldStall(LIVE_CONFLICT_HOLD_REASON)).toBe(true);
    expect(isLiveConflictHoldStall("agent exited before the card reached Done")).toBe(false);
    expect(isLiveConflictHoldStall(null)).toBe(false);
  });

  it("reads a null opt-in, an older plan's shape, as rule O4", () => {
    const old: HoldingRail = { id: "r1", stages: [{ steps: [{ id: "a1" }] }], holdOnLiveConflict: null };
    expect(liveConflictHold(old, [sameWorktree(["a1", "b1", "b2"])])).toEqual({ hold: false });
  });
});

// Rule O4 stays the norm everywhere but the two places the opt-in is
// read: the scheduler's launch rule, and the confirmation that releases
// a hold. Anything else calling this would be a second scheduler.
describe("liveConflictHold is wired to the scheduler and the confirmation only", () => {
  it("is called from orchestration.ts and orchestrationState.ts and nowhere else", () => {
    const ts = tsSources();
    const callers = Object.entries(ts).filter(
      ([name, src]) => name !== "liveConflictHold.ts" && src.includes("liveConflictHold(")
    );
    expect(callers.map(([name]) => name).sort()).toEqual(["orchestration.ts", "orchestrationState.ts"]);
  });

  it("names the persisted field it reads", () => {
    expect(tsSources()["liveConflictHold.ts"]).toContain("Rail.holdOnLiveConflict");
  });
});
