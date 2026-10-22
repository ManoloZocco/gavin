import { describe, it, expect } from "vitest";
import {
  OWN_WORKTREES_LABEL,
  checkoutShare,
  checkoutWouldBeShared,
  liveCheckoutPeers,
  peerTitles,
  planOwnWorktrees,
  sharedCheckoutLines,
} from "$lib/cards/sharedCheckout";
import type { CardSession } from "$lib/board/kanban";
import { svelteSources, tsSources } from "$lib/sources";

function binding(path: string, launchCwd: string | null, sessionId = `s-${path}`, cwd = launchCwd ?? "/elsewhere"): CardSession {
  return { path, sessionId, cwd, launchCwd };
}

const live = (live: Set<string>) => (b: CardSession) => live.has(b.sessionId);

describe("liveCheckoutPeers", () => {
  const root = "/repos/app";

  it("keeps the live sessions launched in the root or below it", () => {
    const a = binding("/repos/app/plans/a.md", "/repos/app");
    const b = binding("/repos/app/plans/b.md", "/repos/app/packages/web");
    const peers = liveCheckoutPeers(root, [a, b], () => true);
    expect(peers.map((p) => p.path)).toEqual([a.path, b.path]);
  });

  it("drops sessions that are not live", () => {
    const a = binding("/repos/app/plans/a.md", "/repos/app", "s1");
    const b = binding("/repos/app/plans/b.md", "/repos/app", "s2");
    expect(liveCheckoutPeers(root, [a, b], live(new Set(["s2"]))).map((p) => p.path)).toEqual([b.path]);
  });

  it("drops a session in a worktree of its own under .gavin-worktrees", () => {
    const own = binding("/repos/app/plans/a.md", "/repos/app/.gavin-worktrees/fix-login");
    expect(liveCheckoutPeers(root, [own], () => true)).toEqual([]);
  });

  it("drops a session in a sibling folder whose name merely starts like the root", () => {
    const sibling = binding("/repos/app/plans/a.md", "/repos/app-old");
    expect(liveCheckoutPeers(root, [sibling], () => true)).toEqual([]);
  });

  it("falls back to the binding's cwd when it has no launch directory", () => {
    const old = binding("/repos/app/plans/a.md", null, "s1", "/repos/app");
    expect(liveCheckoutPeers(root, [old], () => true)).toHaveLength(1);
  });

  it("matches a Windows launch directory against a git-style root", () => {
    const win = binding("C:/repo/plans/a.md", "C:\\Repo\\src");
    expect(liveCheckoutPeers("c:/repo", [win], () => true)).toHaveLength(1);
  });

  it("leaves out the excluded cards and any card bound twice", () => {
    const a = binding("/repos/app/plans/a.md", "/repos/app", "s1");
    const a2 = binding("/repos/app/plans/a.md", "/repos/app", "s1b");
    const b = binding("/repos/app/plans/b.md", "/repos/app", "s2");
    expect(liveCheckoutPeers(root, [a, a2, b], () => true, [b.path]).map((p) => p.sessionId)).toEqual(["s1"]);
  });

  it("finds nobody without a root", () => {
    expect(liveCheckoutPeers("", [binding("/a.md", "/")], () => true)).toEqual([]);
  });
});

describe("peerTitles", () => {
  it("names each peer by its card's title, else its file name", () => {
    const peers = [binding("/r/plans/a.md", "/r"), binding("/r/plans/gone.md", "/r"), binding("C:\\r\\b.md", "/r")];
    const titles = peerTitles(peers, (p) => (p === "/r/plans/a.md" ? "Fix login" : p.endsWith("b.md") ? "  " : null));
    expect(titles).toEqual(["Fix login", "gone.md", "b.md"]);
  });
});

describe("checkoutShare", () => {
  it("is the live peers in the root, by title", () => {
    const a = binding("/r/plans/a.md", "/r", "s1");
    const b = binding("/r/plans/b.md", "/r", "s2");
    expect(checkoutShare("/r", [a, b], live(new Set(["s1"])), () => "Fix login")).toEqual({ peers: ["Fix login"] });
  });

  it("is nobody when the workspace has no root", () => {
    expect(checkoutShare(null, [binding("/r/a.md", "/r")], () => true, () => "x")).toEqual({ peers: [] });
    expect(checkoutShare(undefined, [binding("/r/a.md", "/r")], () => true, () => "x")).toEqual({ peers: [] });
  });
});

