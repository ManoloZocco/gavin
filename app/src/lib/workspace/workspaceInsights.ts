// What the app works out about a workspace, as one JSON snapshot for the
// daemon to keep and gavin-mcp to read (protocol v79).
//
// An agent reaches only the daemon, and everything an agent would need to
// diagnose its own workspace's configuration is computed HERE, in
// TypeScript, from stores the daemon never sees: the effective agent
// config (`agents/effectiveConfig.ts`), the card linter
// (`board/cardLint.ts`), the worktree setup proposal
// (`workspace/worktreeSetupDetect.ts`) and the setup steps left
// (`workspace/setupWizard.ts`). This module only gathers their answers
// into one plain object; it decides nothing of its own, so the agent and
// the human are told the same thing. `workspaceInsightsState.ts` publishes
// it; gavin-mcp's `gavin_get_effective_config` and `gavin_doctor`
// (crates/gavin-mcp/src/insights.rs) read it, field for field:
//
//   WorkspaceInsights {
//     version: 1,
//     effectiveConfig: EffectiveConfig | null,     // null until it resolves
//     lint: {
//       findings: LintFinding[],                   // at most MAX_FINDINGS
//       findingsTotal: number,                     // before the cap
//       safeFixes: FieldWrite[],                   // from ALL findings, capped
//     } | null,                                    // null until the tree loads
//     worktreeSetup:
//       | { declared: string[], trust: { trusted, needsApproval },
//           proposal: SetupProposal | null,        // null while the first scan runs
//           comparison: SetupComparison | null,
//           error: string | null }                 // the scan failed
//       | { skipped: string },                     // not scanned, and why
//     setup: { configured: boolean, complete: boolean,
//              missing: { step: SetupStep, label: string }[] } | null,
//                                                  // null until the Home tab has
//                                                  // worked it out
//   }
//
// No timestamp inside: the daemon stamps the publish itself, and a clock
// in the object would make every snapshot differ from the last, defeating
// the publisher's "unchanged, so not sent" check.

import type { EffectiveConfig } from "$lib/agents/effectiveConfig";
import { safeFixes, type FieldWrite, type LintFinding } from "$lib/board/cardLint";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import type { Workspace } from "$lib/core/workspace";
import { isSshWorkspace, sshInsightsBlocked, type SshLinks } from "$lib/workspace/sshWorkspace";
import { compareSetup, type SetupComparison, type SetupProposal } from "$lib/workspace/worktreeSetupDetect";
import { SETUP_STEP_LABELS, type SetupProgress, type SetupStep } from "$lib/workspace/setupWizard";

export const INSIGHTS_VERSION = 1;

/// How many findings travel. The doctor lists every one, and an agent
/// fixing two hundred cards at once is already well past the point of
/// asking for the next batch; the total says how many were left out.
export const MAX_FINDINGS = 200;

/// The daemon's cap (`protocol::MAX_WORKSPACE_INSIGHTS_BYTES`), mirrored
/// so the publisher trims rather than being refused.
export const MAX_INSIGHTS_BYTES = 512 * 1024;

export interface LintInsights {
  findings: LintFinding[];
  findingsTotal: number;
  safeFixes: FieldWrite[];
}

export type WorktreeInsights =
  | {
      declared: string[];
      trust: { trusted: boolean; needsApproval: boolean };
      proposal: SetupProposal | null;
      comparison: SetupComparison | null;
      error: string | null;
    }
  | { skipped: string };

export interface SetupInsights {
  configured: boolean;
  complete: boolean;
  missing: { step: SetupStep; label: string }[];
}

export interface WorkspaceInsights {
  version: typeof INSIGHTS_VERSION;
  effectiveConfig: EffectiveConfig | null;
  lint: LintInsights | null;
  worktreeSetup: WorktreeInsights;
  setup: SetupInsights | null;
}

/// Where the worktree scan stands for this workspace.
export type WorktreeScan =
  | { kind: "skipped"; reason: string }
  | { kind: "pending" }
  | { kind: "done"; proposal: SetupProposal }
  | { kind: "failed"; error: string };

export interface WorkspaceInsightsInput {
  effectiveConfig: EffectiveConfig | null;
  /// The linter's findings, or null when the workspace's tree and board
  /// have not loaded -- "no findings" would be a claim about cards
  /// nobody has read.
  findings: readonly LintFinding[] | null;
  worktree: {
    declared: readonly string[];
    trust: { trusted: boolean; needsApproval: boolean };
    scan: WorktreeScan;
  };
  setup: SetupProgress | null;
}

function lintInsights(findings: readonly LintFinding[], max: number): LintInsights {
  return {
    findings: findings.slice(0, max).map((f) => ({ ...f })),
    findingsTotal: findings.length,
    safeFixes: safeFixes(findings).slice(0, max),
  };
}

