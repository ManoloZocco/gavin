import { describe, it, expect } from "vitest";
import {
  MAX_LISTED_PATHS,
  judgeCommitRun,
  ownCommitPaths,
  scopeAtVerdict,
  sharedCheckoutCommitPrompt,
  sharedCommitScope,
} from "$lib/git/sharedCommit";
import { BUILTIN_TOOLS } from "$lib/orchestration/orchestrationTools";

const COMMIT_BODY = BUILTIN_TOOLS.find((t) => t.id === "builtin:commit")!.body;

describe("ownCommitPaths", () => {
  const dirty = ["src/a.ts", "src/b.ts", "src/c.ts", "README.md"];

  it("is everything no peer touched, for the Git tab's button", () => {
    expect(ownCommitPaths(dirty, undefined, [["src/b.ts"], ["README.md"]])).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("cannot answer for the Git tab's button when a peer cannot be read", () => {
    expect(ownCommitPaths(dirty, undefined, [["src/b.ts"], null])).toBeNull();
  });

  it("is the run's own touched files, still dirty, for a rail", () => {
    expect(ownCommitPaths(dirty, ["src/a.ts", "src/gone.ts", "src/c.ts"], [[]])).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("never takes a file a live peer touched, even one the run touched too", () => {
    expect(ownCommitPaths(dirty, ["src/a.ts", "src/b.ts"], [["src/b.ts"]])).toEqual(["src/a.ts"]);
  });

  it("keeps a rail's own list when a peer cannot be read", () => {
    expect(ownCommitPaths(dirty, ["src/a.ts"], [null])).toEqual(["src/a.ts"]);
  });

  it("cannot answer when the run's own files cannot be read", () => {
    expect(ownCommitPaths(dirty, null, [["src/b.ts"]])).toBeNull();
  });

  it("is sorted and free of duplicates", () => {
    expect(ownCommitPaths(["z.ts", "a.ts", "z.ts"], undefined, [])).toEqual(["a.ts", "z.ts"]);
  });

  it("is empty when every changed file is a peer's", () => {
    expect(ownCommitPaths(["a.ts"], undefined, [["a.ts"]])).toEqual([]);
  });
});

describe("sharedCommitScope", () => {
  it("is null with nobody else live", () => {
    expect(sharedCommitScope([], ["a.ts"])).toBeNull();
  });

  it("carries the peers and the list", () => {
    expect(sharedCommitScope(["Fix login"], null)).toEqual({ peers: ["Fix login"], ownPaths: null });
  });
});

describe("sharedCheckoutCommitPrompt", () => {
  it("leaves the body byte for byte when nobody else is live", () => {
    expect(sharedCheckoutCommitPrompt(COMMIT_BODY, null)).toBe(COMMIT_BODY);
    expect(sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: [], ownPaths: ["a.ts"] })).toBe(COMMIT_BODY);
  });

  it("keeps the configured body first, so an override keeps meaning what it says", () => {
    const prompt = sharedCheckoutCommitPrompt("My own commit rules.\n\n", { peers: ["A"], ownPaths: ["a.ts"] });
    expect(prompt.startsWith("My own commit rules.\n\nOther agents are working in this checkout")).toBe(true);
  });

  it("names the live agents and forbids the sweeping forms of git add", () => {
    const prompt = sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: ["Fix login", "Add tests"], ownPaths: ["a.ts"] });
    expect(prompt).toContain("Other agents are working in this checkout right now (Fix login, Add tests).");
    expect(prompt).toContain("Stage each commit by naming its own paths (`git add <path> …`).");
    expect(prompt).toContain("Never `git add -A`, `git add .` or `git commit -a`");
  });

  it("lists exactly the files the commit may take, and says the rest stays", () => {
    const prompt = sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: ["A"], ownPaths: ["src/a.ts", "src/b c.ts"] });
    expect(prompt).toContain("- Commit only these files, and leave every other change alone:\n  - `src/a.ts`\n  - `src/b c.ts`\n");
    expect(prompt).toContain("Leave everything else UNCOMMITTED, and list it at the end.");
    expect(prompt).toContain("not a failure");
  });

  it("commits nothing when every change is a peer's", () => {
    const prompt = sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: ["A"], ownPaths: [] });
    expect(prompt).toContain("Commit nothing, say so, and stop — that is a success, not a problem.");
    expect(prompt).not.toContain("Commit only these files");
  });

  it("falls back to Consolidate repo's attribution rule without a list", () => {
    const prompt = sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: ["A"], ownPaths: null });
    expect(prompt).toContain("Commit only changes you can confidently attribute to finished work");
    expect(prompt).toContain("Leave anything you cannot confidently attribute UNCOMMITTED, and list it at the end.");
    expect(prompt).not.toContain("Commit only these files");
  });

  it("stops listing past the cap and judges by reading instead", () => {
    const many = Array.from({ length: MAX_LISTED_PATHS + 1 }, (_, i) => `f${i}.ts`);
    const prompt = sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: ["A"], ownPaths: many });
    expect(prompt).not.toContain("`f0.ts`");
    expect(prompt).toContain("Commit only changes you can confidently attribute");
    const atCap = sharedCheckoutCommitPrompt(COMMIT_BODY, { peers: ["A"], ownPaths: many.slice(0, MAX_LISTED_PATHS) });
    expect(atCap).toContain("`f0.ts`");
  });
});