describe("checkoutWouldBeShared", () => {
  it("is true for two or more launches, or one beside a live peer", () => {
    expect(checkoutWouldBeShared(0, 0)).toBe(false);
    expect(checkoutWouldBeShared(0, 1)).toBe(false);
    expect(checkoutWouldBeShared(0, 2)).toBe(true);
    expect(checkoutWouldBeShared(1, 1)).toBe(true);
    expect(checkoutWouldBeShared(3, 0)).toBe(false);
  });
});

describe("sharedCheckoutLines", () => {
  it("says nothing for a lone launch in an empty checkout", () => {
    expect(sharedCheckoutLines([], 1)).toEqual([]);
    expect(sharedCheckoutLines([], 0)).toEqual([]);
  });

  it("warns when the press itself puts several agents in one checkout", () => {
    expect(sharedCheckoutLines([], 3)).toEqual([
      "Started here, 3 agents would edit one checkout at the same time — each sees the others' half-written files, and a commit can sweep them in.",
    ]);
  });

  it("names the agents already there, and counts them into the total", () => {
    expect(sharedCheckoutLines(["Fix login"], 1)).toEqual([
      "1 agent already works in this checkout: Fix login.",
      "Started here, 2 agents would edit one checkout at the same time — each sees the others' half-written files, and a commit can sweep them in.",
    ]);
    expect(sharedCheckoutLines(["Fix login", "Add tests"], 2)[0]).toBe(
      "2 agents already work in this checkout: Fix login, Add tests."
    );
  });

  it("still names live peers when nothing is launching", () => {
    expect(sharedCheckoutLines(["Fix login"], 0)).toEqual(["1 agent already works in this checkout: Fix login."]);
  });
});

describe("planOwnWorktrees", () => {
  const cards = [
    { id: "/r/plans/a.md", title: "Fix login" },
    { id: "/r/plans/b.md", title: "Fix login" },
    { id: "/r/plans/c.md", title: "???" },
    { id: "/r/plans/d.md", title: "Feature/Auth rework" },
  ];

  it("gives every card a branch from its title and a folder under .gavin-worktrees", () => {
    const plans = planOwnWorktrees(cards, "/r/", []);
    expect(plans).toEqual([
      { cardPath: "/r/plans/a.md", branch: "fix-login", worktreePath: "/r/.gavin-worktrees/fix-login" },
      { cardPath: "/r/plans/b.md", branch: "fix-login-2", worktreePath: "/r/.gavin-worktrees/fix-login-2" },
      { cardPath: "/r/plans/c.md", branch: "card", worktreePath: "/r/.gavin-worktrees/card" },
      {
        cardPath: "/r/plans/d.md",
        branch: "feature/auth-rework",
        worktreePath: "/r/.gavin-worktrees/feature-auth-rework",
      },
    ]);
  });

  it("skips past branches the repository already has", () => {
    const plans = planOwnWorktrees(cards.slice(0, 1), "/r", ["fix-login", "fix-login-2"]);
    expect(plans[0].branch).toBe("fix-login-3");
  });

  it("plans nothing for no cards", () => {
    expect(planOwnWorktrees([], "/r", [])).toEqual([]);
  });
});

// The confirms are the only place the second action is reachable, so a
// static look at the wiring is what a suite can do for it.
describe("own-worktree surfaces", () => {
  const svelte = svelteSources();
  const ts = tsSources();

  it("offers the second action in the column's and the selection bar's confirms", () => {
    for (const name of ["KanbanColumn.svelte", "BoardSelectionBar.svelte"]) {
      const src = svelte[name];
      expect(src, name).toContain("checkoutShare(");
      expect(src, name).toContain("worktreeLabel && onRunInOwnWorktrees");
    }
  });

  it("wires both boards to the batch launcher", () => {
    for (const name of ["KanbanBoard.svelte", "BoardPane.svelte"]) {
      const src = svelte[name];
      expect(src, name).toContain("runCardsInOwnWorktrees(workspaceId, cards)");
      expect(src, name).toContain("onRunInOwnWorktrees={handleRunInOwnWorktrees}");
    }
  });

  it("names the action once", () => {
    expect(OWN_WORKTREES_LABEL).toBe("Each in its own worktree");
    expect(ts["columnRunAction.ts"]).toContain("OWN_WORKTREES_LABEL");
  });
});
