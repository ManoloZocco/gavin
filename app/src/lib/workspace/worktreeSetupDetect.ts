/// A proposed `[worktree] setup`, read off the lockfiles a repository
/// already carries.
///
/// `[worktree] setup` stays inert until a human approves it through the
/// trust hash (`workspaceTrust.ts`), and for a long time nothing proposed
/// a value, so most workspaces cut worktrees with no install step and
/// every parallel agent starts in a checkout that does not build. Which install a checkout needs is not a
/// matter of taste: a `package-lock.json` means `npm ci`, a `Cargo.lock`
/// means `cargo fetch`. This module derives that list. It never runs
/// anything and never writes anything: what it returns is a PROPOSAL for
/// the human, and the trust gate still holds every line off until the
/// human approves the exact text.
///
/// How a line is executed decides how it is spelled. The declared lines
/// are joined with ` && ` into ONE line (`worktreeSetup.setupPlan`), the
/// agent command is chained onto its end, and the daemon runs the whole
/// thing as `sh -c` in the NEW WORKTREE'S ROOT — the git checkout `git
/// worktree add` made, which is the git toplevel, not necessarily the
/// workspace folder. So a nested package's install is written as a
/// subshell, `(cd app && npm ci)`: a bare `cd app && npm ci` would leave
/// every later line, and the agent itself, running inside `app/`.

/// One lockfile and the install it implies.
export interface LockfileRule {
  /// The file name, matched exactly (case-sensitive, as the tools are).
  lockfile: string;
  /// Lockfiles that answer the same question in one directory share an
  /// ecosystem, and a directory gets at most one command per ecosystem.
  /// A folder holding both `yarn.lock` and `package-lock.json` needs one
  /// install, not two package managers racing over one `node_modules`.
  ecosystem: "node" | "rust" | "python" | "ruby" | "go";
  /// The command, run in the lockfile's directory. Lockfile-respecting
  /// forms where the tool has one: a setup that silently re-resolves
  /// versions gives each worktree a different dependency tree.
  command: string;
}

/// The table, in precedence order: when one directory holds two
/// lockfiles of the same ecosystem, the EARLIER rule wins and the other
/// is reported beside it rather than dropped silently. pnpm, yarn and bun
/// come before npm because a stray `package-lock.json` is the one an
/// accidental `npm install` leaves behind in a repo that uses another
/// manager; the reverse accident is rare.
export const LOCKFILE_RULES: readonly LockfileRule[] = [
  { lockfile: "pnpm-lock.yaml", ecosystem: "node", command: "pnpm install --frozen-lockfile" },
  { lockfile: "yarn.lock", ecosystem: "node", command: "yarn install --frozen-lockfile" },
  { lockfile: "bun.lock", ecosystem: "node", command: "bun install --frozen-lockfile" },
  { lockfile: "bun.lockb", ecosystem: "node", command: "bun install --frozen-lockfile" },
  { lockfile: "package-lock.json", ecosystem: "node", command: "npm ci" },
  { lockfile: "Cargo.lock", ecosystem: "rust", command: "cargo fetch" },
  { lockfile: "uv.lock", ecosystem: "python", command: "uv sync" },
  { lockfile: "poetry.lock", ecosystem: "python", command: "poetry install" },
  { lockfile: "Gemfile.lock", ecosystem: "ruby", command: "bundle install" },
  { lockfile: "go.sum", ecosystem: "go", command: "go mod download" },
];

const RULE_BY_NAME = new Map(LOCKFILE_RULES.map((rule, i) => [rule.lockfile, { rule, rank: i }]));

/// Ecosystems in the order their commands appear within one directory.
const ECOSYSTEM_ORDER: readonly LockfileRule["ecosystem"][] = ["node", "rust", "python", "ruby", "go"];

/// Whether a lockfile of this name means anything here.
export function isLockfileName(name: string): boolean {
  return RULE_BY_NAME.has(name);
}

/// Folders whose lockfiles are not the repository's own: installed
/// dependencies (`node_modules`, `bower_components`, `Pods`), build
/// output (`target`), vendored trees (`vendor`, `third_party`), virtual
/// environments. A lockfile inside one is a dependency's, and installing
/// it would be work the real install already did — or, for a vendored
/// copy, work nobody asked for.
const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "target",
  "vendor",
  "third_party",
  "third-party",
  "venv",
  "__pycache__",
  "Pods",
]);

