import { describe, expect, it } from "vitest";
import { setupPlan } from "$lib/git/worktreeSetup";
import {
  DEFAULT_WALK_LIMITS,
  LOCKFILE_RULES,
  compareSetup,
  comparisonNote,
  declaredSetupStatus,
  detectWorktreeSetup,
  isIgnoredDir,
  proposalCaveats,
  proposalReason,
  proposalToml,
  proposeForWorkspace,
  scanLockfiles,
  setupLineFor,
  underPrefix,
  workspacePrefix,
  type DirListing,
  type DirLister,
} from "$lib/workspace/worktreeSetupDetect";

function lines(paths: string[]): string[] {
  return detectWorktreeSetup(paths).map((p) => p.line);
}

describe("each lockfile's install", () => {
  // The table the card names, one row per lockfile, at the root.
  const cases: [string, string][] = [
    ["package-lock.json", "npm ci"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["Cargo.lock", "cargo fetch"],
    ["uv.lock", "uv sync"],
    ["poetry.lock", "poetry install"],
    ["Gemfile.lock", "bundle install"],
    ["go.sum", "go mod download"],
  ];
  it.each(cases)("%s at the root proposes `%s`", (lockfile, command) => {
    const [p, ...rest] = detectWorktreeSetup([lockfile]);
    expect(rest).toEqual([]);
    expect(p).toEqual({ line: command, command, dir: "", lockfile, alsoFound: [] });
  });

  it.each(cases)("%s in a nested package runs in a subshell in that folder", (lockfile, command) => {
    expect(lines([`packages/web/${lockfile}`])).toEqual([`(cd packages/web && ${command})`]);
  });

  it("covers every rule in the table, and no rule twice", () => {
    expect(new Set(LOCKFILE_RULES.map((r) => r.lockfile)).size).toBe(LOCKFILE_RULES.length);
    expect(LOCKFILE_RULES.map((r) => r.lockfile).sort()).toEqual(cases.map(([l]) => l).sort());
  });

  it("matches names exactly, not by suffix or case", () => {
    expect(lines(["cargo.lock", "my-package-lock.json", "yarn.lock.bak", "go.sum.txt", "Package-Lock.json"])).toEqual([]);
  });

  it("ignores files that are not lockfiles", () => {
    expect(lines(["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "README.md"])).toEqual([]);
  });
});

describe("the spelling of a setup line", () => {
  it("is the bare command at the root", () => {
    expect(setupLineFor("", "npm ci")).toBe("npm ci");
  });

  it("wraps a nested directory in a subshell so the cd does not leak", () => {
    expect(setupLineFor("app", "npm ci")).toBe("(cd app && npm ci)");
  });

  it("quotes a directory the shell would split or expand", () => {
    expect(setupLineFor("my app", "npm ci")).toBe("(cd 'my app' && npm ci)");
    expect(setupLineFor("it's", "npm ci")).toBe("(cd 'it'\\''s' && npm ci)");
    expect(setupLineFor("a$b", "npm ci")).toBe("(cd 'a$b' && npm ci)");
    expect(setupLineFor("*", "npm ci")).toBe("(cd '*' && npm ci)");
  });

  it("keeps a directory starting with a dash from reading as an option", () => {
    expect(setupLineFor("-x", "npm ci")).toBe("(cd ./-x && npm ci)");
  });

  // The reason for the subshell, proved through the real joiner: the
  // lines are `&&`-chained and the agent goes last, all in one `sh -c`.
  // With subshells nothing after a nested install changes directory.
  it("chains through setupPlan with the agent still at the worktree root", () => {
    const proposal = lines(["app/package-lock.json", "Cargo.lock"]);
    const plan = setupPlan(proposal, "claude", true);
    expect(plan?.line).toBe("cargo fetch && (cd app && npm ci) && claude");
    // No top-level `cd` anywhere on the line: every one is inside parens.
    expect(plan?.line.replace(/\([^)]*\)/g, "")).not.toContain("cd ");
  });
});

describe("what is skipped", () => {
  it("skips installed dependencies, build output and vendored trees", () => {
    expect(
      lines([
        "node_modules/foo/package-lock.json",
        "app/node_modules/bar/yarn.lock",
        "bower_components/x/package-lock.json",
        "target/debug/build/Cargo.lock",
        "vendor/github.com/x/go.sum",
        "third_party/lib/Cargo.lock",
        "third-party/lib/Cargo.lock",
        "venv/lib/poetry.lock",
        "__pycache__/uv.lock",
        "ios/Pods/x/Gemfile.lock",
      ])
    ).toEqual([]);
  });

  it("skips every dot-folder: .git, gavin's worktrees, agent worktrees, tool caches", () => {
    expect(
      lines([
        ".gavin-worktrees/feature/package-lock.json",
        ".gavin-worktrees/feature/Cargo.lock",
        ".claude/worktrees/agent-1/app/package-lock.json",
        ".git/x/Cargo.lock",
        ".venv/uv.lock",
        ".yarn/cache/yarn.lock",
      ])
    ).toEqual([]);
  });

  it("does not skip a folder merely CONTAINING an ignored name", () => {
    expect(lines(["targets/Cargo.lock", "vendors/go.sum", "my.node_modules/package-lock.json"])).toEqual([
      "(cd my.node_modules && npm ci)",
      "(cd targets && cargo fetch)",
      "(cd vendors && go mod download)",
    ]);
  });

  it("knows the ignored names", () => {
    for (const name of ["node_modules", "target", "vendor", ".gavin-worktrees", ".git", ".claude"]) {
      expect(isIgnoredDir(name)).toBe(true);
    }
    for (const name of ["app", "crates", "src", "packages", "targets"]) {
      expect(isIgnoredDir(name)).toBe(false);
    }
  });

  it("drops paths that are absolute or climb out of the repository", () => {
    expect(lines(["/etc/Cargo.lock", "../other/package-lock.json", "a/../../Cargo.lock", "C:/x/Cargo.lock", "\\x\\Cargo.lock"])).toEqual([]);
  });
});

describe("one install per ecosystem per folder", () => {
  it("prefers pnpm, yarn and bun over a stray package-lock.json, and says so", () => {
    const [p, ...rest] = detectWorktreeSetup(["package-lock.json", "pnpm-lock.yaml"]);
    expect(rest).toEqual([]);
    expect(p.line).toBe("pnpm install --frozen-lockfile");
    expect(p.lockfile).toBe("pnpm-lock.yaml");
    expect(p.alsoFound).toEqual(["package-lock.json"]);
    expect(proposalReason(p)).toBe("pnpm-lock.yaml is here (also found package-lock.json, not used)");

    expect(lines(["package-lock.json", "yarn.lock"])).toEqual(["yarn install --frozen-lockfile"]);
    expect(lines(["package-lock.json", "bun.lockb"])).toEqual(["bun install --frozen-lockfile"]);
  });

  it("collapses bun's two lockfile spellings into one command", () => {
    const [p, ...rest] = detectWorktreeSetup(["bun.lockb", "bun.lock"]);
    expect(rest).toEqual([]);
    expect(p.lockfile).toBe("bun.lock");
    expect(p.alsoFound).toEqual(["bun.lockb"]);
  });

  it("prefers uv over poetry in one folder", () => {
    expect(lines(["poetry.lock", "uv.lock"])).toEqual(["uv sync"]);
  });

  it("keeps different ecosystems in one folder, node first", () => {
    expect(lines(["go.sum", "Gemfile.lock", "uv.lock", "Cargo.lock", "package-lock.json"])).toEqual([
      "npm ci",
      "cargo fetch",
      "uv sync",
      "bundle install",
      "go mod download",
    ]);
  });

  it("keeps the same ecosystem in different folders apart", () => {
    expect(lines(["package-lock.json", "web/package-lock.json"])).toEqual(["npm ci", "(cd web && npm ci)"]);
  });

  it("states a plain reason when there was no choice", () => {
    expect(proposalReason(detectWorktreeSetup(["app/package-lock.json"])[0])).toBe("app/package-lock.json is here");
  });
});

describe("order", () => {
  it("puts the root first, then shallower folders, then by name", () => {
    expect(lines(["z/Cargo.lock", "a/b/package-lock.json", "Cargo.lock", "b/go.sum", "a/uv.lock"])).toEqual([
      "cargo fetch",
      "(cd a && uv sync)",
      "(cd b && go mod download)",
      "(cd z && cargo fetch)",
      "(cd a/b && npm ci)",
    ]);
  });

  it("does not depend on the order the paths arrive in, and counts duplicates once", () => {
    const paths = ["app/package-lock.json", "Cargo.lock", "web/yarn.lock", "web/package-lock.json", "tools/go.sum"];
    const expected = detectWorktreeSetup(paths);
    expect(detectWorktreeSetup([...paths].reverse())).toEqual(expected);
    expect(detectWorktreeSetup([...paths, ...paths, "./Cargo.lock", "app//package-lock.json"])).toEqual(expected);
  });

  it("normalises backslashes from a Windows listing", () => {
    expect(lines(["app\\package-lock.json"])).toEqual(["(cd app && npm ci)"]);
  });
});

// This repository, as `git ls-files` lists it, plus what sits on disk
// beside it and must NOT be proposed: installed dependencies, gavin's
// own worktrees, agent worktrees and cargo's build output.
const THIS_REPO = [
  "Cargo.toml",
  "Cargo.lock",
  "CLAUDE.md",
  "crates/daemon/Cargo.toml",
  "crates/protocol/Cargo.toml",
  "crates/companion-wasm/Cargo.toml",
  "app/package.json",
  "app/package-lock.json",
  "app/src-tauri/Cargo.toml",
  "app/companion/package.json",
  "app/companion-shell/package.json",
  "app/companion-shell/package-lock.json",
  "test-fixtures/relay-urls/cases.json",
  // On disk, not the repo's own:
  "app/node_modules/esbuild/package-lock.json",
  "app/node_modules/@sveltejs/kit/node_modules/x/yarn.lock",
  "app/companion-shell/node_modules/@capacitor/core/package-lock.json",
  "target/debug/build/ring/out/Cargo.lock",
  ".gavin-worktrees/feature-x/Cargo.lock",
  ".gavin-worktrees/feature-x/app/package-lock.json",
  ".claude/worktrees/agent-a1/Cargo.lock",
  ".claude/worktrees/agent-a1/app/companion-shell/package-lock.json",
];

describe("this repository", () => {
  it("proposes cargo fetch at the root and npm ci in both npm packages", () => {
    expect(detectWorktreeSetup(THIS_REPO)).toEqual([
      { line: "cargo fetch", command: "cargo fetch", dir: "", lockfile: "Cargo.lock", alsoFound: [] },
      { line: "(cd app && npm ci)", command: "npm ci", dir: "app", lockfile: "app/package-lock.json", alsoFound: [] },
      {
        line: "(cd app/companion-shell && npm ci)",
        command: "npm ci",
        dir: "app/companion-shell",
        lockfile: "app/companion-shell/package-lock.json",
        alsoFound: [],
      },
    ]);
  });

  it("renders as a [worktree] block for config.toml", () => {
    expect(proposalToml(detectWorktreeSetup(THIS_REPO))).toBe(
      '[worktree]\nsetup = [\n  "cargo fetch",\n  "(cd app && npm ci)",\n  "(cd app/companion-shell && npm ci)",\n]\n'
    );
  });
});

describe("the TOML block", () => {
  it("is empty for an empty proposal", () => {
    expect(proposalToml([])).toBe("");
  });

  it("escapes what a TOML basic string must", () => {
    const toml = proposalToml(detectWorktreeSetup(['we"ird\\dir/Cargo.lock']));
    // Backslashes were normalised to path separators before this point;
    // the quote survives, escaped.
    expect(toml).toContain(String.raw`"(cd 'we\"ird/dir' && cargo fetch)"`);
  });
});

describe("the proposal against what is declared", () => {
  const proposal = detectWorktreeSetup(["Cargo.lock", "app/package-lock.json"]);

  it("has nothing to say when nothing is declared or found", () => {
    expect(compareSetup([], [])).toEqual({ state: "none", missing: [] });
  });

  it("proposes the whole list when the key is absent", () => {
    expect(compareSetup([], proposal)).toEqual({ state: "propose", missing: proposal });
    expect(compareSetup(["  ", ""], proposal).state).toBe("propose");
  });

  it("matches when every proposed line is declared, in any order and with extras", () => {
    expect(compareSetup(["(cd app && npm ci)", "cargo fetch"], proposal)).toEqual({ state: "matches", missing: [] });
    expect(compareSetup(["cp .env.example .env", " cargo fetch ", "(cd app && npm ci)"], proposal).state).toBe("matches");
  });

  it("names only the proposed lines the declared value lacks", () => {
    const c = compareSetup(["cargo fetch", "cd app && npm install"], proposal);
    expect(c.state).toBe("differs");
    expect(c.missing.map((p) => p.line)).toEqual(["(cd app && npm ci)"]);
  });

  it("leaves a declared value alone when nothing is detected", () => {
    expect(compareSetup(["make deps"], [])).toEqual({ state: "declared", missing: [] });
  });
});

describe("the trust state beside the declared lines", () => {
  it("says there is no setup when none is declared, whatever the trust", () => {
    expect(declaredSetupStatus(0, { trusted: true, needsApproval: false })).toContain("No [worktree] setup is declared");
    expect(declaredSetupStatus(0, { trusted: false, needsApproval: true })).toContain("No [worktree] setup is declared");
  });

  it("says approved lines run, and unapproved ones are held back", () => {
    expect(declaredSetupStatus(2, { trusted: true, needsApproval: false })).toMatch(/^Approved: these run/);
    expect(declaredSetupStatus(1, { trusted: false, needsApproval: true })).toMatch(/^Not approved: gavin holds/);
  });
});

/// A fake host: a set of paths, listed the way `list_directory` answers
/// (directories first, case-insensitive name order — scanLockfiles
/// re-sorts, so the fake's order must not matter).
function fakeTree(
  files: string[],
  opts: { symlinks?: string[]; failing?: string[]; omitted?: Record<string, number> } = {}
): { list: DirLister; calls: string[] } {
  const calls: string[] = [];
  const list: DirLister = async (dir) => {
    calls.push(dir);
    if (opts.failing?.includes(dir)) throw new Error(`${dir}: permission denied`);
    const prefix = dir === "" ? "" : `${dir}/`;
    const children = new Map<string, boolean>();
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut === -1) children.set(rest, children.get(rest) ?? false);
      else children.set(rest.slice(0, cut), true);
    }
    const entries: DirListing["entries"] = [...children]
      .map(([name, isDir]) => ({ name, isDir, symlink: opts.symlinks?.includes(prefix + name) ?? false }))
      .reverse();
    return { entries, omitted: opts.omitted?.[dir] ?? 0 };
  };
  return { list, calls };
}

describe("walking the workspace folder", () => {
  it("finds this repository's lockfiles and nothing under the ignored folders", async () => {
    const { list, calls } = fakeTree(THIS_REPO);
    const scan = await scanLockfiles(list);
    expect(scan).toEqual({
      paths: ["Cargo.lock", "app/companion-shell/package-lock.json", "app/package-lock.json"],
      partial: false,
    });
    // Never opened: an ignored folder costs no round trip at all.
    expect(calls.some((c) => c.includes("node_modules") || c.startsWith(".") || c.startsWith("target"))).toBe(false);
  });

  it("does not follow symlinks", async () => {
    const { list, calls } = fakeTree(["linked/Cargo.lock", "real/Cargo.lock", "pkg-lock-link/package-lock.json"], {
      symlinks: ["linked", "pkg-lock-link/package-lock.json"],
    });
    expect((await scanLockfiles(list)).paths).toEqual(["real/Cargo.lock"]);
    expect(calls).not.toContain("linked");
  });

  it("stops at the depth limit and says the scan is partial", async () => {
    const { list } = fakeTree(["a/Cargo.lock", "a/b/c/Cargo.lock"]);
    expect(await scanLockfiles(list, { maxDepth: 2, maxDirs: 100 })).toEqual({ paths: ["a/Cargo.lock"], partial: true });
    expect(await scanLockfiles(list, { maxDepth: 3, maxDirs: 100 })).toEqual({
      paths: ["a/Cargo.lock", "a/b/c/Cargo.lock"],
      partial: false,
    });
  });

  it("stops at the directory budget, cutting the same folders every time", async () => {
    const files = ["Cargo.lock", "a/Cargo.lock", "b/Cargo.lock", "c/Cargo.lock"];
    const first = await scanLockfiles(fakeTree(files).list, { maxDepth: 4, maxDirs: 3 });
    expect(first).toEqual({ paths: ["Cargo.lock", "a/Cargo.lock", "b/Cargo.lock"], partial: true });
    expect(await scanLockfiles(fakeTree([...files].reverse()).list, { maxDepth: 4, maxDirs: 3 })).toEqual(first);
    expect(await scanLockfiles(fakeTree(files).list, { maxDepth: 4, maxDirs: 4 })).toEqual({
      paths: ["Cargo.lock", "a/Cargo.lock", "b/Cargo.lock", "c/Cargo.lock"],
      partial: false,
    });
  });

  it("marks a listing the host cut short as partial", async () => {
    const { list } = fakeTree(["Cargo.lock"], { omitted: { "": 12 } });
    expect(await scanLockfiles(list)).toEqual({ paths: ["Cargo.lock"], partial: true });
  });

  it("skips a subfolder it cannot read, and fails when the root cannot be read", async () => {
    const { list } = fakeTree(["Cargo.lock", "secret/package-lock.json"], { failing: ["secret"] });
    expect(await scanLockfiles(list)).toEqual({ paths: ["Cargo.lock"], partial: true });
    await expect(scanLockfiles(fakeTree([], { failing: [""] }).list)).rejects.toThrow("permission denied");
  });

  it("has defaults that reach this repository's deepest lockfile", () => {
    expect(DEFAULT_WALK_LIMITS.maxDepth).toBeGreaterThanOrEqual(2);
  });
});

describe("the workspace folder inside its checkout", () => {
  it("is the empty prefix when the workspace is the checkout", () => {
    expect(workspacePrefix("/r/gavin", "/r/gavin")).toBe("");
    expect(workspacePrefix("/r/gavin/", "/r/gavin")).toBe("");
  });

  it("is the package path for a monorepo opened at a package", () => {
    expect(workspacePrefix("/r/mono", "/r/mono/packages/web")).toBe("packages/web");
    expect(workspacePrefix("C:\\r\\mono", "C:\\r\\mono\\web")).toBe("web");
  });

  it("is null outside the checkout, for a sibling with a shared prefix, or with no checkout", () => {
    expect(workspacePrefix("/r/mono", "/r/other")).toBeNull();
    expect(workspacePrefix("/r/mono", "/r/mono-2")).toBeNull();
    expect(workspacePrefix(null, "/r/mono")).toBeNull();
    expect(workspacePrefix("", "/r/mono")).toBeNull();
  });

  it("re-roots found paths at the checkout", () => {
    expect(underPrefix(["package-lock.json"], "packages/web")).toEqual(["packages/web/package-lock.json"]);
    expect(underPrefix(["package-lock.json"], "")).toEqual(["package-lock.json"]);
  });
});

describe("the whole detection for a workspace", () => {
  it("builds lines against the checkout root for a package-folder workspace", async () => {
    const { list } = fakeTree(["package-lock.json", "node_modules/x/package-lock.json"]);
    const proposal = await proposeForWorkspace("/r/mono/packages/web", {
      list,
      gitRoot: async () => "/r/mono",
    });
    expect(proposal).toEqual({
      lines: [
        {
          line: "(cd packages/web && npm ci)",
          command: "npm ci",
          dir: "packages/web",
          lockfile: "packages/web/package-lock.json",
          alsoFound: [],
        },
      ],
      partial: false,
      rootedAtCheckout: true,
    });
  });

  it("falls back to the workspace folder, and says so, when there is no checkout to place it in", async () => {
    const { list } = fakeTree(["Cargo.lock"]);
    for (const gitRoot of [async () => null, async () => Promise.reject(new Error("not a repo"))]) {
      const proposal = await proposeForWorkspace("/r/loose", { list, gitRoot });
      expect(proposal.lines.map((l) => l.line)).toEqual(["cargo fetch"]);
      expect(proposal.rootedAtCheckout).toBe(false);
    }
  });

  it("never runs anything: its only I/O is the two reads it is handed", async () => {
    const seen: string[] = [];
    await proposeForWorkspace("/r/gavin", {
      list: async (dir) => {
        seen.push(`list:${dir}`);
        return { entries: [{ name: "Cargo.lock", isDir: false, symlink: false }], omitted: 0 };
      },
      gitRoot: async (root) => {
        seen.push(`git:${root}`);
        return root;
      },
    });
    expect(seen).toEqual(["git:/r/gavin", "list:"]);
  });
});

describe("the notes under the proposal", () => {
  const one = detectWorktreeSetup(["Cargo.lock"]);
  const two = detectWorktreeSetup(["Cargo.lock", "app/package-lock.json"]);

  it("says a proposal was not written, and that the gate still holds it", () => {
    const note = comparisonNote(compareSetup([], one));
    expect(note).toContain("not written");
    expect(note).toContain("holds it off until you approve");
  });

  it("points at the editor instead of the file once there is a writer", () => {
    const note = comparisonNote(compareSetup([], one), true);
    expect(note).toContain("not written");
    expect(note).toContain("Use proposal");
    expect(note).not.toContain("config.toml");
  });

  it("counts what the declared value lacks", () => {
    expect(comparisonNote(compareSetup(["make"], one))).toMatch(/^1 detected line is not in the declared setup/);
    expect(comparisonNote(compareSetup(["make"], two))).toMatch(/^2 detected lines are not in the declared setup/);
  });

  it("has a sentence for every state", () => {
    expect(comparisonNote(compareSetup([], []))).toContain("No lockfile found");
    expect(comparisonNote(compareSetup(["cargo fetch"], one))).toContain("already installs every lockfile");
    expect(comparisonNote(compareSetup(["make"], []))).toContain("The declared setup is yours");
  });

  it("names a partial scan and a folder outside any checkout, and nothing otherwise", () => {
    expect(proposalCaveats({ partial: false, rootedAtCheckout: true })).toEqual([]);
    const both = proposalCaveats({ partial: true, rootedAtCheckout: false });
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("stopped early");
    expect(both[1]).toContain("checkout root");
  });
});
