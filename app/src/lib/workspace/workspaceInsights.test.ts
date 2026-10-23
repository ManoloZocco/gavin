import { describe, expect, it } from "vitest";
import type { EffectiveConfig } from "$lib/agents/effectiveConfig";
import type { LintFinding } from "$lib/board/cardLint";
import type { SetupProgress } from "$lib/workspace/setupWizard";
import type { SetupProposal } from "$lib/workspace/worktreeSetupDetect";
import type { Workspace } from "$lib/core/workspace";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";
import type { SshLinks } from "$lib/workspace/sshWorkspace";
import {
  absoluteUnder,
  buildWorkspaceInsights,
  fitInsights,
  MAX_FINDINGS,
  needsPublish,
  PUBLISH_RETRY_MS,
  publishBlocked,
  type WorkspaceInsightsInput,
} from "$lib/workspace/workspaceInsights";

const CONFIG = { unrated: { agent: { value: "claude-code", layer: "builtin" } }, complexityTableEmpty: true } as unknown as EffectiveConfig;

function safe(path: string, value: string): LintFinding {
  return {
    code: "status-spelling",
    path,
    contextFolder: "/ws",
    fileName: path.slice(path.lastIndexOf("/") + 1),
    field: "status",
    message: `status: differs from ${value} only by case.`,
    fix: { kind: "safe", write: { path, key: "status", value }, summary: `status respelled to ${value}` },
  };
}

function decide(path: string): LintFinding {
  return {
    code: "status-unknown",
    path,
    contextFolder: "/ws",
    fileName: "b.md",
    field: "status",
    message: "status: matches no column.",
    fix: { kind: "decide", options: ["To Do", "Done"] },
  };
}

const PROPOSAL: SetupProposal = {
  lines: [
    { line: "(cd app && npm ci)", command: "npm ci", dir: "app", lockfile: "app/package-lock.json", alsoFound: [] },
    { line: "cargo fetch", command: "cargo fetch", dir: "", lockfile: "Cargo.lock", alsoFound: [] },
  ],
  partial: false,
  rootedAtCheckout: true,
};

function progress(over: Partial<SetupProgress> = {}): SetupProgress {
  return {
    done: ["agent"],
    next: "integration",
    complete: false,
    configured: false,
    missing: ["integration", "prd"],
    pending: false,
    ...over,
  };
}

function input(over: Partial<WorkspaceInsightsInput> = {}): WorkspaceInsightsInput {
  return {
    effectiveConfig: CONFIG,
    findings: [safe("/ws/.gavin-root/plans/a.md", "In Progress"), decide("/ws/.gavin-root/plans/b.md")],
    worktree: {
      declared: ["cargo fetch"],
      trust: { trusted: false, needsApproval: true },
      scan: { kind: "done", proposal: PROPOSAL },
    },
    setup: progress(),
    ...over,
  };
}

describe("buildWorkspaceInsights", () => {
  it("gathers every part in the shape gavin-mcp reads", () => {
    const got = buildWorkspaceInsights(input());
    expect(got.version).toBe(1);
    expect(got.effectiveConfig).toBe(CONFIG);
    expect(got.lint).toEqual({
      findings: input().findings,
      findingsTotal: 2,
      safeFixes: [{ path: "/ws/.gavin-root/plans/a.md", key: "status", value: "In Progress" }],
    });
    expect(got.worktreeSetup).toEqual({
      declared: ["cargo fetch"],
      trust: { trusted: false, needsApproval: true },
      proposal: PROPOSAL,
      comparison: { state: "differs", missing: [PROPOSAL.lines[0]] },
      error: null,
    });
    expect(got.setup).toEqual({
      configured: false,
      complete: false,
      missing: [
        { step: "integration", label: "Integration" },
        { step: "prd", label: "PRD" },
      ],
    });
  });

  // Every value is plain JSON: what is sent is what is compared.
  it("survives a JSON round trip unchanged", () => {
    const got = buildWorkspaceInsights(input());
    expect(JSON.parse(JSON.stringify(got))).toEqual(got);
  });

  it("says nothing it has not read: no tree, a pending setup, a scan still running", () => {
    const got = buildWorkspaceInsights(
      input({
        effectiveConfig: null,
        findings: null,
        setup: progress({ pending: true }),
        worktree: { declared: [], trust: { trusted: true, needsApproval: false }, scan: { kind: "pending" } },
      })
    );
    expect(got.effectiveConfig).toBeNull();
    expect(got.lint).toBeNull();
    expect(got.setup).toBeNull();
    expect(got.worktreeSetup).toEqual({
      declared: [],
      trust: { trusted: true, needsApproval: false },
      proposal: null,
      comparison: null,
      error: null,
    });
    expect(buildWorkspaceInsights(input({ setup: null })).setup).toBeNull();
  });

  it("carries a failed scan's reason and a skipped one's", () => {
    const failed = buildWorkspaceInsights(
      input({ worktree: { declared: [], trust: { trusted: true, needsApproval: false }, scan: { kind: "failed", error: "EACCES" } } })
    );
    expect(failed.worktreeSetup).toMatchObject({ proposal: null, comparison: null, error: "EACCES" });
    const skipped = buildWorkspaceInsights(
      input({ worktree: { declared: ["x"], trust: { trusted: true, needsApproval: false }, scan: { kind: "skipped", reason: "ssh" } } })
    );
    expect(skipped.worktreeSetup).toEqual({ skipped: "ssh" });
  });

  it("an empty lint is an answer, not a missing one", () => {
    expect(buildWorkspaceInsights(input({ findings: [] })).lint).toEqual({ findings: [], findingsTotal: 0, safeFixes: [] });
  });

  it("caps the findings it carries and keeps the real total", () => {
    const many = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => safe(`/ws/.gavin-root/plans/c${i}.md`, "Done"));
    const got = buildWorkspaceInsights(input({ findings: many }));
    expect(got.lint?.findings).toHaveLength(MAX_FINDINGS);
    expect(got.lint?.findingsTotal).toBe(MAX_FINDINGS + 5);
    expect(got.lint?.safeFixes).toHaveLength(MAX_FINDINGS);
  });
});