/// Every dot-folder is skipped as well. That covers `.git`, gavin's own
/// `.gavin-worktrees` (each a whole second checkout whose lockfiles are
/// this repo's again), `.claude/worktrees`, `.venv`, `.yarn` and the rest
/// of the tool caches — none of which holds a project a fresh worktree
/// has to install.
export function isIgnoredDir(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIR_NAMES.has(name);
}

/// One proposed `[worktree] setup` line and why it is there.
export interface ProposedSetupLine {
  /// Exactly what would go into `[worktree] setup`.
  line: string;
  /// The bare install command, without the directory change.
  command: string;
  /// The directory it runs in, relative to the worktree root; "" for the
  /// root itself.
  dir: string;
  /// The lockfile that justifies the line, relative to the worktree root.
  lockfile: string;
  /// Other lockfiles of the same ecosystem in the same directory, which
  /// did NOT produce a command. Shown so a human can see the choice that
  /// was made for them; empty in the ordinary case.
  alsoFound: string[];
}

/// A path as this module compares it: forward slashes, no `./` prefix,
/// no leading or trailing slash. Paths that climb out (`..`) or are
/// absolute are not repo-relative and are dropped by the caller.
function normalise(path: string): string | null {
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/")) return null;
  const parts = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  if (/^[A-Za-z]:$/.test(parts[0])) return null;
  return parts.join("/");
}

/// Characters a POSIX shell takes literally in a word. Anything else and
/// the directory is single-quoted.
const SHELL_SAFE = /^[A-Za-z0-9_./@%+=:,-]+$/;

