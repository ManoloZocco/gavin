// The card linter's findings per workspace, kept beside the tree and the
// board they are read from, so every surface that draws a card (the
// board, the rails, the archive grid, the detail modal) asks one place
// rather than linting the workspace once per card it renders.
//
// Recomputed only when that workspace's tree or board object changes:
// both stores replace a workspace's value wholesale on every push, so an
// identity check on the RAW store values (never on a `$state` proxy) is
// an honest "nothing changed".

import { derived } from "svelte/store";
import { gavinTrees } from "$lib/core/gavinState";
import { kanbanState } from "$lib/board/kanbanState";
import { lintCards, lintIndex, type LintIndex } from "$lib/board/cardLint";
import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/core/gavin";

const cache = new Map<string, { tree: GavinTree | undefined; board: Board | undefined; index: LintIndex }>();

export const cardLint = derived([gavinTrees, kanbanState], ([trees, boards]) => {
  const out: Record<string, LintIndex> = {};
  const ids = new Set([...Object.keys(trees), ...Object.keys(boards)]);
  // A closed workspace's entry would otherwise pin its whole tree.
  for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  for (const id of ids) {
    const tree = trees[id];
    const board = boards[id];
    const hit = cache.get(id);
    if (hit && hit.tree === tree && hit.board === board) {
      out[id] = hit.index;
      continue;
    }
    const index = lintIndex(lintCards({ tree, board }));
    cache.set(id, { tree, board, index });
    out[id] = index;
  }
  return out;
});
