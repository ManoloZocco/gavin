<script lang="ts">
  /// `[worktree] setup` in the workspace Settings: what is declared, what
  /// the trust gate does with it, what this repo's lockfiles say it should
  /// be, and a minimal editor for it. A thin template over
  /// `worktreeSetupDetect.ts` (the proposal) and `worktreeSetupEditor.ts`
  /// (the editor's text, its checks, and what a save does to trust).
  ///
  /// Nothing here runs anything. "Use proposal" only fills the editor;
  /// Save writes config.toml through the daemon (`saveWorktreeSetup`),
  /// and a line still runs only once the human's approval covers it — the
  /// save carries that approval when it approves nothing unseen. Against a
  /// daemon older than the writer the panel is read-only again, with the
  /// proposal offered as a TOML block to paste.
  import { untrack } from "svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import * as backend from "$lib/core/backend";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { worktreeSetups } from "$lib/core/gavinState";
  import { configTrusts, daemonCompat, saveWorktreeSetup } from "$lib/core/layoutState";
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
  import {
    editorDirty,
    editorLines,
    editorProblem,
    editorText,
    proposalText,
    reseededDraft,
    saveNote,
  } from "$lib/workspace/worktreeSetupEditor";

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
  const editBlocked = $derived(featureBlockedReason($daemonCompat, "worktreeSetupEditor"));

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

  /// The editor. `seeded` is the declared text it last took, so a push
  /// that moves the file replaces untouched text and never edited text.
  let draft = $state("");
  let seeded: string | null = null;
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let savedNote = $state<string | null>(null);
  let saveToken = 0;

  $effect(() => {
    const next = editorText(declared);
    untrack(() => {
      draft = reseededDraft(draft, seeded, next);
      seeded = next;
    });
  });

  const draftLines = $derived(editorLines(draft));
  const problem = $derived(editorProblem(draftLines));
  const dirty = $derived(editorDirty(draft, declared));
  const canSave = $derived(editBlocked === null && dirty && problem === null && !saving);

  const comparison = $derived(proposal ? compareSetup(declared, proposal.lines) : null);
  const missing = $derived(new Set(comparison?.missing.map((p) => p.line) ?? []));
  const caveats = $derived(proposal ? proposalCaveats(proposal) : []);
  const toml = $derived(proposal ? proposalToml(proposal.lines) : "");
  const offerCopy = $derived(
    editBlocked !== null && (comparison?.state === "propose" || comparison?.state === "differs")
  );
  const offerUse = $derived(
    editBlocked === null && !!proposal && proposal.lines.length > 0 && proposalText(proposal.lines) !== draft
  );

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

  function useProposal(): void {
    if (!proposal) return;
    draft = proposalText(proposal.lines);
    savedNote = null;
    saveError = null;
  }

  function revert(): void {
    draft = editorText(declared);
    saveError = null;
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    const mine = ++saveToken;
    saving = true;
    saveError = null;
    savedNote = null;
    try {
      const result = await saveWorktreeSetup(workspaceId, draftLines);
      if (mine !== saveToken) return;
      savedNote = saveNote(result, result.stamped);
      draft = editorText(result.lines);
      seeded = draft;
    } catch (e) {
      if (mine !== saveToken) return;
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === saveToken) saving = false;
    }
  }
</script>

<div class="wts">
  <h3 class="sub">Worktree setup</h3>
  <p class="hint">
    What a new worktree runs before its agent starts, from <code>[worktree] setup</code> in
    .gavin-root/config.toml. The lines run one after another in the new checkout's root, and a
    failure stops the rest. Write a nested install as a subshell: <code>(cd app &amp;&amp; npm ci)</code>.
  </p>

  <ConfigTrustNotice {workspaceId} />

  <div class="block">
    <span class="label">Declared</span>
    {#if editBlocked === null}
      <textarea
        class="editor"
        rows={Math.min(Math.max(draftLines.length + 1, 3), 12)}
        spellcheck="false"
        autocomplete="off"
        placeholder="One command per line, e.g. npm ci"
        aria-label="Worktree setup commands, one per line"
        bind:value={draft}
        oninput={() => (savedNote = null)}
      ></textarea>
    {:else if declared.length > 0}
      <ul class="lines">
        {#each declared as line, i (i)}
          <li><code>{line}</code></li>
        {/each}
      </ul>
    {/if}
    <p class="hint" class:warn={declared.length > 0 && !trust.trusted}>{status}</p>
    {#if editBlocked}
      <p class="hint">Editing here: {editBlocked}</p>
    {:else}
      {#if problem}
        <p class="hint error">{problem}</p>
      {/if}
      {#if saveError}
        <p class="hint error">Couldn't save: {saveError}</p>
      {/if}
      {#if savedNote}
        <p class="hint">{savedNote}</p>
      {/if}
      <div class="actions">
        <button type="button" class="save" disabled={!canSave} onclick={() => void save()}>
          {saving ? "Saving…" : "Save setup"}
        </button>
        {#if dirty}
          <button type="button" class="linkish" disabled={saving} onclick={revert}>Revert</button>
        {/if}
      </div>
    {/if}
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
      <p class="hint">{comparisonNote(comparison, editBlocked === null)}</p>
      {#each caveats as caveat (caveat)}
        <p class="hint">{caveat}</p>
      {/each}
      {#if offerCopy}
        <pre class="toml">{toml}</pre>
      {/if}
    {/if}
    <div class="actions">
      {#if offerUse}
        <button type="button" class="linkish" disabled={saving} onclick={useProposal}>Use proposal</button>
      {/if}
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
  .editor {
    /* The characters that will run, so never wrapped or reflowed. */
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin-top: 6px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-sunken);
    color: var(--text);
    font-family: monospace;
    font-size: 0.9em;
    white-space: pre;
    overflow-x: auto;
    resize: vertical;
  }
  .editor:focus-visible {
    outline: 2px solid var(--border-accent);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 8px;
  }
  button.save {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 4px 12px;
    border-radius: 4px;
    font: inherit;
    cursor: pointer;
  }
  button.save:focus-visible {
    outline: 2px solid var(--border-accent);
    outline-offset: 1px;
  }
  button.save:disabled {
    opacity: 0.45;
    cursor: default;
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