describe("fitInsights", () => {
  it("passes a snapshot under the cap through, with the JSON that is compared", () => {
    const insights = buildWorkspaceInsights(input());
    const fit = fitInsights(insights);
    expect(fit?.insights).toBe(insights);
    expect(fit?.json).toBe(JSON.stringify(insights));
  });

  it("halves the lint lists until the snapshot fits, keeping the total", () => {
    const many = Array.from({ length: 64 }, (_, i) => safe(`/ws/.gavin-root/plans/${"x".repeat(200)}${i}.md`, "Done"));
    const insights = buildWorkspaceInsights(input({ findings: many }));
    const full = new TextEncoder().encode(JSON.stringify(insights)).length;
    const fit = fitInsights(insights, Math.floor(full / 3));
    expect(fit).not.toBeNull();
    expect(new TextEncoder().encode(fit!.json).length).toBeLessThanOrEqual(Math.floor(full / 3));
    expect(fit!.insights.lint!.findings.length).toBeLessThan(64);
    expect(fit!.insights.lint!.findingsTotal).toBe(64);
  });

  it("gives up rather than sending a snapshot nothing can shrink", () => {
    expect(fitInsights(buildWorkspaceInsights(input({ findings: null })), 10)).toBeNull();
  });
});

function ws(over: Partial<Workspace> = {}): Workspace {
  return { id: "w", name: "W", pages: [], activePageId: null, rootPath: "/ws", ...over };
}

const NEW = { daemonVersion: FEATURE_MIN_VERSION.workspaceInsights, appVersion: FEATURE_MIN_VERSION.workspaceInsights, degraded: false };
const OLD = { ...NEW, daemonVersion: FEATURE_MIN_VERSION.workspaceInsights - 1, degraded: true };

describe("publishBlocked", () => {
  it("publishes to a local daemon that keeps insights, and never to an older one", () => {
    expect(FEATURE_MIN_VERSION.workspaceInsights).toBe(79);
    expect(publishBlocked(ws(), NEW, {})).toBeNull();
    expect(publishBlocked(ws(), OLD, {})).toContain("79");
  });

  // featureBlockedReason waves an unknown verdict through, which is right
  // for a button and wrong for a request: there is nobody to tell yet.
  it("waits for a verdict, and skips a workspace with no root", () => {
    expect(publishBlocked(ws(), null, {})).not.toBeNull();
    expect(publishBlocked(ws({ rootPath: undefined }), NEW, {})).not.toBeNull();
    expect(publishBlocked(null, NEW, {})).not.toBeNull();
  });

  it("asks an ssh workspace's HOST daemon, whatever the local one is", () => {
    const remote = ws({ ssh: { host: "box" } });
    const ready = (daemonVersion: number): SshLinks => ({ box: { status: "ready", daemonVersion } });
    expect(publishBlocked(remote, OLD, ready(79))).toBeNull();
    expect(publishBlocked(remote, NEW, ready(78))).toContain("v79");
    expect(publishBlocked(remote, NEW, {})).toContain("Connecting");
    expect(publishBlocked(remote, NEW, { box: { status: "lost" } })).toContain("Not connected");
  });
});

describe("needsPublish", () => {
  it("sends a snapshot the daemon has not been told, and not one it has", () => {
    expect(needsPublish("{\"a\":1}", undefined, undefined, 0)).toBe(true);
    expect(needsPublish("{\"a\":1}", "{\"a\":1}", undefined, 0)).toBe(false);
    expect(needsPublish("{\"a\":2}", "{\"a\":1}", undefined, 0)).toBe(true);
  });

  it("retries a failed snapshot only after the retry interval, and a new one at once", () => {
    const failed = { json: "{\"a\":1}", at: 1_000 };
    expect(needsPublish("{\"a\":1}", undefined, failed, 1_000 + PUBLISH_RETRY_MS - 1)).toBe(false);
    expect(needsPublish("{\"a\":1}", undefined, failed, 1_000 + PUBLISH_RETRY_MS)).toBe(true);
    expect(needsPublish("{\"a\":2}", undefined, failed, 1_001)).toBe(true);
  });
});

describe("absoluteUnder", () => {
  it("joins a walk path onto the root the way the Settings panel does", () => {
    expect(absoluteUnder("/ws/", "")).toBe("/ws");
    expect(absoluteUnder("/ws", "app")).toBe("/ws/app");
  });
});
