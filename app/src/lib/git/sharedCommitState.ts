// The reads behind sharedCommit.ts: who is live in a checkout, and which
// of its changed files each of them touched.
//
// "Touched" is the transcript reader's answer (`cardRunTouchedFiles`,
// with the shell-write hook's records where the daemon keeps them) -- the
// same one the Review tab and a run's Changes view use, so a commit and
// the views a human checks it against cannot disagree about whose a file
// is. Every read that fails comes back null, which the pure half turns
// into "judge by reading the diff", never into "nobody's".

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import type { CardSession } from "$lib/board/kanban";
import { kanbanState } from "$lib/board/kanbanState";
import { layoutState } from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { sessionLiveness } from "$lib/core/workspace";
import { cardViewForPath } from "$lib/core/planBoard";
import { liveCheckoutPeers, peerTitles } from "$lib/cards/sharedCheckout";
import { shellWritesFor } from "$lib/cards/transcriptNarrow";
import {
  ownCommitPaths,
  sharedCheckoutCommitPrompt,
  sharedCommitScope,
  type SharedCommitScope,
} from "$lib/git/sharedCommit";

/// Every live card session in the checkout at `root` except the cards in
/// `exclude`. `sessionLiveness` rather than the board's
/// `cardSessionState`: they are one rule (that one is a switch over this),
/// and this module is loaded by the Git tab, which has no business
/// pulling the board's column vocabulary in with it.
export function livePeersInCheckout(
  workspaceId: string,
  root: string,
  exclude: Iterable<string> = []
): CardSession[] {
  const layout = get(layoutState);
  return liveCheckoutPeers(
    root,
    get(kanbanState)[workspaceId]?.cardSessions ?? [],
    (b) => sessionLiveness(layout, b.sessionId) === "live",
    exclude
  );
}

/// Which of `candidates` one run touched, or null when that cannot be
/// read: no conversation id, a transcript gone, a host too old to ask.
async function touchedBy(
  workspaceId: string,
  run: Pick<CardSession, "conversationId" | "launchCwd" | "cwd">,
  root: string,
  candidates: string[]
): Promise<string[] | null> {
  if (!run.conversationId) return null;
  if (candidates.length === 0) return [];
  try {
    const observed = await shellWritesFor(workspaceId, run.conversationId);
    const report = await backend.cardRunTouchedFiles(
      run.conversationId,
      run.launchCwd ?? run.cwd,
      root,
      candidates,
      observed
    );
    return report.kind === "ready" ? report.paths : null;
  } catch {
    return null;
  }
}

/// The scope a commit in `root`'s checkout runs under, or null when no
/// other session is live there -- the common case, answered from the
/// stores alone, with no request made.
///
/// `dirty` is every changed path as `git status` names it, relative to
/// `root`, which must be the repository root git reports
/// (`RepoInfo.root`): that is what the transcript reader resolves against.
///
/// `ownCards` names the cards whose work this commit is FOR -- a rail's
/// card steps, for its Commit changes step. Their sessions are not peers,
/// and the files they touched are the commit's. Absent (the Git tab's
/// button), the commit is everything no live peer touched. A rail with
/// no card session to read has no list, and its agent judges by reading.
export async function commitScopeFor(
  workspaceId: string,
  root: string,
  dirty: string[],
  ownCards?: readonly string[]
): Promise<SharedCommitScope | null> {
  const peers = livePeersInCheckout(workspaceId, root, ownCards ?? []);
  if (peers.length === 0) return null;
  const tree = get(gavinTrees)[workspaceId];
  const names = peerTitles(peers, (path) => cardViewForPath(tree, path)?.title);

  const peerTouched = await Promise.all(peers.map((p) => touchedBy(workspaceId, p, root, dirty)));
  let ownTouched: string[] | null | undefined;
  if (ownCards !== undefined) {
    const board = get(kanbanState)[workspaceId];
    const runs = ownCards
      .map((path) => board?.cardSessions.find((b) => b.path === path) ?? null)
      .filter((b): b is CardSession => b !== null);
    if (runs.length === 0) {
      ownTouched = null;
    } else {
      const each = await Promise.all(runs.map((r) => touchedBy(workspaceId, r, root, dirty)));
      ownTouched = each.some((t) => t === null) ? null : each.flatMap((t) => t ?? []);
    }
  }
  return sharedCommitScope(names, ownCommitPaths(dirty, ownTouched, peerTouched));
}

/// The Commit changes rail tool's body for the checkout a step runs in:
/// unchanged unless another session is live there, and then narrowed to
/// the rail's own cards' files (`sharedCheckoutCommitPrompt`).
///
/// Never a reason to stall a step. A read that fails sends the body as
/// it was -- today's prompt -- because a rail that stopped on a commit
/// step for want of a transcript would be a worse outcome than the one
/// this exists to prevent.
export async function commitBodyForCheckout(
  workspaceId: string,
  cwd: string,
  body: string,
  ownCards: readonly string[]
): Promise<string> {
  // The stores first, so a checkout nobody else is in asks git nothing.
  if (livePeersInCheckout(workspaceId, cwd, ownCards).length === 0) return body;
  try {
    const repo = await backend.gitRepoInfo(cwd);
    if (repo.notARepo || !repo.root) return body;
    const status = await backend.gitStatus(cwd);
    const dirty = [...new Set([...status.unstaged, ...status.staged].map((f) => f.path))];
    return sharedCheckoutCommitPrompt(body, await commitScopeFor(workspaceId, repo.root, dirty, ownCards));
  } catch {
    return body;
  }
}
