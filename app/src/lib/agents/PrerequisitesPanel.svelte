<script lang="ts">
  // Settings' Prerequisites panel (lc-09): every line of the host's
  // check, with what needs it and what fixes it. The logic is
  // prerequisites.ts's; this is the template over it.
  import { agentDefaultsStore, layoutState } from "$lib/core/layoutState";
  import { chainForPrimary } from "$lib/agents/agentFallback";
  import { effectiveDefaultAgent } from "$lib/cards/complexity";
  import { ensureHeadroomReading, headroomReading } from "$lib/agents/headroomState";
  import { loadPlaywrightMark } from "$lib/agents/playwrightSetup";
  import {
    agentsInUse,
    headroomNeedsUv,
    isProblem,
    preflightStateLabel,
    prerequisiteLines,
  } from "$lib/agents/prerequisites";
  import {
    ensurePreflight,
    preflightChecking,
    preflightItems,
    preflightReading,
    refreshPreflight,
  } from "$lib/agents/preflightState";

  ensurePreflight();
  ensureHeadroomReading();

  // App-wide, so "needed" is what the app-wide defaults run and what any
  // workspace has set up: the default agent and its fallback chain, a
  // Playwright any local workspace said it installed, a Headroom that is
  // wanted and not installed.
  const defaultAgent = $derived(effectiveDefaultAgent($agentDefaultsStore));
  const needs = $derived({
    playwright: $layoutState.workspaces.some(
      (w) => w.rootPath && !w.ssh && loadPlaywrightMark(w.rootPath) === "installed"
    ),
    headroomInstall: headroomNeedsUv($headroomReading),
    agents: agentsInUse(defaultAgent, chainForPrimary($agentDefaultsStore.fallbackChains, defaultAgent)),
  });
  const lines = $derived(prerequisiteLines(preflightItems($preflightReading), needs));
</script>

<p class="hint">
  What gavin's features run on this machine, checked once per window. Agent CLIs are started with
  <code>--version</code>, so one that is installed but broken shows here before a Run finds it.
  gavin installs none of these.
</p>

{#if $preflightReading === undefined}
  <p class="hint">Checking…</p>
{:else if $preflightReading.kind === "error"}
  <p class="hint warn">Couldn't run the check: {$preflightReading.message}</p>
{:else}
  <ul class="lines">
    {#each lines as line (line.id)}
      <li class:problem={isProblem(line.state)} class:ok={line.state === "ok"}>
        <span class="label">{line.label}</span>
        <span class="state">{preflightStateLabel(line.state)}</span>
        {#if line.detail}
          <span class="detail">{line.detail}</span>
        {/if}
        {#if line.neededBy}
          <span class="needed">needed by {line.neededBy}</span>
        {/if}
        {#if line.fixHint && line.state !== "ok"}
          <span class="fix">{line.fixHint}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<div class="row">
  <button
    type="button"
    class="manage"
    disabled={$preflightChecking}
    onclick={() => void refreshPreflight()}
  >
    {$preflightChecking ? "Checking…" : "Check again"}
  </button>
</div>

<style>
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .warn {
    color: var(--warning-text);
  }
  .lines {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    font-family: monospace;
    font-size: 0.85em;
  }
  .lines li {
    display: grid;
    grid-template-columns: minmax(9em, max-content) 1fr;
    gap: 2px 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .label {
    color: var(--text);
  }
  .state {
    color: var(--text-subtle);
  }
  .ok .state {
    color: var(--success-text);
  }
  .problem .state {
    color: var(--warning-text);
  }
  .detail,
  .needed,
  .fix {
    grid-column: 2;
    color: var(--text-subtle);
    overflow-wrap: anywhere;
  }
  .fix {
    color: var(--text-muted);
  }
  .row {
    display: flex;
    margin-top: 10px;
  }
  .manage {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 3px 8px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .manage:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
