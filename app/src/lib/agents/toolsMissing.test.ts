import { describe, it, expect } from "vitest";
import {
  REPAIR_INTEGRATION_LABEL,
  TOOLS_MISSING_TIP,
  parseToolsMissing,
  repairOutcome,
  repairPlan,
} from "$lib/agents/toolsMissing";
import { source } from "$lib/sources";
import type { IntegrationResult } from "$lib/core/backend";

describe("parseToolsMissing", () => {
  it("is a mark only when the daemon says true", () => {
    expect(parseToolsMissing(true)).toBe(true);
    expect(parseToolsMissing(false)).toBe(false);
  });

  it("reads an older daemon's silence, and anything it cannot read, as no mark", () => {
    expect(parseToolsMissing(undefined)).toBe(false);
    expect(parseToolsMissing(null)).toBe(false);
    expect(parseToolsMissing("true")).toBe(false);
    expect(parseToolsMissing(1)).toBe(false);
  });
});

describe("the tip", () => {
  it("names the missing tools, the remedy and the restart", () => {
    expect(TOOLS_MISSING_TIP).toContain("no gavin_* tools");
    expect(TOOLS_MISSING_TIP).toContain(REPAIR_INTEGRATION_LABEL);
    expect(TOOLS_MISSING_TIP).toContain("restart the agent");
  });
});

describe("repairPlan", () => {
  it("runs on a local workspace's root, as the Settings button does", () => {
    expect(repairPlan({ id: "w1", rootPath: "/repo" })).toEqual({
      kind: "run",
      workspaceId: "w1",
      rootPath: "/repo",
    });
  });

  it("refuses a session with no workspace, a workspace with no root, and an ssh one", () => {
    expect(repairPlan(undefined).kind).toBe("refuse");
    expect(repairPlan({ id: "w1", rootPath: null }).kind).toBe("refuse");
    const ssh = repairPlan({ id: "w1", rootPath: "/srv/repo", ssh: { host: "box" } });
    expect(ssh.kind).toBe("refuse");
    if (ssh.kind === "refuse") expect(ssh.lines.join(" ")).toContain("host");
  });
});

describe("repairOutcome", () => {
  const ok: IntegrationResult = {
    written: ["/repo/.mcp.json", "/repo/CLAUDE.md"],
    skipped: [],
    replaced: [],
  };

  it("says what it wrote, relative to the root, and that the agent must restart", () => {
    const out = repairOutcome(ok, "/repo");
    expect(out.title).toBe("Integration repaired");
    expect(out.openSettings).toBe(false);
    expect(out.lines[0]).toBe("Wrote .mcp.json, CLAUDE.md.");
    expect(out.lines[out.lines.length - 1]).toContain("Restart this agent");
  });

  it("says nothing was written when nothing needed writing, and still asks for the restart", () => {
    const out = repairOutcome({ written: [], skipped: [], replaced: [] }, "/repo");
    expect(out.lines[0]).toBe("Everything was already in place.");
    expect(out.lines[out.lines.length - 1]).toContain("Restart this agent");
  });

  it("names a replaced file and where the old copy went, and what was skipped", () => {
    const out = repairOutcome(
      { ...ok, replaced: [["/repo/CLAUDE.md", "/repo/CLAUDE.md.bak"]], skipped: [["skills", "no layout"]] },
      "/repo"
    );
    expect(out.lines).toContain("Replaced CLAUDE.md, keeping your copy as CLAUDE.md.bak.");
    expect(out.lines).toContain("Skipped: skills.");
  });

  it("hands a foreign-servers question to Settings rather than answering it", () => {
    const out = repairOutcome({ ...ok, mcpForeign: { servers: [] } as unknown as IntegrationResult["mcpForeign"] }, "/repo");
    expect(out.openSettings).toBe(true);
    expect(out.lines.join(" ")).toContain("Settings");
  });
});

// The .svelte files are thin templates over this module; what they must
// carry is checked on their source, since mounting them needs a daemon.
describe("the surfaces", () => {
  it("listens for the push and seeds from the baselines", () => {
    const state = source("layoutState.ts");
    expect(state).toContain('"session-tools-missing"');
    expect(state).toContain("noteToolsMissing(event.payload.id, event.payload.missing)");
    expect(state).toContain("seedToolsMissing(baselines);");
  });

  it("marks the tab, whose mark runs the repair", () => {
    const pane = source("Pane.svelte");
    expect(pane).toContain("$toolsMissingById[sessionId]");
    expect(pane).toContain("indicator={toolsMissingIndicator()}");
    expect(pane).toContain("tip={TOOLS_MISSING_TIP}");
    expect(pane).toContain("void repairIntegrationForSession(sessionId);");
    expect(pane).toContain("toolsMissing: $toolsMissingById[sessionId] === true,");
  });

  it("marks the sidebar row, whose menu offers the repair", () => {
    const sidebar = source("Sidebar.svelte");
    expect(sidebar).toContain('row.kind === "session" && $toolsMissingById[row.id]');
    expect(sidebar).toContain("tip={TOOLS_MISSING_TIP}");
    expect(sidebar).toContain("toolsMissing: $toolsMissingById[row.id] === true,");
  });

  it("repairs through the Settings button's own call", () => {
    const repair = source("toolsMissingRepair.ts");
    expect(repair).toContain("runIntegration(plan.rootPath, agent.file, workspace.mcpForeignServersChoice)");
    expect(source("WorkspaceRootControl.svelte")).toContain(
      "runIntegration(workspace.rootPath, agent.file, workspace.mcpForeignServersChoice)"
    );
  });
});
