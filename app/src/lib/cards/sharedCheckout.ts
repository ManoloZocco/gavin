// Several agents in ONE checkout: who already shares it, what a board
// launch says about that before it fires, and the worktrees that would
// give each launched card a checkout of its own.
//
// Board Run, Start all, Run all and Resume all launch in the workspace's
// own checkout (`launchCard` in cardRunActions.ts). That is the right
// default -- most cards are small and a worktree costs an install -- but
// it is also how two agents end up editing the same files at once, and
// the Start all confirm used to list titles and a memory estimate and say
// nothing about it. Only Best-of-N and the orchestration agent ever put a
// run in a worktree of its own.
//
// Nothing here BLOCKS a launch. The confirm gains a sentence and a second
// action; pressing the first one still does exactly what it always did.
// Measured, not predicted: whether a session shares the checkout is read
// off its binding's launch directory, the same test TypeSafe change
// attribution uses (`isInside` in changeAttribution.ts). Guessing which
// cards will collide from their text was tried and rejected
// (`docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`).
//
// Pure. The stores and git are read by the callers.

import type { CardSession } from "$lib/board/kanban";
import { isInside } from "$lib/cards/changeAttribution";
import { branchNameFrom, defaultWorktreePath, freeBranchNameFrom } from "$lib/git/git";
import { count } from "$lib/orchestration/railConfirm";

/// The second action's label, in the confirm and the selection bar alike.
export const OWN_WORKTREES_LABEL = "Each in its own worktree";

/// Every OTHER live card session launched in `root`'s checkout: the root
/// itself or any folder below it, but never one inside its
/// `.gavin-worktrees`, which are checkouts of their own.
///
/// `isLive` is the caller's (`cardSessionState(...) === "live"`), because
/// liveness is a fact about the layout, not about the binding. `exclude`
/// names card paths that are not peers of the question -- the cards a
/// rail is committing for, say. A binding with no launch directory falls
/// back to its `cwd`, exactly as `coTenants` does.
export function liveCheckoutPeers(
  root: string,
  bindings: readonly CardSession[],
  isLive: (binding: CardSession) => boolean,
  exclude: Iterable<string> = []
): CardSession[] {
  if (!root) return [];
  const skip = new Set(exclude);
  const seen = new Set<string>();
  return bindings.filter((b) => {
    if (skip.has(b.path) || seen.has(b.path)) return false;
    if (!isInside(b.launchCwd ?? b.cwd, root)) return false;
    if (!isLive(b)) return false;
    seen.add(b.path);
    return true;
  });
}

/// How a peer is named in a sentence: its card's title, else the card
/// file's name -- a card deleted under a live session is still a session
/// in the checkout, and saying nothing about it would undercount.
export function peerTitles(
  peers: readonly CardSession[],
  titleOf: (path: string) => string | null | undefined
): string[] {
  return peers.map((p) => titleOf(p.path)?.trim() || fileName(p.path));
}

/// The whole question a board confirm asks, in one call: who else is
/// live in the checkout at `root`, by name. Kept here rather than in the
/// column template so the column and the selection bar answer it the
/// same way and a test can argue with it.
export function checkoutShare(
  root: string | null | undefined,
  bindings: readonly CardSession[],
  isLive: (binding: CardSession) => boolean,
  titleOf: (path: string) => string | null | undefined
): { peers: string[] } {
  return { peers: peerTitles(liveCheckoutPeers(root ?? "", bindings, isLive), titleOf) };
}

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

/// The confirm's sentence about the checkout, or nothing when there is
/// nothing to say: no live peer and at most one card launching is the
/// ordinary single run, and a warning on every press would be noise the
/// human learns to skip.
///
/// `launching` counts the cards THIS press starts.
export function sharedCheckoutLines(peers: readonly string[], launching: number): string[] {
  const lines: string[] = [];
  if (peers.length > 0) {
    lines.push(
      `${count(peers.length, "agent")} already ${peers.length === 1 ? "works" : "work"} in this ` +
        `checkout: ${peers.join(", ")}.`
    );
  }
  if (checkoutWouldBeShared(peers.length, launching)) {
    const total = launching + peers.length;
    lines.push(
      `Started here, ${total} agents would edit one checkout at the same time — ` +
        `each sees the others' half-written files, and a commit can sweep them in.`
    );
  }
  return lines;
}

/// Whether the confirm should offer `OWN_WORKTREES_LABEL` at all: only
/// when the checkout would actually be shared.
export function checkoutWouldBeShared(peers: number, launching: number): boolean {
  return launching >= 2 || (launching >= 1 && peers > 0);
}

/// One card's own checkout, decided before anything is created: the
/// confirm is the human agreeing to these, so the launch uses them as
/// they are rather than deriving its own.
export interface OwnWorktreePlan {
  cardPath: string;
  branch: string;
  worktreePath: string;
}

/// A branch and a folder per card, named from the card's title the way
/// Best-of-N names its candidates (`planCandidates`): `defaultWorktreePath`
/// under the workspace's `.gavin-worktrees`, and `freeBranchNameFrom`
/// deduped against the repo's branches AND against each other as they are
/// produced, so two cards titled alike come out as `fix-login` and
/// `fix-login-2` rather than one name git refuses the second time.
///
/// A title with nothing legal in it falls back to `card`, the same way a
/// best-of-N run with no slug falls back to `run`.
export function planOwnWorktrees(
  cards: readonly { id: string; title: string }[],
  root: string,
  taken: Iterable<string>
): OwnWorktreePlan[] {
  const used = new Set(taken);
  return cards.map((card) => {
    const branch = freeBranchNameFrom(branchNameFrom(card.title) || "card", used);
    used.add(branch);
    return { cardPath: card.id, branch, worktreePath: defaultWorktreePath(root, branch) };
  });
}
