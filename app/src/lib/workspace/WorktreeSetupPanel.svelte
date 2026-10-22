<script lang="ts">
  /// `[worktree] setup` in the workspace Settings: what is declared, what
  /// the trust gate does with it, and what this repo's lockfiles say it
  /// should be. A thin template over `worktreeSetupDetect.ts`.
  ///
  /// Read-only on purpose. The proposal is never written and never run:
  /// the daemon's config writer does not accept this key yet, and even
  /// once it does, a line lands inert until the human approves it through
  /// the same trust sheet every other config.toml command goes through.
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import * as backend from "$lib/core/backend";
  import { worktreeSetups } from "$lib/core/gavinState";
  import { configTrusts } from "$lib/core/layoutState";
  import ConfigTrustNotice from "$lib/workspace/ConfigTrustNotice.svelte";
  import {
    compareSetup,
    comparisonNote,
    declaredSetupStatus,
    proposalCaveats,
    proposalReason,
    proposalToml,
    proposeForWorkspace,
    type SetupProposal,
  } from "$lib/workspace/worktreeSetupDetect";

  interface Props {
    workspaceId: string;
    rootPath: string;
    /// Whether the section is on screen. The scan is a few hundred host
    /// round trips at worst, so it waits until someone looks.
    active: boolean;
  }
  let { workspaceId, rootPath, active }: Props = $props();

  const declared = $derived($worktreeSetups[workspaceId] ?? []);
  const trust = $derived($configTrusts(workspaceId));
  const status = $derived(declaredSetupStatus(declared.length, trust));

  let proposal = $state<SetupProposal | null>(null);
  let scanning = $state(false);
  let scanError = $state<string | null>(null);
  let copied = $state(false);
  /// Which root the current proposal was read from, so a root rebind
  /// re-reads instead of showing the old folder's lockfiles.
  let scannedRoot = $state<string | null>(null);
  /// A counter, not an identity check: `$state` proxies objects, and a
  /// slow scan of the previous root must not land over a newer one.
  let scanToken = 0;

  const comparison = $derived(proposal ? compareSetup(declared, proposal.lines) : null);
  const missing = $derived(new Set(comparison?.missing.map((p) => p.line) ?? []));
  const caveats = $derived(proposal ? proposalCaveats(proposal) : []);
  const toml = $derived(proposal ? proposalToml(proposal.lines) : "");
  const offerCopy = $derived(comparison?.state === "propose" || comparison?.state === "differs");

  function absolute(rel: string): string {
    const base = rootPath.replace(/[\\/]+$/, "");
    return rel === "" ? base : `${base}/${rel}`;
  }

  async function scan(): Promise<void> {
    const mine = ++scanToken;
    const root = rootPath;
    scanning = true;
    scanError = null;
    try {
      const result = await proposeForWorkspace(root, {
        list: (rel) => backend.listDirectory(root, absolute(rel)),
        gitRoot: async (cwd) => (await backend.gitRepoInfo(cwd)).root,
      });
      if (mine !== scanToken) return;
      proposal = result;
      scannedRoot = root;
    } catch (e) {
      if (mine !== scanToken) return;
      proposal = null;
      scannedRoot = root;
      scanError = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === scanToken) scanning = false;
    }
  }

  $effect(() => {
    if (active && rootPath && scannedRoot !== rootPath && !scanning) void scan();
  });

  async function copy(): Promise<void> {
    if (!toml) return;
    await writeText(toml);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="wts">
  <h3 class="sub">Worktree setup</h3>
  <p class="hint">
    What a new worktree runs before its agent starts, from <code>[worktree] setup</code> in
    .gavin-root/config.toml. The lines run one after another in the new checkout's root, and a
    failure stops the rest.
  </p>

  <ConfigTrustNotice {workspaceId} />

  <div class="block">
    <span class="label">Declared</span>
    {#if declared.length > 0}
      <ul class="lines">
        {#each declared as line, i (i)}
          <li><code>{line}</code></li>
        {/each}
      </ul>
    {/if}
    <p class="hint" class:warn={declared.length > 0 && !trust.trusted}>{status}</p>
  </div>

  <div class="block">
    <span class="label">Detected from lockfiles</span>
    {#if scanning && !proposal}
      <p class="hint">Reading this repo's lockfiles…</p>
    {:else if scanError}
      <p class="hint error">Couldn't read this folder: {scanError}</p>
    {:else if proposal && comparison}
      {#if proposal.lines.length > 0}
        <ul class="lines">
          {#each proposal.lines as p (p.line)}
            <li class:missing={missing.has(p.line) && declared.length > 0}>
              <code>{p.line}</code>
              <span class="reason">{proposalReason(p)}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="hint">{comparisonNote(comparison)}</p>
      {#each caveats as caveat (caveat)}
        <p class="hint">{caveat}</p>
      {/each}
      {#if offerCopy}
        <pre class="toml">{toml}</pre>
      {/if}
    {/if}
    <div class="actions">
      {#if offerCopy}
        <button type="button" class="linkish" onclick={() => void copy()}>
          {copied ? "Copied" : "Copy as TOML"}
        </button>
      {/if}
      <button type="button" class="linkish" disabled={scanning} onclick={() => void scan()}>
        {scanning ? "Reading…" : "Read again"}
      </button>
    </div>
  </div>
</div>

<style>
  .wts {
    margin-top: 18px;
  }
  h3.sub {
    margin: 0 0 10px;
    color: var(--text-muted);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .hint.warn {
    color: var(--warning-text);
  }
  .hint.error {
    color: var(--danger-text);
  }
  .block {
    margin-top: 12px;
  }
  .label {
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .lines {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lines li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lines code {
    /* Shown verbatim and never abbreviated: these are the characters
       that would run. */
    display: block;
    overflow-x: auto;
    white-space: pre;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-sunken);
  }
  .lines li.missing code {
    border-color: var(--border-warning);
  }
  .reason {
    color: var(--text-subtle);
    font-size: 0.85em;
  }
  .toml {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.85em;
    color: var(--text-muted);
    white-space: pre;
    overflow-x: auto;
  }
  .actions {
    display: flex;
    gap: 14px;
    margin-top: 8px;
  }
  button.linkish {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-text);
    font: inherit;
    cursor: pointer;
  }
  button.linkish:hover:not(:disabled) {
    color: var(--text);
  }
  button.linkish:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
