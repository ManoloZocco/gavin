// Publishes each open workspace's insights to the daemon (protocol v79),
// so gavin-mcp's `gavin_get_effective_config` and `gavin_doctor` read what
// this app works out. The snapshot is `workspaceInsights.ts`'s; this
// module gathers its inputs from the stores, runs the one slow input (the
// lockfile walk) in the background, and sends a workspace's snapshot when
// it differs from the last one that daemon took.
//
// Started from the bootstrap by the window holding the app's duties
// (`whileHoldingAppDuties`): the snapshot is one per workspace however
// many windows show it, and two tellers would only send it twice.
//
// The daemon keeps snapshots in memory only, so a new connection -- a
// restarted daemon, or an ssh host's link coming back -- is told
// everything again from the start.

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { configTrusts, daemonCompat, effectiveConfigInputs, layoutState } from "$lib/core/layoutState";
import { gavinTrees, worktreeSetups } from "$lib/core/gavinState";
import { kanbanState } from "$lib/board/kanbanState";
import { cardLint } from "$lib/board/cardLintState";
import type { LintFinding } from "$lib/board/cardLint";
import { resolveEffectiveConfig, type EffectiveConfig } from "$lib/agents/effectiveConfig";
import { sshLinks } from "$lib/workspace/sshLinkState";
import { isSshWorkspace } from "$lib/workspace/sshWorkspace";
import { reportedSetupProgress } from "$lib/workspace/setupProgressState";
import { proposeForWorkspace, type SetupProposal } from "$lib/workspace/worktreeSetupDetect";
import type { Workspace } from "$lib/core/workspace";
import {
  absoluteUnder,
  buildWorkspaceInsights,
  fitInsights,
  needsPublish,
  PUBLISH_RETRY_MS,
  publishBlocked,
  SSH_WORKTREE_SKIPPED,
  type WorktreeScan,
} from "$lib/workspace/workspaceInsights";

/// How long after the last change the snapshot is sent: a tree push, a
/// lint pass and a board read tend to land together.
const DEBOUNCE_MS = 1_000;

/// How old a lockfile walk may get before it is taken again. Lockfiles
/// come and go rarely, and the walk is up to a few hundred listings.
const SCAN_TTL_MS = 10 * 60_000;

interface ScanEntry {
  root: string;
  at: number;
  scanning: boolean;
  /// The last finished walk's answer, kept while a fresh one runs.
  result: { kind: "done"; proposal: SetupProposal } | { kind: "failed"; error: string } | null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let running = false;
let again = false;
let stopped = true;
const lastSent = new Map<string, string>();
const failed = new Map<string, { json: string; at: number }>();
const scans = new Map<string, ScanEntry>();
/// The ssh hosts whose link was ready at the last look, so a link coming
/// back -- to a host daemon that may have restarted -- re-tells it.
let readyHosts = new Set<string>();

function schedule(): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void publish();
  }, DEBOUNCE_MS);
}

function findingsFor(workspaceId: string): LintFinding[] | null {
  if (!get(gavinTrees)[workspaceId] && !get(kanbanState)[workspaceId]) return null;
  const index = get(cardLint)[workspaceId];
  if (!index) return null;
  return [...index.byPath.values(), ...index.byColumn.values()].flat();
}

function effectiveConfigFor(workspaceId: string): EffectiveConfig | null {
  try {
    return resolveEffectiveConfig(get(effectiveConfigInputs)(workspaceId));
  } catch {
    // A store that has not loaded its shape yet; the next change tries again.
    return null;
  }
}

/// The lockfile walk's state for a workspace, starting a walk when there
/// is none for its root or the last one has gone stale.
function scanFor(ws: Workspace & { rootPath: string }, now: number): WorktreeScan {
  if (isSshWorkspace(ws)) return { kind: "skipped", reason: SSH_WORKTREE_SKIPPED };
  const entry = scans.get(ws.id);
  if (!entry || entry.root !== ws.rootPath) {
    startScan(ws.id, ws.rootPath, null, now);
  } else if (!entry.scanning && now - entry.at > SCAN_TTL_MS) {
    startScan(ws.id, ws.rootPath, entry.result, now);
  }
  const result = scans.get(ws.id)?.result ?? null;
  return result ?? { kind: "pending" };
}

