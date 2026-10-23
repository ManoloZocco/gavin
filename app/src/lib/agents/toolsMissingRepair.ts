// "Repair integration" for an agent session with no gavin_* tools: the
// Settings panel's "Set up / update" (WorkspaceRootControl.svelte), run
// for the workspace the session belongs to, from the mark that says it is
// needed. The rules -- when it can run, what it says afterwards -- are in
// toolsMissing.ts; this only gathers the inputs and shows the result.
//
// Through `runIntegration`, the same call the Settings button makes, with
// the same resolved instructions file and the same recorded answer to the
// foreign-servers question, so the two can never write different files.

import { get } from "svelte/store";
import {
  agentDefaultsStore,
  agentModelDefaultsStore,
  agentProfilesStore,
  layoutState,
  switchWorkspaceView,
  trustedAgentConfigs,
} from "$lib/core/layoutState";
import { resolveAgentConfig } from "$lib/core/settings";
import { workspaceIdForSession } from "$lib/core/workspace";
import { rememberForeignMcpServers, runIntegration } from "$lib/workspace/mcpServerTrust";
import { showAlert } from "$lib/core/dialog";
import { repairOutcome, repairPlan } from "$lib/agents/toolsMissing";

export async function repairIntegrationForSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  const workspaceId = workspaceIdForSession(state, sessionId);
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  const plan = repairPlan(workspace);
  if (plan.kind === "refuse" || !workspace) {
    if (plan.kind === "refuse") await showAlert({ title: plan.title, lines: plan.lines, dismissLabel: "Close" });
    return;
  }
  const agent = resolveAgentConfig(
    get(trustedAgentConfigs)(workspace.id),
    get(agentProfilesStore),
    get(agentModelDefaultsStore),
    undefined,
    undefined,
    undefined,
    get(agentDefaultsStore).defaultAgent
  );
  try {
    const result = await runIntegration(plan.rootPath, agent.file, workspace.mcpForeignServersChoice);
    rememberForeignMcpServers(plan.rootPath, result.mcpForeign?.servers ?? []);
    const outcome = repairOutcome(result, plan.rootPath);
    if (outcome.openSettings) void switchWorkspaceView(workspace.id, "settings");
    await showAlert({ title: outcome.title, lines: outcome.lines, dismissLabel: "Close" });
  } catch (e) {
    await showAlert({
      title: "Couldn't repair the integration",
      lines: [String(e)],
      dismissLabel: "Close",
    });
  }
}