function shellWord(word: string): string {
  if (SHELL_SAFE.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/// The `[worktree] setup` line that runs `command` in `dir`.
///
/// A subshell, because the lines are `&&`-joined into one `sh -c` with
/// the agent chained last: a bare `cd` would move every line after it.
/// A directory that begins with `-` gets a `./` so `cd` cannot read it as
/// an option.
export function setupLineFor(dir: string, command: string): string {
  if (dir === "") return command;
  const target = dir.startsWith("-") ? `./${dir}` : dir;
  return `(cd ${shellWord(target)} && ${command})`;
}

function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/// Root first, then shallower before deeper, then by name — so the
/// repository's own install leads and the order never depends on the
/// order the paths arrived in.
function compareDirs(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  const da = a.split("/").length;
  const db = b.split("/").length;
  if (da !== db) return da - db;
  return a < b ? -1 : 1;
}

/// The proposal for a set of repository paths, relative to the root a
/// new worktree's setup runs in. Paths that are not lockfiles, sit in an
/// ignored folder, or are not repo-relative are ignored; duplicates count
/// once. Deterministic: the same set in any order gives the same list.
export function detectWorktreeSetup(paths: readonly string[]): ProposedSetupLine[] {
  // dir -> ecosystem -> lockfiles found there, by precedence.
  const found = new Map<string, Map<LockfileRule["ecosystem"], { rule: LockfileRule; rank: number; path: string }[]>>();
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = normalise(raw);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    const entry = RULE_BY_NAME.get(baseName(path));
    if (!entry) continue;
    const dir = parentDir(path);
    if (dir !== "" && dir.split("/").some(isIgnoredDir)) continue;
    let byEco = found.get(dir);
    if (!byEco) found.set(dir, (byEco = new Map()));
    const list = byEco.get(entry.rule.ecosystem) ?? [];
    list.push({ ...entry, path });
    byEco.set(entry.rule.ecosystem, list);
  }

  const out: ProposedSetupLine[] = [];
  for (const dir of [...found.keys()].sort(compareDirs)) {
    const byEco = found.get(dir)!;
    for (const eco of ECOSYSTEM_ORDER) {
      const list = byEco.get(eco);
      if (!list) continue;
      list.sort((a, b) => a.rank - b.rank);
      const [winner, ...rest] = list;
      out.push({
        line: setupLineFor(dir, winner.rule.command),
        command: winner.rule.command,
        dir,
        lockfile: winner.path,
        alsoFound: rest.map((r) => r.path),
      });
    }
  }
  return out;
}

/// One proposal line's reason, in words: the lockfile that put it there,
/// and any sibling lockfile it chose over.
export function proposalReason(p: ProposedSetupLine): string {
  const base = `${p.lockfile} is here`;
  if (p.alsoFound.length === 0) return base;
  return `${base} (also found ${p.alsoFound.join(", ")}, not used)`;
}

/// The proposal as a `[worktree]` block for `.gavin-root/config.toml`.
/// TOML basic strings share JSON's escapes for every character a setup
/// line can carry, so JSON.stringify spells each one correctly.
export function proposalToml(proposal: readonly ProposedSetupLine[]): string {
  if (proposal.length === 0) return "";
  const items = proposal.map((p) => `  ${JSON.stringify(p.line)},`).join("\n");
  return `[worktree]\nsetup = [\n${items}\n]\n`;
}

/// How the declared `[worktree] setup` stands against the proposal.
///
/// - `none`: nothing declared and nothing detected.
/// - `propose`: nothing declared; the proposal is what the key would be.
/// - `matches`: every proposed line is already declared.
/// - `differs`: lines are declared, and some proposed line is not among
///   them. The declared value is the human's; it is shown beside the
///   proposal, never replaced.
/// - `declared`: lines are declared and nothing was detected.
export type SetupComparisonState = "none" | "propose" | "matches" | "differs" | "declared";

export interface SetupComparison {
  state: SetupComparisonState;
  /// Proposed lines that are not among the declared ones, in proposal
  /// order. Every proposed line when nothing is declared.
  missing: ProposedSetupLine[];
}

export function compareSetup(
  declared: readonly string[],
  proposal: readonly ProposedSetupLine[]
): SetupComparison {
  const current = new Set(declared.map((l) => l.trim()).filter((l) => l !== ""));
  const missing = proposal.filter((p) => !current.has(p.line));
  if (current.size === 0) return { state: proposal.length === 0 ? "none" : "propose", missing };
  if (proposal.length === 0) return { state: "declared", missing };
  return { state: missing.length === 0 ? "matches" : "differs", missing };
}

/// The sentence under the proposal: what it is against the declared
/// value, and that nothing was written.
///
/// `editable` says whether the Settings editor can write the key (a v80
/// daemon, `worktreeSetupEditor.ts`): then the way in is "Use proposal"
/// and Save. Against an older daemon there is no writer, so the way in is
/// the human pasting the block — after which the trust gate asks for the
/// same approval any other edit to the file would.
export function comparisonNote(c: SetupComparison, editable = false): string {
  switch (c.state) {
    case "none":
      return "No lockfile found that gavin knows an install for.";
    case "propose":
      return editable
        ? "Proposed from this repo's lockfiles, not written. Use proposal fills the editor; nothing is written until you save."
        : "Proposed from this repo's lockfiles, not written. Add it to .gavin-root/config.toml; " +
            "gavin holds it off until you approve it.";
    case "matches":
      return "The declared setup already installs every lockfile found.";
    case "differs": {
      const n = c.missing.length;
      return `${n === 1 ? "1 detected line is" : `${n} detected lines are`} not in the declared setup, marked below. Your value is left as it is.`;
    }
    case "declared":
      return "No lockfile found that gavin knows an install for. The declared setup is yours.";
  }
}

/// Caveats on HOW the proposal was read, beside what it says.
export function proposalCaveats(p: Pick<SetupProposal, "partial" | "rootedAtCheckout">): string[] {
  const out: string[] = [];
  if (p.partial) {
    out.push("The scan stopped early (a depth or folder limit), so a lockfile deeper in the tree may be missing.");
  }
  if (!p.rootedAtCheckout) {
    out.push(
      "This folder could not be placed inside a git checkout, so the lines are relative to the workspace folder — " +
        "a worktree's setup runs at its checkout root."
    );
  }
  return out;
}

/// What the declared lines do today, given the workspace-trust verdict
/// for this config (`ConfigTrust` in layoutState.ts). The trust gate is
/// one decision over all three execution keys, so "not approved" here
/// can be the `[agent]` keys' doing as much as the setup's.
export function declaredSetupStatus(
  declaredCount: number,
  trust: { trusted: boolean; needsApproval: boolean }
): string {
  if (declaredCount === 0) {
    return "No [worktree] setup is declared: a new worktree starts with nothing installed.";
  }
  if (trust.trusted) {
    return "Approved: these run in every new worktree, before its agent starts.";
  }
  return "Not approved: gavin holds these back until you approve this repo's config.toml commands.";
}

// ---- reading the repository ------------------------------------------------

/// One directory listing, the shape `backend.listDirectory` answers.
export interface DirListing {
  entries: { name: string; isDir: boolean; symlink: boolean }[];
  omitted: number;
}

/// Lists a directory given its path relative to the walk's root ("" for
/// the root). Injected so the walk is tested without a host.
export type DirLister = (relDir: string) => Promise<DirListing>;

export interface WalkLimits {
  /// How many directory levels below the root to open. A lockfile at
  /// `packages/web/package-lock.json` is two levels down.
  maxDepth: number;
  /// How many directories to list in all, the root included. Each is a
  /// host round trip; a repository that needs more than this has its
  /// installs declared by hand.
  maxDirs: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = { maxDepth: 4, maxDirs: 400 };

export interface LockfileScan {
  /// Lockfile paths relative to the walk's root, sorted.
  paths: string[];
  /// Whether the walk stopped short — a budget ran out or the host cut a
  /// listing — so a lockfile may exist that the proposal does not name.
  partial: boolean;
}

/// Walks the tree breadth-first for lockfiles, skipping ignored folders
/// and symlinks (the host does not follow them either). Siblings are
/// visited in name order so the budget always cuts the same directories.
/// A subdirectory that cannot be listed is skipped and marks the scan
/// partial; the ROOT failing to list is an error for the caller.
export async function scanLockfiles(list: DirLister, limits: WalkLimits = DEFAULT_WALK_LIMITS): Promise<LockfileScan> {
  const paths: string[] = [];
  let partial = false;
  let listed = 0;
  let queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
  while (queue.length > 0) {
    const next: { dir: string; depth: number }[] = [];
    for (const { dir, depth } of queue) {
      if (listed >= limits.maxDirs) {
        partial = true;
        break;
      }
      listed += 1;
      let listing: DirListing;
      try {
        listing = await list(dir);
      } catch (e) {
        if (dir === "") throw e;
        partial = true;
        continue;
      }
      if (listing.omitted > 0) partial = true;
      const entries = [...listing.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.symlink) continue;
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDir) {
          if (isIgnoredDir(entry.name)) continue;
          if (depth + 1 > limits.maxDepth) {
            partial = true;
            continue;
          }
          next.push({ dir: path, depth: depth + 1 });
        } else if (isLockfileName(entry.name)) {
          paths.push(path);
        }
      }
    }
    if (listed >= limits.maxDirs && next.length > 0) partial = true;
    queue = listed >= limits.maxDirs ? [] : next;
  }
  paths.sort();
  return { paths, partial };
}

