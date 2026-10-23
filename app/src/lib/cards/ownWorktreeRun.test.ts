import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

const stores = vi.hoisted(() => ({ git: null as unknown as ReturnType<typeof writable<Record<string, unknown>>> }));

vi.mock("$lib/cards/cardRunActions", () => ({
  DESK_LAUNCH_HOST: { desk: true },
  runCard: vi.fn(async () => null),
}));
vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return { layoutState: writable({ workspaces: [{ id: "ws", rootPath: "/r" }] }) };
});
vi.mock("$lib/core/gavinState", async () => {
  const { writable } = await import("svelte/store");
  return { gavinTrees: writable({}) };
});
vi.mock("$lib/git/gitState", async () => {
  const { writable } = await import("svelte/store");
  stores.git = writable<Record<string, unknown>>({});
  return {
    gitStore: stores.git,
    ensureGitView: vi.fn((ws: string, cwd: string) =>
      stores.git.update((all) => ({ ...all, [ws]: { cwd, repo: null, refs: null } }))
    ),
    refresh: vi.fn(async () => {}),
    rootPathOf: (view: { cwd: string; refs?: { worktrees: { isMain: boolean; path: string }[] } | null }) =>
      view.refs?.worktrees.find((w) => w.isMain)?.path ?? view.cwd,
  };
});

import { runCard } from "$lib/cards/cardRunActions";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { ensureGitView, refresh } from "$lib/git/gitState";
import { NOT_A_REPOSITORY, NO_BRANCH_LIST, runCardsInOwnWorktrees } from "$lib/cards/ownWorktreeRun";
import type { CardView } from "$lib/core/planBoard";

function card(id: string, title: string): CardView {
  return { id, title, kind: "task" } as CardView;
}

const REFS = {
  branches: [{ name: "main" }, { name: "fix-login" }],
  worktrees: [{ isMain: true, path: "/r", branch: "main", head: "abc1234" }],
};

function view(patch: Record<string, unknown> = {}): void {
  stores.git.set({ ws: { cwd: "/r", repo: { notARepo: false, root: "/r" }, refs: REFS, ...patch } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runCard).mockResolvedValue(null);
  gavinTrees.set({ ws: { rootPath: "/r", rootMissing: false } } as never);
  layoutState.set({ workspaces: [{ id: "ws", rootPath: "/r" }] } as never);
  stores.git.set({});
});

describe("runCardsInOwnWorktrees", () => {
  it("runs every card in a worktree of its own, named past the branches git has, forked from the trunk", async () => {
    view();
    const cards = [card("/r/plans/a.md", "Fix login"), card("/r/plans/b.md", "Fix login")];
    expect(await runCardsInOwnWorktrees("ws", cards)).toBeNull();
    expect(refresh).toHaveBeenCalledWith("ws");
    expect(vi.mocked(runCard).mock.calls).toEqual([
      ["ws", cards[0], { desk: true }, { path: "/r/.gavin-worktrees/fix-login-2", branch: "fix-login-2", from: "main" }],
      ["ws", cards[1], { desk: true }, { path: "/r/.gavin-worktrees/fix-login-3", branch: "fix-login-3", from: "main" }],
    ]);
  });

  it("keeps going past a refused card and reports the first refusal", async () => {
    view();
    vi.mocked(runCard)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("Couldn't create the worktree for B — boom")
      .mockResolvedValueOnce("second");
    const cards = [card("/a", "A"), card("/b", "B"), card("/c", "C")];
    expect(await runCardsInOwnWorktrees("ws", cards)).toBe("Couldn't create the worktree for B — boom");
    expect(runCard).toHaveBeenCalledTimes(3);
  });

  it("opens a Git view on the workspace root when this window has none", async () => {
    await runCardsInOwnWorktrees("ws", [card("/a", "A")]);
    expect(ensureGitView).toHaveBeenCalledWith("ws", "/r");
  });

  it("leaves an existing Git view where it is", async () => {
    view({ cwd: "/r/.gavin-worktrees/other" });
    await runCardsInOwnWorktrees("ws", [card("/a", "A")]);
    expect(ensureGitView).not.toHaveBeenCalled();
    // Folders still go under the workspace root, not the view's checkout.
    expect(vi.mocked(runCard).mock.calls[0][3]).toMatchObject({ path: "/r/.gavin-worktrees/a" });
  });

  it("refuses a workspace that is not a repository, or whose branches cannot be read", async () => {
    view({ repo: { notARepo: true, root: null } });
    expect(await runCardsInOwnWorktrees("ws", [card("/a", "A")])).toBe(NOT_A_REPOSITORY);
    view({ refs: null });
    expect(await runCardsInOwnWorktrees("ws", [card("/a", "A")])).toBe(NO_BRANCH_LIST);
    gavinTrees.set({ ws: { rootPath: "/r", rootMissing: true } } as never);
    stores.git.set({});
    expect(await runCardsInOwnWorktrees("ws", [card("/a", "A")])).toBe(NOT_A_REPOSITORY);
    expect(runCard).not.toHaveBeenCalled();
  });

  it("refuses a remote workspace, whose worktrees this machine cannot cut", async () => {
    view();
    layoutState.set({ workspaces: [{ id: "ws", rootPath: "/r", ssh: { host: "box" } }] } as never);
    const err = await runCardsInOwnWorktrees("ws", [card("/a", "A")]);
    expect(err).not.toBeNull();
    expect(runCard).not.toHaveBeenCalled();
  });

  it("does nothing for no cards", async () => {
    expect(await runCardsInOwnWorktrees("ws", [])).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