describe("judgeCommitRun", () => {
  const shared = { peers: ["A"], ownPaths: ["a.ts", "b.ts"] };

  it("reports a stop as a stop, whatever the exit code and the tree", () => {
    expect(judgeCommitRun({ exitCode: 137, stopped: true, left: ["a.ts"], scope: shared })).toEqual({ kind: "stopped" });
  });

  it("fails a non-zero exit whatever the tree says", () => {
    expect(judgeCommitRun({ exitCode: 1, stopped: false, left: [], scope: null })).toEqual({ kind: "failed", exitCode: 1 });
    expect(judgeCommitRun({ exitCode: 2, stopped: false, left: ["x.ts"], scope: shared })).toEqual({
      kind: "failed",
      exitCode: 2,
    });
  });

  it("calls a clean tree committed", () => {
    expect(judgeCommitRun({ exitCode: 0, stopped: false, left: [], scope: shared })).toEqual({
      kind: "committed",
      leftForPeers: 0,
    });
  });

  it("calls anything left in a lone checkout left-dirty, counted as the Git tab counts", () => {
    expect(judgeCommitRun({ exitCode: 0, stopped: false, left: ["a.ts", "a.ts", "b.ts"], scope: null })).toEqual({
      kind: "left-dirty",
      changes: 3,
    });
  });

  it("does not hold a peer's files against a shared run", () => {
    expect(judgeCommitRun({ exitCode: 0, stopped: false, left: ["peer.ts", "peer.ts"], scope: shared })).toEqual({
      kind: "committed",
      leftForPeers: 1,
    });
  });

  it("still fails a shared run that left its OWN files", () => {
    expect(judgeCommitRun({ exitCode: 0, stopped: false, left: ["a.ts", "peer.ts"], scope: shared })).toEqual({
      kind: "left-dirty",
      changes: 1,
    });
  });

  it("holds nothing against a shared run that had no list", () => {
    expect(
      judgeCommitRun({ exitCode: 0, stopped: false, left: ["a.ts", "b.ts"], scope: { peers: ["A"], ownPaths: null } })
    ).toEqual({ kind: "committed", leftForPeers: 2 });
  });
});

describe("scopeAtVerdict", () => {
  const launched = { peers: ["A"], ownPaths: ["a.ts"] };

  it("keeps the scope the run was launched under", () => {
    expect(scopeAtVerdict(launched, ["z.ts"], [])).toBe(launched);
  });

  it("is null when nobody is live, launched or adopted", () => {
    expect(scopeAtVerdict(null, ["a.ts"], [])).toBeNull();
    expect(scopeAtVerdict(undefined, null, [])).toBeNull();
  });

  it("holds a run launched alone to the tree it was launched on", () => {
    expect(scopeAtVerdict(null, ["b.ts", "a.ts", "a.ts"], ["Newcomer"])).toEqual({
      peers: ["Newcomer"],
      ownPaths: ["a.ts", "b.ts"],
    });
  });

  it("judges an adopted run with peers as its agent was told to judge", () => {
    expect(scopeAtVerdict(undefined, undefined, ["A"])).toEqual({ peers: ["A"], ownPaths: null });
  });
});