/// Where the workspace folder sits inside its git checkout, as a prefix
/// for paths found under it: "" when the workspace IS the checkout root,
/// `packages/web` for a monorepo opened at a package folder, null when
/// the workspace is not under that root at all (or there is no root).
///
/// Needed because setup runs at the NEW WORKTREE'S root — the git
/// toplevel — while the walk starts at the workspace folder.
export function workspacePrefix(gitRoot: string | null, workspaceRoot: string): string | null {
  if (!gitRoot) return null;
  const git = gitRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const ws = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (ws === git) return "";
  if (!ws.startsWith(`${git}/`)) return null;
  return ws.slice(git.length + 1);
}

/// Paths found under the workspace folder, re-rooted at the checkout.
export function underPrefix(paths: readonly string[], prefix: string): string[] {
  return prefix === "" ? [...paths] : paths.map((p) => `${prefix}/${p}`);
}

/// What the Settings panel shows, in one answer.
export interface SetupProposal {
  lines: ProposedSetupLine[];
  partial: boolean;
  /// False when the workspace folder could not be placed inside its git
  /// checkout, so the lines are relative to the workspace folder and may
  /// not be where a worktree's setup actually runs.
  rootedAtCheckout: boolean;
}

/// The whole detection for one workspace: find the checkout root, walk
/// the workspace folder, and build the proposal against the checkout
/// root. Reads only; runs nothing.
export async function proposeForWorkspace(
  workspaceRoot: string,
  deps: { list: DirLister; gitRoot: (workspaceRoot: string) => Promise<string | null> },
  limits: WalkLimits = DEFAULT_WALK_LIMITS
): Promise<SetupProposal> {
  let gitRoot: string | null = null;
  try {
    gitRoot = await deps.gitRoot(workspaceRoot);
  } catch {
    gitRoot = null;
  }
  const scan = await scanLockfiles(deps.list, limits);
  const prefix = workspacePrefix(gitRoot, workspaceRoot);
  return {
    lines: detectWorktreeSetup(underPrefix(scan.paths, prefix ?? "")),
    partial: scan.partial,
    rootedAtCheckout: prefix !== null,
  };
}
