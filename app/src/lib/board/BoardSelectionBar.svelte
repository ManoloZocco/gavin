<script lang="ts">
  // Pops in over the board while a shift+click selection stands
  // (boardSelection.ts). "Run selected" is the column's Run all with a
  // different set: same sequential spawn, same unbound-only rule, but
  // over the picked cards -- which may sit in any column, or nested
  // inside a plan.
  import type { CardView } from "$lib/core/planBoard";
  import { Play, X } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { kanbanState, cardSessionFor } from "$lib/board/kanbanState";
  import {
    boardSelection,
    clearBoardSelection,
    runnableSelection,
    selectedCards,
    selectionRunConfirm,
  } from "$lib/board/boardSelection";
  import ConfirmPrompt from "$lib/core/ConfirmPrompt.svelte";
  import { estimateFor, launchGateVerdict } from "$lib/agents/launchQueue";
  import { gavinTrees } from "$lib/core/gavinState";
  import { layoutState } from "$lib/core/layoutState";
  import { cardSessionState } from "$lib/board/columnRunAction";
  import { checkoutShare } from "$lib/cards/sharedCheckout";

  interface Props {
    workspaceId: string;
    /// Every card this surface renders, nested children included. The
    /// selection is app-wide, so the intersection with THIS projection
    /// is what the bar reports and runs.
    allCards: CardView[];
    onRunCard: (card: CardView) => void | Promise<void>;
    /// "Each in its own worktree" -- see KanbanColumn's prop of the same
    /// name. Absent, the confirm offers only the ordinary Run.
    onRunInOwnWorktrees?: ((cards: CardView[]) => void | Promise<void>) | null;
  }
  let { workspaceId, allCards, onRunCard, onRunInOwnWorktrees = null }: Props = $props();

  const picked = $derived(selectedCards(allCards, $boardSelection));
  const runnable = $derived(
    runnableSelection(picked, (id) => cardSessionFor($kanbanState[workspaceId], id) !== null)
  );

  let running = $state(false);

  // Who already works in the checkout the selection would launch into
  // (sharedCheckout.ts) -- the workspace root, where every board Run goes.
  const share = $derived(
    checkoutShare(
      $gavinTrees[workspaceId]?.rootMissing ? null : $gavinTrees[workspaceId]?.rootPath,
      $kanbanState[workspaceId]?.cardSessions ?? [],
      (b) => cardSessionState($layoutState, b) === "live",
      (path) => allCards.find((c) => c.id === path)?.title
    )
  );

  // Asks first: a selection can span every column on the board, so this
  // is the one press here with no upper bound at all -- and the number
  // that stops eleven agents is the one the dialog carries. Held as a
  // bare flag rather than a captured list, the same reason the column's
  // own Run all does: a selection that changes under the open prompt
  // re-derives through `runnable` and closes on its own once there is
  // nothing left to run.
  let runPrompt = $state(false);
  // The estimate rides `$launchGateVerdict` so the projection keeps up
  // while the prompt is open.
  const runContent = $derived.by(() => {
    // Read so this derivation depends on it; see OrchestrationHubView.
    void $launchGateVerdict;
    if (!runPrompt || runnable.length === 0) return null;
    return selectionRunConfirm(runnable, estimateFor(workspaceId, runnable.length), share);
  });

  async function runSelected(): Promise<void> {
    runPrompt = false;
    if (running || runnable.length === 0) return;
    running = true;
    try {
      // Snapshot first: every spawn binds its card, which shrinks
      // `runnable` under the loop's feet.
      const targets = [...runnable];
      for (const card of targets) {
        await onRunCard(card);
      }
    } finally {
      running = false;
    }
    // They all hold a session now; keeping them picked would only offer
    // a Run that can no longer run anything.
    clearBoardSelection();
  }

  // The confirm's second action: the same cards, each in a worktree of
  // its own.
  async function runSelectedInOwnWorktrees(): Promise<void> {
    runPrompt = false;
    if (running || runnable.length === 0 || !onRunInOwnWorktrees) return;
    running = true;
    try {
      await onRunInOwnWorktrees([...runnable]);
    } finally {
      running = false;
    }
    clearBoardSelection();
  }

  // Esc drops the selection, the same way it cancels a drag. Attached
  // unconditionally: clearing an empty selection is a no-op, and this
  // way the key works wherever the pointer sits on the board.
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") clearBoardSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if runContent}
  <ConfirmPrompt
    title={runContent.title}
    lines={runContent.lines}
    choices={[
      { label: runContent.confirmLabel, onPick: () => void runSelected() },
      ...(runContent.worktreeLabel && onRunInOwnWorktrees
        ? [{ label: runContent.worktreeLabel, onPick: () => void runSelectedInOwnWorktrees() }]
        : []),
    ]}
    onCancel={() => (runPrompt = false)}
  />
{/if}

{#if picked.length > 0}
  <div class="selection-bar" role="toolbar" aria-label="Selected cards">
    <span class="count">{picked.length} selected</span>
    <IconButton
      icon={Play}
      label="Run selected cards"
      text="Run selected"
      tone="accent"
      variant="outlined"
      size={11}
      disabled={running || runnable.length === 0}
      tip={runnable.length === 0
        ? "Nothing here can run — notes aren't runnable, and the rest already have a session"
        : `Run ${runnable.length} unbound ${runnable.length === 1 ? "card" : "cards"}, one after another`}
      onclick={() => (runPrompt = true)}
    >
      <span class="run-count">{runnable.length}</span>
    </IconButton>
    <IconButton
      icon={X}
      label="Clear selection"
      size={12}
      tip="Clear the selection (Esc)"
      onclick={clearBoardSelection}
    />
  </div>
{/if}

<style>
  /* Floats over the column strip, anchored to the board surface's
     positioned root -- never inside the scrolling strip, or it would
     slide away with the columns. */
  .selection-bar {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
    white-space: nowrap;
  }
  .count {
    color: var(--text-muted);
  }
  .run-count {
    font-size: 0.75em;
    font-family: monospace;
  }
</style>
