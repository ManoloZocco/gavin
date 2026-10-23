// An agent session that never got its gavin_* tools (lc-01).
//
// The most common failure in gavin's history is an agent that starts
// without its gavin tools and nobody notices: the agent UI shows
// `gavin (CONNECTION_CLOSED)` at best, and the launcher prints its reason
// to a stderr most agent UIs hide. The daemon now knows -- an agent
// launched with a stock profile whose gavin-mcp has not presented its
// session token within the grace (`TOOLS_MISSING_GRACE`, server.rs) is
// marked, and the mark goes if a Hello arrives after all -- and tells the
// app with the `session-tools-missing` event and the session baselines.
//
// This module is the rules: what the wire says, what the mark says, and
// what the one remedy does. The store is toolsMissingState.ts (a leaf, so
// layoutState can import it); the action that runs the remedy is
// toolsMissingRepair.ts.

import type { IntegrationResult } from "$lib/core/backend";

/// The daemon's word, read strictly: only `true` is a mark. Absent --
/// a daemon before v81, which never looks -- is no mark, and so is
/// anything this build cannot read.
export function parseToolsMissing(raw: unknown): boolean {
  return raw === true;
}

/// The bubble on the tab and sidebar marks. Says what is wrong in the
/// agent's terms (the tools it is missing), what that costs, and where
/// the remedy is -- because the remedy is a button the human otherwise
/// has to know exists.
export const TOOLS_MISSING_TIP =
  "This agent has no gavin_* tools — its gavin MCP server never connected, so it cannot read " +
  "or move cards. Repair integration (right-click the tab, or click this mark on the tab bar) " +
  "rewrites the workspace's agent setup; then restart the agent.";

/// The action's name, on the menu entry and the mark's label alike.
export const REPAIR_INTEGRATION_LABEL = "Repair integration";

/// The workspace facts the remedy needs. Structural, so a test reaches
/// the rule without building a Workspace.
export interface RepairWorkspace {
  id: string;
  rootPath?: string | null;
  /// Set for a workspace on another machine: its agent configuration is
  /// on the host, which the Settings button does not write either.
  ssh?: unknown;
}

export type RepairPlan =
  | { kind: "run"; workspaceId: string; rootPath: string }
  | { kind: "refuse"; title: string; lines: string[] };

/// Whether "Repair integration" can run for this session's workspace,
/// and on which folder. The same preconditions the Settings button has:
/// it is offered only for a local workspace with a root.
export function repairPlan(workspace: RepairWorkspace | null | undefined): RepairPlan {
  if (!workspace) {
    return {
      kind: "refuse",
      title: "Couldn't repair the integration",
      lines: ["This session no longer belongs to a workspace."],
    };
  }
  if (workspace.ssh) {
    return {
      kind: "refuse",
      title: "Repair it on the host",
      lines: [
        "This workspace lives on another machine, and its agent configuration is there.",
        "Set the integration up on that host, then restart the agent.",
      ],
    };
  }
  if (!workspace.rootPath) {
    return {
      kind: "refuse",
      title: "Couldn't repair the integration",
      lines: ["This workspace has no root folder, so there is no agent configuration to write."],
    };
  }
  return { kind: "run", workspaceId: workspace.id, rootPath: workspace.rootPath };
}

/// What to tell the human once the setup has run. A running agent read
/// its MCP configuration when it started, so nothing written now reaches
/// it: the outcome always ends by saying the agent has to be restarted.
///
/// `openSettings` is set when the run paused on a question only Settings
/// can ask -- MCP servers in the config that gavin did not add (AG-07).
export function repairOutcome(
  result: IntegrationResult,
  rootPath: string
): { title: string; lines: string[]; openSettings: boolean } {
  if (result.mcpForeign) {
    return {
      title: "One question first",
      lines: [
        "The agent's MCP configuration lists servers gavin did not add, and gavin asks before it writes beside them.",
        "Answer it under Settings › Integration (Set up / update), then restart the agent.",
      ],
      openSettings: true,
    };
  }
  const short = (f: string): string => f.replace(rootPath + "/", "");
  const lines = [
    result.written.length > 0
      ? `Wrote ${result.written.map(short).join(", ")}.`
      : "Everything was already in place.",
  ];
  for (const [file, backup] of result.replaced) {
    lines.push(`Replaced ${short(file)}, keeping your copy as ${short(backup)}.`);
  }
  if (result.skipped.length > 0) lines.push(`Skipped: ${result.skipped.map(([what]) => what).join(", ")}.`);
  lines.push(
    "Restart this agent: it read its MCP configuration when it started, so the gavin tools arrive with the next launch."
  );
  return { title: "Integration repaired", lines, openSettings: false };
}
