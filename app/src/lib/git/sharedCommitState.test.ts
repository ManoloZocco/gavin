import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/core/backend", () => ({
  cardRunTouchedFiles: vi.fn(),
  shellWrites: vi.fn(),
  gitRepoInfo: vi.fn(),
  gitStatus: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable({ workspaces: [] }),
    // Old enough that the shell-write hook is not asked: these tests are
    // about the transcript reader's answer, not the hook's.
    daemonCompat: writable({ daemonVersion: 1, appVersion: 1, degraded: false }),
  };
});

vi.mock("$lib/core/gavinState", async () => {
  const { writable } = await import("svelte/store");
  return { gavinTrees: writable({}) };
});

const liveIds = new Set<string>();
vi.mock("$lib/core/workspace", async (original) => ({
  ...(await original<typeof import("$lib/core/workspace")>()),
  sessionLiveness: vi.fn((_state: unknown, id: string) => (liveIds.has(id) ? "live" : "gone")),
}));

import * as backend from "$lib/core/backend";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import type { CardSession } from "$lib/board/kanban";
import type { GavinTree } from "$lib/core/gavin";
import { commitBodyForCheckout, commitScopeFor, livePeersInCheckout } from "$lib/git/sharedCommitState";

const WS = "ws1";
const ROOT = "/repo";

function bind(path: string, sessionId: string, conversationId: string | null = `c-${sessionId}`, launchCwd = ROOT): CardSession {
  return { path, sessionId, cwd: launchCwd, launchCwd, conversationId };
}

function setBindings(bindings: CardSession[]): void {
  kanbanState.set({ [WS]: { columns: [], labels: [], cardSessions: bindings } });
}

