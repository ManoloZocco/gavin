import { describe, expect, it } from "vitest";
import {
  NO_NEEDS,
  agentVerdicts,
  agentsInUse,
  headroomNeedsUv,
  neededProblems,
  playwrightNeedsNode,
  preflightStateLabel,
  prerequisiteLines,
  prerequisiteNotice,
  type PreflightItem,
} from "$lib/agents/prerequisites";
import { svelteSources } from "$lib/sources";
import type { PlaywrightReading } from "$lib/agents/playwrightSetup";
import type { HeadroomReading } from "$lib/agents/headroomSetup";

function item(over: Partial<PreflightItem> & Pick<PreflightItem, "id" | "state">): PreflightItem {
  return { label: over.id, detail: "", fixHint: over.state === "ok" ? null : "fix it", profileId: null, ...over };
}

const ITEMS: PreflightItem[] = [
  item({ id: "git", label: "Git", state: "ok", detail: "git version 2.43.0" }),
  item({ id: "node", label: "Node.js (npx)", state: "missing", detail: "npx not found on PATH" }),
  item({ id: "uv", label: "uv", state: "missing" }),
  item({ id: "agent:claude-code", label: "Claude Code", state: "ok", profileId: "claude-code" }),
  item({ id: "agent:cursor", label: "Cursor Agent", state: "broken", profileId: "cursor", detail: "agent exited with 1" }),
  item({ id: "agent:codex", label: "Codex", state: "missing", profileId: "codex" }),
  item({ id: "agent:kimi-code", label: "Kimi Code", state: "missing", profileId: "kimi-code" }),
];

describe("prerequisiteLines", () => {
  it("lists the tools always, and a missing agent CLI only when something runs it", () => {
    const ids = prerequisiteLines(ITEMS, { ...NO_NEEDS, agents: ["claude-code", "codex"] }).map((l) => l.id);
    expect(ids).toEqual(["git", "node", "uv", "agent:claude-code", "agent:cursor", "agent:codex"]);
  });

  it("names what needs each line", () => {
    const lines = prerequisiteLines(ITEMS, {
      playwright: true,
      headroomInstall: false,
      agents: ["claude-code", "cursor"],
    });
    const by = Object.fromEntries(lines.map((l) => [l.id, l.neededBy]));
    expect(by.git).not.toBeNull();
    expect(by.node).toBe("Playwright");
    expect(by.uv).toBeNull();
    expect(by["agent:claude-code"]).toBe("this workspace's agent");
    expect(by["agent:cursor"]).toBe("the fallback chain");
  });
});

describe("what is worth a notice", () => {
  it("is nothing when the problems are in features nobody set up", () => {
    const lines = prerequisiteLines(ITEMS, { ...NO_NEEDS, agents: ["claude-code"] });
    expect(neededProblems(lines)).toEqual([]);
    expect(prerequisiteNotice(lines)).toBeNull();
  });

  it("is Node once Playwright is set up", () => {
    const lines = prerequisiteLines(ITEMS, { ...NO_NEEDS, playwright: true, agents: ["claude-code"] });
    expect(prerequisiteNotice(lines)).toBe("Node.js (npx) is missing (needed by Playwright).");
  });

  it("is a broken CLI in the fallback chain, and a missing primary", () => {
    const lines = prerequisiteLines(ITEMS, { ...NO_NEEDS, agents: ["codex", "cursor"] });
    expect(prerequisiteNotice(lines)).toBe(
      "Cursor Agent does not start (needed by the fallback chain); Codex is missing (needed by this workspace's agent)."
    );
  });

  it("is git whatever is set up", () => {
    const noGit = [item({ id: "git", label: "Git", state: "missing" })];
    expect(prerequisiteNotice(prerequisiteLines(noGit, NO_NEEDS))).toContain("Git is missing");
  });

  it("never counts an unknown line as a problem", () => {
    const unknown = [item({ id: "git-sh", label: "sh.exe", state: "unknown" })];
    expect(prerequisiteNotice(prerequisiteLines(unknown, NO_NEEDS))).toBeNull();
    expect(preflightStateLabel("broken")).toBe("does not start");
  });
});

describe("needs", () => {
  it("reads Playwright as set up from the human's word or gavin's entry", () => {
    const status = (entry: boolean | null): PlaywrightReading => ({
      kind: "status",
      status: {
        state: "absent",
        detail: "",
        checks: [{ id: "entry", ok: entry, line: "" }],
        command: "",
        installable: true,
        conflict: null,
        output: "",
      },
    });
    expect(playwrightNeedsNode(undefined, "installed")).toBe(true);
    expect(playwrightNeedsNode(undefined, "skipped")).toBe(false);
    expect(playwrightNeedsNode(status(true), undefined)).toBe(true);
    expect(playwrightNeedsNode(status(false), undefined)).toBe(false);
    expect(playwrightNeedsNode({ kind: "elsewhere", reason: "ssh" }, undefined)).toBe(false);
  });

  it("needs uv only to install a Headroom that is wanted", () => {
    const hr = (wanted: boolean, state: string) =>
      ({ kind: "status", status: { wanted, state } }) as unknown as HeadroomReading;
    expect(headroomNeedsUv(hr(true, "absent"))).toBe(true);
    expect(headroomNeedsUv(hr(true, "verified"))).toBe(false);
    expect(headroomNeedsUv(hr(false, "absent"))).toBe(false);
    expect(headroomNeedsUv(undefined)).toBe(false);
  });

  it("lists the primary first and the chain after, once each", () => {
    expect(agentsInUse("claude-code", ["codex", " claude-code ", "", "cursor"])).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
  });

  it("gives the wizard a verdict for every CLI that was found", () => {
    const v = agentVerdicts(ITEMS);
    expect(v.get("claude-code")?.runnable).toBe(true);
    expect(v.get("cursor")).toEqual({ runnable: false, detail: "agent exited with 1" });
    expect(v.has("codex")).toBe(false);
  });
});

// Rendered UI is the one thing the suites cannot see, so the surfaces are
// held to the module by their source.
describe("surfaces", () => {
  const SVELTE = svelteSources();
  it("Settings has a Prerequisites panel fed by the shared check", () => {
    expect(SVELTE["GlobalSettingsView.svelte"]).toContain("<h3>Prerequisites</h3>");
    expect(SVELTE["PrerequisitesPanel.svelte"]).toContain("prerequisiteLines");
    expect(SVELTE["PrerequisitesPanel.svelte"]).toContain("refreshPreflight");
  });

  it("Home raises a notice only through prerequisiteNotice", () => {
    expect(SVELTE["HomeHubView.svelte"]).toContain("prerequisiteNotice");
    expect(SVELTE["HomeHubView.svelte"]).toContain("ensurePreflight");
  });

  it("the Agent step folds the probes in before it picks", () => {
    expect(SVELTE["AgentStep.svelte"]).toContain("withRunnability");
    expect(SVELTE["AgentStep.svelte"]).toContain("does not start");
  });
});
