import { describe, expect, it } from "vitest";
import { svelteSources } from "$lib/sources";

// The effective-config view is drawn on two surfaces that share nothing
// but the pure module: the card detail modal's "Runs on" line and the
// Agents settings' note under an empty complexity table. A line wired to
// nothing renders as nothing, which no other suite notices. Reads the
// sources rather than the DOM, following cardAgentSurfaces.test.ts.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("effective config surfaces", () => {
  it("draws the Runs on line in the card detail, for task cards, through the pure module", () => {
    const detail = source("CardDetailModal.svelte");
    expect(detail).toContain('from "$lib/agents/effectiveConfig"');
    expect(detail).toContain("$effectiveConfigInputs(workspaceId)");
    expect(detail).toMatch(/card\.kind === "task" \? effectiveRunForCard\(/);
    expect(detail).toContain("{runsOnLine(runsOn)}");
    expect(detail).toContain("title={runsOnBreakdown(runsOn)}");
  });

  it("notes an empty complexity table in the Agents settings", () => {
    const panel = source("AgentPrimaryPanel.svelte");
    expect(panel).toContain("emptyComplexityNote(view.table, label)");
    expect(panel).toContain('<p class="hint">{emptyTableNote}</p>');
  });
});