/// What each conversation's transcript says it touched; absent means the
/// transcript cannot be read.
function touched(byConversation: Record<string, string[]>): void {
  vi.mocked(backend.cardRunTouchedFiles).mockImplementation(async (conversationId, _cwd, _root, candidates) => {
    const paths = conversationId ? byConversation[conversationId] : undefined;
    if (!paths) return { kind: "unavailable", reason: "gone" };
    return { kind: "ready", paths: paths.filter((p) => candidates.includes(p)) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  liveIds.clear();
  setBindings([]);
  gavinTrees.set({});
});

describe("livePeersInCheckout", () => {
  it("is the live card sessions in the checkout, less the excluded cards", () => {
    setBindings([
      bind("/repo/plans/a.md", "s1"),
      bind("/repo/plans/b.md", "s2"),
      bind("/repo/plans/c.md", "s3", "c3", "/repo/.gavin-worktrees/c"),
      bind("/repo/plans/d.md", "s4"),
    ]);
    liveIds.add("s1").add("s3").add("s4");
    expect(livePeersInCheckout(WS, ROOT, ["/repo/plans/d.md"]).map((p) => p.path)).toEqual(["/repo/plans/a.md"]);
  });

  it("is nobody for a workspace with no board", () => {
    expect(livePeersInCheckout("other", ROOT)).toEqual([]);
  });
});

describe("commitScopeFor", () => {
  it("asks nothing and answers null when nobody else is live", async () => {
    setBindings([bind("/repo/plans/a.md", "s1")]);
    expect(await commitScopeFor(WS, ROOT, ["x.ts"])).toBeNull();
    expect(backend.cardRunTouchedFiles).not.toHaveBeenCalled();
  });

  it("gives the Git tab everything the live peers did not touch, peers named by card title", async () => {
    setBindings([bind("/repo/plans/a.md", "s1")]);
    liveIds.add("s1");
    gavinTrees.set({
      [WS]: {
        rootPath: ROOT,
        contexts: [
          {
            name: "root",
            folder: ROOT,
            plans: [{ path: "/repo/plans/a.md", title: "Fix login", status: null, priority: null, order: null }],
          },
        ],
      } as unknown as GavinTree,
    });
    touched({ "c-s1": ["src/login.ts"] });
    expect(await commitScopeFor(WS, ROOT, ["src/login.ts", "README.md"])).toEqual({
      peers: ["Fix login"],
      ownPaths: ["README.md"],
    });
    expect(backend.cardRunTouchedFiles).toHaveBeenCalledWith("c-s1", ROOT, ROOT, ["src/login.ts", "README.md"], null);
  });

  it("has no list for the Git tab when a peer's transcript cannot be read", async () => {
    setBindings([bind("/repo/plans/a.md", "s1"), bind("/repo/plans/b.md", "s2", null)]);
    liveIds.add("s1").add("s2");
    touched({ "c-s1": ["a.ts"] });
    expect(await commitScopeFor(WS, ROOT, ["a.ts", "b.ts"])).toEqual({ peers: ["a.md", "b.md"], ownPaths: null });
  });

  it("gives a rail its own cards' files, less anything a peer touched", async () => {
    setBindings([bind("/repo/plans/peer.md", "s1"), bind("/repo/plans/mine.md", "s2"), bind("/repo/plans/mine2.md", "s3")]);
    liveIds.add("s1").add("s2");
    touched({ "c-s1": ["shared.ts"], "c-s2": ["mine.ts", "shared.ts"], "c-s3": ["mine2.ts"] });
    const scope = await commitScopeFor(WS, ROOT, ["mine.ts", "mine2.ts", "shared.ts", "other.ts"], [
      "/repo/plans/mine.md",
      "/repo/plans/mine2.md",
    ]);
    // Its own live card is not a peer of its own commit.
    expect(scope).toEqual({ peers: ["peer.md"], ownPaths: ["mine.ts", "mine2.ts"] });
  });

  it("has no list for a rail whose own card cannot be read, or that has none", async () => {
    setBindings([bind("/repo/plans/peer.md", "s1"), bind("/repo/plans/mine.md", "s2", null)]);
    liveIds.add("s1");
    touched({ "c-s1": ["x.ts"] });
    expect((await commitScopeFor(WS, ROOT, ["x.ts"], ["/repo/plans/mine.md"]))?.ownPaths).toBeNull();
    expect((await commitScopeFor(WS, ROOT, ["x.ts"], ["/repo/plans/never-run.md"]))?.ownPaths).toBeNull();
  });

  it("reads a transcript that throws as unreadable", async () => {
    setBindings([bind("/repo/plans/a.md", "s1")]);
    liveIds.add("s1");
    vi.mocked(backend.cardRunTouchedFiles).mockRejectedValue(new Error("boom"));
    expect(await commitScopeFor(WS, ROOT, ["a.ts"])).toEqual({ peers: ["a.md"], ownPaths: null });
  });
});

describe("commitBodyForCheckout", () => {
  const BODY = "Commit the uncommitted work in this checkout.";

  it("leaves the body alone, asking git nothing, when nobody else is live", async () => {
    setBindings([bind("/repo/plans/mine.md", "s1")]);
    liveIds.add("s1");
    expect(await commitBodyForCheckout(WS, ROOT, BODY, ["/repo/plans/mine.md"])).toBe(BODY);
    expect(backend.gitRepoInfo).not.toHaveBeenCalled();
  });

  it("narrows the body to the rail's own files when a peer is live", async () => {
    setBindings([bind("/repo/plans/peer.md", "s1"), bind("/repo/plans/mine.md", "s2")]);
    liveIds.add("s1");
    vi.mocked(backend.gitRepoInfo).mockResolvedValue({ notARepo: false, root: ROOT } as never);
    vi.mocked(backend.gitStatus).mockResolvedValue({
      unstaged: [
        { path: "mine.ts", status: "M" },
        { path: "theirs.ts", status: "M" },
      ],
      staged: [{ path: "mine.ts", status: "M" }],
    } as never);
    touched({ "c-s1": ["theirs.ts"], "c-s2": ["mine.ts"] });
    const body = await commitBodyForCheckout(WS, ROOT, BODY, ["/repo/plans/mine.md"]);
    expect(body.startsWith(`${BODY}\n\nOther agents are working in this checkout right now (peer.md).`)).toBe(true);
    expect(body).toContain("  - `mine.ts`");
    expect(body).not.toContain("`theirs.ts`");
  });

  it("sends the body as it was when git cannot be read", async () => {
    setBindings([bind("/repo/plans/peer.md", "s1")]);
    liveIds.add("s1");
    vi.mocked(backend.gitRepoInfo).mockRejectedValue(new Error("no git"));
    expect(await commitBodyForCheckout(WS, ROOT, BODY, [])).toBe(BODY);
    vi.mocked(backend.gitRepoInfo).mockResolvedValue({ notARepo: true, root: null } as never);
    expect(await commitBodyForCheckout(WS, ROOT, BODY, [])).toBe(BODY);
  });
});
