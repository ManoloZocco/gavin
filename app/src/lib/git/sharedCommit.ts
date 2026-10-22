// Committing a checkout other agents are still working in.
//
// "Commit via agent" (the Git tab) and the Commit changes rail tool
// (`builtin:commit`) both hand an agent the same instruction: commit the
// uncommitted work in this checkout. In a checkout nobody else is
// editing that is exactly right. In one where other agents are live it
// commits their half-written files under this run's message -- and the
// verdict then reads the tree, finds their next edits, and calls the
// run a failure for leaving them.
//
// So when other sessions are live in the checkout, the prompt narrows to
// what Consolidate repo already does (`builtin:consolidate-repo`): stage
// by naming paths, commit only this run's own files, and leave the rest
// uncommitted and listed. And the verdict stops counting the files it
// was told to leave.
//
// Pure. Which sessions are live, and which files each one touched, are
// read by `sharedCommitState.ts`.

/// What a commit run may take when it shares the checkout.
export interface SharedCommitScope {
  /// The other live sessions in the checkout, by name (card titles).
  /// Never empty: no peers means no scope at all (null).
  peers: string[];
  /// The files this commit may take, as `git status` names them (the
  /// repository root's relative paths), sorted. Null when that cannot be
  /// told -- a transcript gone, a host too old to ask -- and the agent
  /// has to judge by reading the diff, the way Consolidate repo does.
  ownPaths: string[] | null;
}

/// How many paths the prompt names before it stops naming them. A list
/// is only worth sending while the agent can read it; past this, the
/// prompt falls back to the judging rule, which is what an unreadable
/// list would turn into anyway. Also keeps a prompt that travels as one
/// argv entry well under the kernel's per-argument limit.
export const MAX_LISTED_PATHS = 200;

/// The files a commit may take.
///
/// - `dirty`: every changed path in the checkout right now.
/// - `ownTouched`: the files this run's own sessions touched, or null
///   when one of them cannot be read. Undefined means the commit belongs
///   to no run (the Git tab's button): everything that is not a peer's
///   is its own.
/// - `peerTouched`: per live peer, the files it touched, or null where
///   its transcript cannot be read.
///
/// A file a live peer touched is never this commit's, even when this run
/// touched it too: the peer may be halfway through an edit of it, and an
/// honest leftover beats a commit of somebody else's half-made change.
/// When a peer cannot be read, a run with its own list keeps that list
/// (it is still exactly the files this run wrote) while the Git tab's
/// button, which has only "everything else", cannot answer at all.
export function ownCommitPaths(
  dirty: readonly string[],
  ownTouched: readonly string[] | null | undefined,
  peerTouched: readonly (readonly string[] | null)[]
): string[] | null {
  if (ownTouched === null) return null;
  const peersKnown = peerTouched.every((p) => p !== null);
  if (ownTouched === undefined && !peersKnown) return null;
  const theirs = new Set(peerTouched.flatMap((p) => p ?? []));
  const mine = ownTouched === undefined ? null : new Set(ownTouched);
  const out = new Set<string>();
  for (const path of dirty) {
    if (theirs.has(path)) continue;
    if (mine && !mine.has(path)) continue;
    out.add(path);
  }
  return [...out].sort();
}

/// The scope, or null when nobody else is live in the checkout -- which
/// is what leaves the prompt and the verdict exactly as they were.
export function sharedCommitScope(peers: readonly string[], ownPaths: string[] | null): SharedCommitScope | null {
  if (peers.length === 0) return null;
  return { peers: [...peers], ownPaths };
}