function worktreeInsights(input: WorkspaceInsightsInput["worktree"]): WorktreeInsights {
  if (input.scan.kind === "skipped") return { skipped: input.scan.reason };
  const declared = [...input.declared];
  const proposal = input.scan.kind === "done" ? input.scan.proposal : null;
  return {
    declared,
    trust: { trusted: input.trust.trusted, needsApproval: input.trust.needsApproval },
    proposal,
    comparison: proposal ? compareSetup(declared, proposal.lines) : null,
    error: input.scan.kind === "failed" ? input.scan.error : null,
  };
}

/// A setup reading that is still waiting on a read says nothing yet, so
/// it travels as null rather than as the half it has seen.
function setupInsights(progress: SetupProgress | null): SetupInsights | null {
  if (!progress || progress.pending) return null;
  return {
    configured: progress.configured,
    complete: progress.complete,
    missing: progress.missing.map((step) => ({ step, label: SETUP_STEP_LABELS[step] ?? step })),
  };
}

export function buildWorkspaceInsights(input: WorkspaceInsightsInput, maxFindings = MAX_FINDINGS): WorkspaceInsights {
  return {
    version: INSIGHTS_VERSION,
    effectiveConfig: input.effectiveConfig,
    lint: input.findings ? lintInsights(input.findings, maxFindings) : null,
    worktreeSetup: worktreeInsights(input.worktree),
    setup: setupInsights(input.setup),
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/// The snapshot as it is sent, and its JSON -- the string the publisher
/// compares against the last one it sent. Over `maxBytes`, the lint lists
/// (the only part that grows with the workspace) are halved until it
/// fits; `findingsTotal` keeps the real count, so the doctor says how many
/// were left out. Null when even an empty lint does not fit, which no real
/// snapshot reaches.
export function fitInsights(
  insights: WorkspaceInsights,
  maxBytes = MAX_INSIGHTS_BYTES
): { insights: WorkspaceInsights; json: string } | null {
  let current = insights;
  for (;;) {
    const json = JSON.stringify(current);
    if (byteLength(json) <= maxBytes) return { insights: current, json };
    const lint = current.lint;
    if (!lint || (lint.findings.length === 0 && lint.safeFixes.length === 0)) return null;
    const keep = (n: number) => Math.floor(n / 2);
    current = {
      ...current,
      lint: {
        findings: lint.findings.slice(0, keep(lint.findings.length)),
        findingsTotal: lint.findingsTotal,
        safeFixes: lint.safeFixes.slice(0, keep(lint.safeFixes.length)),
      },
    };
  }
}

/// A path the lockfile walk names relative to the workspace root, as the
/// host's directory listing takes it. The same join the Settings panel
/// makes (`WorktreeSetupPanel.svelte`).
export function absoluteUnder(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return rel === "" ? base : `${base}/${rel}`;
}

/// Why this workspace's snapshot cannot be published now, or null when it
/// can. An ssh workspace's agents ask its HOST's daemon, so that link and
/// that version decide; a local one is the local daemon's, and with no
/// verdict yet there is nobody to tell (`featureBlockedReason` reads an
/// unknown verdict as "not blocked", which is right for greying a button
/// and wrong for sending a request).
export function publishBlocked(
  ws: Workspace | null | undefined,
  compat: DaemonCompat | null,
  links: SshLinks
): string | null {
  if (!ws?.rootPath) return "no root folder";
  if (isSshWorkspace(ws)) return sshInsightsBlocked(ws, links);
  if (!compat) return "not connected to the daemon yet";
  return featureBlockedReason(compat, "workspaceInsights");
}

/// A send that failed is retried after this long with the same snapshot;
/// a different snapshot goes at once.
export const PUBLISH_RETRY_MS = 30_000;

/// Whether `json` needs sending: it differs from what this daemon was last
/// told, and it is not the snapshot that just failed (retried only once
/// `PUBLISH_RETRY_MS` has passed, so a refusal -- a root the daemon does
/// not watch yet -- is not asked again on every keystroke).
export function needsPublish(
  json: string,
  lastSent: string | undefined,
  failed: { json: string; at: number } | undefined,
  now: number
): boolean {
  if (json === lastSent) return false;
  if (failed && failed.json === json && now - failed.at < PUBLISH_RETRY_MS) return false;
  return true;
}

/// Why an ssh workspace's worktree setup is not scanned: the walk lists
/// the tree one host round trip per folder, up to hundreds of them, and
/// worktrees are not cut for ssh workspaces yet (`SSH_LIMITATION`) -- so
/// the proposal would describe a setup nothing runs.
export const SSH_WORKTREE_SKIPPED =
  "an ssh workspace's lockfiles are not scanned from this machine, and gavin does not cut worktrees for ssh workspaces yet";
