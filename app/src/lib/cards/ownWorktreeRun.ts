// "Each in its own worktree": the side-effecting half of sharedCheckout.ts.
//
// The board's Start all / Run all and the selection bar's Run selected
// offer it when their press would put two or more agents in one checkout
// (or one beside an agent already there). Each card then gets a branch
// and a folder of its own, named the way Best-of-N names its candidates,
// and runs through the ordinary board Run -- the same gates, the same
// review sheet, the same launch wall, the same binding -- with only its
// checkout changed (`runCard`'s `worktree`). The worktree itself is cut
// inside that launch, after every gate, so a card the human declines at
// its review sheet leaves no folder behind.

import { get } from "svelte/store";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { DESK_LAUNCH_HOST, runCard } from "$lib/cards/cardRunActions";
import { forkBase } from "$lib/cards/bestOfN";
import { planOwnWorktrees } from "$lib/cards/sharedCheckout";
import { ensureGitView, gitStore, refresh, rootPathOf } from "$lib/git/gitState";
import { worktreesAnchor } from "$lib/git/git";
import { sshLimitation } from "$lib/workspace/sshWorkspace";
import type { CardView } from "$lib/core/planBoard";

export const NOT_A_REPOSITORY =
  "This workspace is not a git repository, so there is nowhere to fork worktrees from.";
export const NO_BRANCH_LIST = "Couldn't read this repository's branches, so no worktree was cut";

/// Runs every card in a worktree of its own, one after another, and
/// answers with the first refusal (for the board's error strip) or null.
///
/// One refusal does not stop the rest: the cards are independent, and a
/// card whose review the human declined is no reason to withhold the
/// other five. The refusal reported is the first, because the strip has
/// room for one sentence.
export async function runCardsInOwnWorktrees(
  workspaceId: string,
  cards: readonly CardView[]
): Promise<string | null> {
  if (cards.length === 0) return null;
  // The worktrees are cut by THIS machine's git whatever the host's
  // daemon can do, so a remote workspace refuses the whole press, as a
  // best-of-N run does.
  const remote = sshLimitation(get(layoutState).workspaces.find((w) => w.id === workspaceId));
  if (remote) return remote;

  const tree = get(gavinTrees)[workspaceId];
  const gavinRoot = tree && !tree.rootMissing ? tree.rootPath : "";
  // A view this window never opened is made on the workspace root. One
  // that exists is left where it is: re-pointing it would abandon a
  // commit run it is watching, and `git worktree add` answers the same
  // from any checkout of the repository -- the fork base is named below.
  if (!get(gitStore)[workspaceId]) {
    if (!gavinRoot) return NOT_A_REPOSITORY;
    ensureGitView(workspaceId, gavinRoot);
  }
  // Read fresh: the branch list is what keeps a name from being one git
  // already has, and the one on screen may be minutes old.
  await refresh(workspaceId);
  const view = get(gitStore)[workspaceId];
  if (!view || view.repo?.notARepo) return NOT_A_REPOSITORY;
  if (!view.refs) return NO_BRANCH_LIST;

  const plans = planOwnWorktrees(
    cards,
    worktreesAnchor(gavinRoot, rootPathOf(view)),
    view.refs.branches.map((b) => b.name)
  );
  // Every card forks from the trunk the workspace is checked out on, not
  // from whatever checkout the Git tab is pointed at (`forkBase`).
  const from = forkBase(view.refs.worktrees).ref;

  let first: string | null = null;
  for (const [i, card] of cards.entries()) {
    const plan = plans[i];
    const err = await runCard(workspaceId, card, DESK_LAUNCH_HOST, {
      path: plan.worktreePath,
      branch: plan.branch,
      from,
    });
    if (err && first === null) first = err;
  }
  return first;
}