/// The commit prompt for a shared checkout: the body the workspace
/// configured (overrides applied), with the staging rule appended. The
/// body's own steps still apply -- read the diff, group, conventional
/// subjects, never push -- this only narrows which files they apply to,
/// so an override keeps meaning what its author wrote.
///
/// Unchanged without a scope.
export function sharedCheckoutCommitPrompt(body: string, scope: SharedCommitScope | null): string {
  if (!scope || scope.peers.length === 0) return body;
  const who = scope.peers.join(", ");
  const lines = [
    `Other agents are working in this checkout right now (${who}). Their files may be ` +
      `half-written, so this commit must not take them.`,
    "",
    "- Stage each commit by naming its own paths (`git add <path> …`). Never `git add -A`, " +
      "`git add .` or `git commit -a`: they would sweep in work that is not this commit's.",
  ];
  const own = scope.ownPaths;
  if (own !== null && own.length === 0) {
    lines.push(
      "- None of the changes in this checkout are this commit's: every changed file is one " +
        "those agents are working on. Commit nothing, say so, and stop — that is a success, " +
        "not a problem."
    );
  } else if (own !== null && own.length <= MAX_LISTED_PATHS) {
    lines.push("- Commit only these files, and leave every other change alone:");
    for (const path of own) lines.push(`  - \`${path}\``);
    lines.push(
      "- Leave everything else UNCOMMITTED, and list it at the end. That is the right outcome " +
        "here, not a failure."
    );
  } else {
    lines.push(
      "- Commit only changes you can confidently attribute to finished work rather than to " +
        "those agents. Read the changed files where the diff alone does not say whose a change is.",
      "- Leave anything you cannot confidently attribute UNCOMMITTED, and list it at the end. " +
        "An honest leftover is a better outcome than a commit that takes another agent's work."
    );
  }
  return `${body.replace(/\s+$/, "")}\n\n${lines.join("\n")}`;
}

/// What a Commit via agent run turned out to have done.
///
/// `committed` carries `leftForPeers`: changes the run was told to leave
/// because other agents are working on them. A partial commit in a
/// shared checkout is the instruction followed, not a failure -- calling
/// it `left-dirty` would put a red banner over the one outcome the
/// prompt asked for.
export type CommitRunVerdict =
  | { kind: "stopped" }
  | { kind: "failed"; exitCode: number }
  | { kind: "left-dirty"; changes: number }
  | { kind: "committed"; leftForPeers: number };

/// The verdict on a finished run.
///
/// - Stopped by the human: no verdict on the work (the exit code is the
///   kill's).
/// - A non-zero exit: failed, whatever the tree says.
/// - A clean tree: committed.
/// - Alone in the checkout: whatever is left is left-dirty, as it always
///   was.
/// - Sharing it, with a known list: only this commit's OWN files still
///   dirty make it left-dirty; the rest is the peers'.
/// - Sharing it, without a list: nothing left is held against it -- the
///   agent was told to leave whatever it could not attribute.
export function judgeCommitRun(input: {
  exitCode: number;
  stopped: boolean;
  /// Every status entry still there after the run, by path: the unstaged
  /// list, then the staged one. A file in both appears twice, which is
  /// how the Git tab has always counted "changes" -- kept for the lone
  /// checkout so its banner says what it always said.
  left: readonly string[];
  scope: SharedCommitScope | null;
}): CommitRunVerdict {
  if (input.stopped) return { kind: "stopped" };
  if (input.exitCode !== 0) return { kind: "failed", exitCode: input.exitCode };
  if (input.left.length === 0) return { kind: "committed", leftForPeers: 0 };
  const scope = input.scope;
  if (!scope || scope.peers.length === 0) return { kind: "left-dirty", changes: input.left.length };
  const left = new Set(input.left);
  if (scope.ownPaths === null) return { kind: "committed", leftForPeers: left.size };
  const ownLeft = scope.ownPaths.filter((p) => left.has(p)).length;
  if (ownLeft > 0) return { kind: "left-dirty", changes: ownLeft };
  return { kind: "committed", leftForPeers: left.size };
}

/// The scope a finished run is judged under.
///
/// - `launched`: what the run was launched with. A scope wins outright --
///   it is what the agent was told. `null` means this window launched it
///   with nobody else live; `undefined` means the run was adopted from a
///   record (a restart, another window), which never stored one.
/// - `dirtyAtLaunch`: the changed paths when this window launched it.
/// - `peersNow`: who is live in the checkout at the verdict.
///
/// A run launched alone that finds peers at the end was told to commit
/// everything, and "everything" was the tree at launch: those files left
/// dirty are its failure, anything else is the newcomers'. An adopted run
/// with peers has no list to hold it to, and is judged as the agent was
/// told to judge.
export function scopeAtVerdict(
  launched: SharedCommitScope | null | undefined,
  dirtyAtLaunch: readonly string[] | null | undefined,
  peersNow: readonly string[]
): SharedCommitScope | null {
  if (launched) return launched;
  if (peersNow.length === 0) return null;
  const own = launched === null && dirtyAtLaunch ? [...new Set(dirtyAtLaunch)].sort() : null;
  return { peers: [...peersNow], ownPaths: own };
}