function startScan(workspaceId: string, root: string, previous: ScanEntry["result"], now: number): void {
  scans.set(workspaceId, { root, at: now, scanning: true, result: previous });
  void proposeForWorkspace(root, {
    list: (rel) => backend.listDirectory(root, absoluteUnder(root, rel)),
    gitRoot: async (cwd) => (await backend.gitRepoInfo(cwd)).root,
  })
    .then((proposal) => ({ kind: "done" as const, proposal }))
    .catch((e: unknown) => ({ kind: "failed" as const, error: e instanceof Error ? e.message : String(e) }))
    .then((result) => {
      // A rebound root or a newer walk owns the entry now.
      const current = scans.get(workspaceId);
      if (!current || current.root !== root || current.at !== now) return;
      scans.set(workspaceId, { root, at: Date.now(), scanning: false, result });
      schedule();
    });
}

/// One pass over every open workspace, collapsed into a single replay
/// when changes arrive while it runs (the compression switch's shape).
async function publish(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await publishOnce();
    } while (again && !stopped);
  } finally {
    running = false;
  }
}

async function publishOnce(): Promise<void> {
  const state = get(layoutState);
  if (state.status !== "ready") return;
  const compat = get(daemonCompat);
  const links = get(sshLinks);
  const setups = get(worktreeSetups);
  const trusts = get(configTrusts);
  const progress = get(reportedSetupProgress);
  const open = new Set(state.workspaces.map((w) => w.id));
  for (const id of [...lastSent.keys()]) if (!open.has(id)) lastSent.delete(id);
  for (const id of [...scans.keys()]) if (!open.has(id)) scans.delete(id);

  for (const ws of state.workspaces) {
    if (stopped) return;
    if (publishBlocked(ws, compat, links) !== null || !ws.rootPath) continue;
    const now = Date.now();
    const fit = fitInsights(
      buildWorkspaceInsights({
        effectiveConfig: effectiveConfigFor(ws.id),
        findings: findingsFor(ws.id),
        worktree: {
          declared: setups[ws.id] ?? [],
          trust: trusts(ws.id),
          scan: scanFor(ws as Workspace & { rootPath: string }, now),
        },
        setup: progress[ws.id] ?? null,
      })
    );
    if (!fit || !needsPublish(fit.json, lastSent.get(ws.id), failed.get(ws.id), now)) continue;
    try {
      await backend.publishWorkspaceInsights(ws.id, fit.insights);
      lastSent.set(ws.id, fit.json);
      failed.delete(ws.id);
    } catch {
      // Not recorded as sent, so a later pass tries again -- with this
      // snapshot after PUBLISH_RETRY_MS (a daemon not watching the root
      // yet), with a new one at once. Not `setError`: nothing the human
      // is doing depends on it.
      failed.set(ws.id, { json: fit.json, at: now });
    }
  }
}

/// Starts the publisher; returns its teardown.
export function startWorkspaceInsights(): () => void {
  stopped = false;
  lastSent.clear();
  failed.clear();
  readyHosts = new Set();
  const stops = [
    layoutState.subscribe(() => schedule()),
    effectiveConfigInputs.subscribe(() => schedule()),
    cardLint.subscribe(() => schedule()),
    worktreeSetups.subscribe(() => schedule()),
    configTrusts.subscribe(() => schedule()),
    reportedSetupProgress.subscribe(() => schedule()),
    // A (re)connected daemon starts with no snapshots: tell it everything.
    daemonCompat.subscribe(() => {
      for (const ws of get(layoutState).workspaces) if (!isSshWorkspace(ws)) lastSent.delete(ws.id);
      schedule();
    }),
    sshLinks.subscribe((links) => {
      const ready = new Set(Object.entries(links).filter(([, l]) => l.status === "ready").map(([h]) => h));
      for (const ws of get(layoutState).workspaces) {
        if (isSshWorkspace(ws) && ready.has(ws.ssh.host) && !readyHosts.has(ws.ssh.host)) lastSent.delete(ws.id);
      }
      readyHosts = ready;
      schedule();
    }),
  ];
  // Wakes the stale lockfile walks and the failed sends' retries, which
  // no store change would otherwise reach.
  tick = setInterval(schedule, PUBLISH_RETRY_MS);
  return () => {
    stopped = true;
    for (const stop of stops) stop();
    if (timer) clearTimeout(timer);
    if (tick) clearInterval(tick);
    timer = null;
    tick = null;
  };
}
