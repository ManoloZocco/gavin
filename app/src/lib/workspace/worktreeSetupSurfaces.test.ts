import { describe, expect, it } from "vitest";
import { source } from "$lib/sources";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

// The editor's wiring, read from source: rendered UI is the one thing the
// suites cannot draw, so these pin the strings the panel relies on.

describe("the worktree setup editor", () => {
  const panel = source("WorktreeSetupPanel.svelte");

  it("is gated on the daemon that has the writer", () => {
    expect(FEATURE_MIN_VERSION.worktreeSetupEditor).toBe(80);
    expect(panel).toContain('featureBlockedReason($daemonCompat, "worktreeSetupEditor")');
  });

  it("saves through the human's writer, which decides the trust stamp", () => {
    expect(panel).toContain("saveWorktreeSetup(workspaceId, draftLines)");
    // The panel never stamps trust itself, and never sends the agent's
    // proposal form.
    expect(panel).not.toContain("approveWorkspaceConfig");
    expect(panel).not.toContain("setWorktreeSetup(");
    expect(source("layoutState.ts")).toContain("backend.setWorktreeSetup(ws.rootPath, lines, false)");
  });

  it("offers the proposal as editor text, and the TOML block only without a writer", () => {
    expect(panel).toContain("proposalText(proposal.lines)");
    expect(panel).toContain("Use proposal");
    expect(panel).toMatch(/offerCopy = \$derived\(\s*editBlocked !== null/);
  });

  it("keeps the trust notice above the editor", () => {
    expect(panel.indexOf("<ConfigTrustNotice")).toBeGreaterThan(-1);
    expect(panel.indexOf("<ConfigTrustNotice")).toBeLessThan(panel.indexOf("<textarea"));
  });
});
